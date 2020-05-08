const cp = require("child_process")
const os = require("os")
const path = require("path")
const _ = require("underscore-plus")
const { CompositeDisposable, Disposable } = require("atom")
const { AutoLanguageClient } = require("atom-languageclient")
const RlsProject = require("./rls-project.js")
const {
  fetchLatestDist,
  checkHasRls,
  suggestChannelOrDated,
  DATED_REGEX,
} = require("./dist-fetch")
const { showConflictingPackageWarnings } = require("./competition.js")

/** @type {number} interval between toolchain update checks, milliseconds */
const PERIODIC_UPDATE_CHECK_MILLIS = 6 * 60 * 60 * 1000

async function exec(command, { cwd }={}) {
  return new Promise((resolve, reject) => {
    const env = process.env
    env.PATH = envPath()
    cp.exec(command, { env, cwd }, (err, stdout, stderr) => {
      if (err != null) {
        reject(err)
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

function logErr(e, logFn = console.warn) {
  e && logFn('' + e)
}

function clearIdeRustInfos() {
  for (const note of atom.notifications.getNotifications()) {
    if (note.getOptions()._src === 'ide-rust') {
      note.dismiss()
    }
  }
}

function atomPrompt(message, options, buttons) {
  clearIdeRustInfos()

  return new Promise(resolve => {
    const notification = atom.notifications.addInfo(
      message,
      Object.assign({
          dismissable: true,
          _src: 'ide-rust',
          buttons: (buttons || []).map(button => ({
            text: button,
            onDidClick: () => {
              resolve(button)
              notification.dismiss()
            }
          }))
        },
        options
      )
    )

    notification.onDidDismiss(() => resolve(null))
  })
}

// Installs rustup
function installRustup() {
  return exec("curl https://sh.rustup.rs -sSf | sh -s -- -y")
}

function configToolchain() {
  return atom.config.get('ide-rust.rlsToolchain')
}

function rustupRun(toolchain, command, opts={}) {
  return toolchain && exec(`rustup run ${toolchain} ${command}`, opts) || exec(`${command}`, opts)
}

async function rustupDefaultToolchain() {
  // linux: "stable-x86_64-unknown-linux-gnu (default)"
  // mac: "stable (default)"
  let { stdout } = await exec("rustup default")
  return stdout.split("-")[0].trim().split(" ")[0]
}

async function hasCommand(rustCommand) {
  try {
    await exec(`${rustCommand} -V`)
    return true
  } catch (e) {
    return false
  }
}

/** @return {Array<{ path: string, toolchain: String }>} */
async function rustupOverrides() {
  let { stdout } = await exec("rustup override list")
  return stdout.split(/[\r\n]+/g)
    .map(line => {
      // line.trimEnd is not a function ?
      let lastSpace = line.trimEnd().lastIndexOf(' ')
      return {
        path: line.slice(0, lastSpace).trim(),
        toolchain: line.slice(lastSpace).trim()
      }
    })
    .filter(({ path, toolchain }) => path && toolchain && path !== 'no')
}

/** @return {?string} developer override of the command to start a Rls instance */
function rlsCommandOverride() {
  return atom.config.get('ide-rust.rlsCommandOverride')
}

// Installs nightly
function installCompiler() {
  return exec(`rustup toolchain install ${configToolchain()}`)
}

/**
 * @param {string} projectPath
 * @return {bool} the project path has been explicitly disabled
 */
function shouldIgnoreProjectPath(projectPath) {
  const ignoredPaths = atom.config.get('ide-rust.ignoredProjectPaths')
  return ignoredPaths && ignoredPaths.split(',')
    .map(path => path.trim().replace(/[/\\]*$/, ''))
    .some(path => path === projectPath.trim().replace(/[/\\]*$/, ''))
}

/**
 * @param {string} [toolchain]
 * @param {string} [cwd]
 * @return {Promise<string>} `rustc --print sysroot` stdout
 */
async function rustcSysroot(toolchain, cwd) {
  try {
    let { stdout } = await rustupRun(toolchain, "rustc --print sysroot", { cwd })
    return stdout.trim()
  } catch (e) {
    // make an attempt to use system rustc
    try {
      let { stdout } = await exec(`rustc --print sysroot`, { cwd })
      return stdout.trim()
    } catch (sys_e) {
      throw e
    }
  }
}

/** @return {string} environment variable path */
let envPath = () => {
  // Make sure the cargo directory is in PATH
  let envPath = process.env.PATH || ''
  if (!envPath.includes(".cargo/bin"))
    envPath += `:${path.join(os.homedir(), ".cargo/bin")}`
  return envPath
}

/**
 * @param {string} [toolchain]
 * @param {string} [cwd]
 * @return {Promise<object>} environment vars
 */
async function serverEnv(toolchain, cwd) {
  const env = process.env
  env.PATH = envPath()
  env.RUST_BACKTRACE = env.RUST_BACKTRACE || "1"

  if (!env.RUST_LOG && atom.config.get('core.debugLSP')) {
    env.RUST_LOG = 'rls=warn,rls::build=info'
  }

  try {
    let sysroot = await rustcSysroot(toolchain, cwd)
    env.RUST_SRC_PATH = path.join(sysroot, "/lib/rustlib/src/rust/src/")
  } catch (e) {
    console.warn("Failed to find sysroot: " + e)
  }
  return env
}

/**
 * Install rls-preview, rust-src, rust-analysis
 * @param {string} toolchain
 * @param {string} [cwd]
 */
async function installRlsComponents(toolchain, cwd) {
  const toolchainArg = toolchain && `--toolchain ${toolchain}` || ''
  try {
    await exec(`rustup component add rls-preview ${toolchainArg}`, { cwd })
  } catch (e) {

    let suggestedVersion
    let usingRustupOverride = false

    if (!toolchain) {
      // check if using a rustup override
      let override = (await rustupOverrides()).find(({ path }) => cwd.startsWith(path))
      if (override) {
        toolchain = override.toolchain
        usingRustupOverride = true
      }
    }

    if (toolchain.startsWith('nightly')) {
      // 'rls' not available search for a decent suggestion
      suggestedVersion = await suggestChannelOrDated('nightly').catch(logErr)
    }

    const note = {
      detail: 'Try configuring another toolchain, like a dated nightly or `beta`',
      dismissable: true,
      _src: 'ide-rust',
      buttons: [{
        text: 'Configure',
        onDidClick: () => atom.workspace.open('atom://config/packages/ide-rust')
      }]
    }
    if (suggestedVersion && !usingRustupOverride) {
      note.buttons.push({
        text: `Use ${suggestedVersion}`,
        onDidClick: () => atom.config.set('ide-rust.rlsToolchain', suggestedVersion)
      })
    }

    if (usingRustupOverride) {
      note.detail = "Try removing your rustup override or reconfiguring to a dated nightly or `beta`"
      if (suggestedVersion)
        note.detail = note.detail.replace("a dated nightly", `\`${suggestedVersion}\``)
      atom.notifications
        .addError(`\`rls\` was not found on rustup override \`${toolchain}\``, note)
    } else {
      atom.notifications
        .addError(`\`rls\` was not found on \`${toolchain || 'the default toolchain'}\``, note)
    }

    throw e
  }

  try {
    await exec(`rustup component add rust-src ${toolchainArg}`, { cwd })
    await exec(`rustup component add rust-analysis ${toolchainArg}`, { cwd })
  } catch (e) {
    atom.notifications
      .addError(`\`rust-src\`/\`rust-analysis\` not found on \`${toolchain || 'the default toolchain'}\``, {
        dismissable: true
      })
    throw e
  }
}

/**
 * Adds a listener on stdout to warn of non-LSP looking lines (potentially from wayward
 * server-side printing). Non-LSP stdout usage will break vscode-jsonrpc.
 * @param {ChildProcess} process Rls
 * @return {ChildProcess}
 */
function logSuspiciousStdout(process) {
  process.stdout.on('data', chunk => {
    chunk.toString('utf8')
      .split('\n')
      .filter(l => l.trim() &&
        l.length < 10000 && // ignore long chunks, these are much more likely to be false positives
        !l.startsWith("Content-Length:") &&
        !l.includes('"jsonrpc":"2.0"'))
      .forEach(line => console.error("Rust (RLS) suspicious stdout:", line))
  })
  return process
}

// ongoing promise
let _checkingRls

/**
 * Check for and install Rls
 * @param {?BusySignalService} busySignalService
 * @param {string} [cwd]
 * @return {Promise<*>} rls installed
 */
async function checkRls(busySignalService, cwd) {
  if (_checkingRls) return _checkingRls

  const toolchain = configToolchain()
  const toolchainArg = toolchain && `--toolchain ${toolchain}` || ""

  _checkingRls = (async () => {
    if (!await hasCommand("rustup")) {
      if (await hasCommand("rls")) {
        return // have system rls without rustup
      } else {
        throw new Error("rls & rustup missing")
      }
    }

    let { stdout: toolchainList } = await exec(`rustup component list ${toolchainArg}`, { cwd })
    if (
      toolchainList.search(/^rls.* \((default|installed)\)$/m) >= 0 &&
      toolchainList.search(/^rust-analysis.* \((default|installed)\)$/m) >= 0 &&
      toolchainList.search(/^rust-src.* \((default|installed)\)$/m) >= 0
    ) {
      return // have rls
    }
    // try to install rls
    const installRlsPromise = installRlsComponents(toolchain, cwd)
    if (busySignalService) {
      busySignalService.reportBusyWhile(
        `Adding components rls-preview, rust-src, rust-analysis`,
        () => installRlsPromise
      )
    }

    return installRlsPromise
  })()

  try {
    return await _checkingRls
  } finally {
    _checkingRls = null  // eslint-disable-line
  }
}

class RustLanguageClient extends AutoLanguageClient {
  constructor() {
    super()
    /** (projectPath -> RlsProject) mappings */
    this.projects = {}
    this.activeOverrides = new Set()
    this.disposables = new CompositeDisposable()

    /** Configuration schema */
    this.config = {
      rlsToolchain: {
        description: 'Sets the toolchain installed using rustup and used to run the Rls.' +
          ' When blank will use the rustup/system default.' +
          ' For example ***nightly***, ***stable***, ***beta***, or ***nightly-yyyy-mm-dd***.',
        type: 'string',
        default: '',
        order: 1
      },
      checkForToolchainUpdates: {
        description: 'Check on startup & periodically for rustup toolchain updates, prompting to install if available.',
        type: 'boolean',
        default: true,
        order: 2
      },
      rlsDefaultConfig: {
        title: "Rls Configuration",
        description: 'Configuration default sent to all Rls instances, overridden by project rls.toml configuration',
        type: 'object',
        collapsed: false,
        order: 3,
        properties: {
          allTargets: {
            title: "Check All Targets",
            description: 'Checks tests, examples & benches. Equivalent to `cargo check --all-targets`',
            type: 'string',
            default: "Rls Default",
            order: 1,
            enum: ["On", "Off", "Rls Default"]
          },
          clippyPreference: {
            title: "Clippy Preference",
            description: 'Controls eagerness of clippy diagnostics. **Opt-in** requires each crate specifying `#![warn(clippy)]`. Note clippy is only available on Rls releases that have it enabled at compile time.',
            type: "string",
            default: "Rls Default",
            order: 2,
            enum: ["On", "Opt-in", "Off", "Rls Default"]
          }
        }
      },
      ignoredProjectPaths: {
        description: 'Disables ide-rust functionality on a comma-separated list of project paths.',
        type: 'string',
        default: '',
        order: 999
      }
    }
  }

  async _refreshActiveOverrides() {
    try {
      const overrides = (await rustupOverrides())
        .filter(({ path }) => Object.keys(this.projects).some(project => project.startsWith(path)))
        .map(override => override.toolchain)
      const oldActive = this.activeOverrides
      this.activeOverrides = new Set(overrides)
      if (this.activeOverrides.size > oldActive.size) {
        const confToolchain = configToolchain() || await rustupDefaultToolchain()
        if (confToolchain) oldActive.add(confToolchain)
        this._promptToUpdateToolchain({ ignore: oldActive })
      }
    } catch (e) {
      if (await hasCommand("rustup")) logErr(e)
    }
  }

  /** @param {?string} reason Reason for the restart shown in the notification */
  async _restartLanguageServers(reason) {
    await this.restartAllServers()
    if (reason) atom.notifications.addSuccess(reason, { _src: 'ide-rust' })
  }

  // check for toolchain updates if installed & not dated
  async _promptToUpdateToolchain({ ignore } = {}) {
    if (!atom.config.get('ide-rust.checkForToolchainUpdates')) return

    if (!await hasCommand("rustup")) {
      atom.config.set('ide-rust.checkForToolchainUpdates', false)
      this._handleMissingRustup()
      return
    }

    const toolchains = new Set(this.activeOverrides)

    const confToolchain = configToolchain() || await rustupDefaultToolchain()
    if (confToolchain) toolchains.add(confToolchain)

    Array.from(toolchains)
      .filter(toolchain => !ignore || !ignore.has(toolchain))
      .forEach(async confToolchain => {
        const dated = confToolchain.match(DATED_REGEX)
        let toolchain = (dated ? dated[1] : confToolchain)
        if (!dated && toolchain.includes('-')) {
          toolchain = toolchain.split('-')[0]
        }

        let { stdout: currentVersion } = await rustupRun(confToolchain, "rustc --version")
        let newVersion = await fetchLatestDist({ toolchain, currentVersion }).catch(() => false)
        if (!newVersion) return

        atom.notifications.addInfo(`Rls \`${toolchain}\` toolchain update available`, {
          description: newVersion,
          _src: 'ide-rust',
          dismissable: true,
          buttons: [{
            text: dated ? 'Update & Switch' : 'Update' ,
            onDidClick: () => {
              clearIdeRustInfos()

              const updatePromise = exec(`rustup update ${toolchain}`)
              // set config in case going from dated -> latest
              .then(() => dated && atom.config.set('ide-rust.rlsToolchain', toolchain))
              .then(() => this._checkToolchain())
              .then(() => checkRls())
              .then(() => this._restartLanguageServers(`Updated Rls toolchain`))
              .catch(e => {
                logErr(e)
                e && atom.notifications.addError(`\`rustup update ${toolchain}\` failed`, {
                  detail: e,
                  dismissable: true,
                })
              })

              if (this.busySignalService) {
                this.busySignalService.reportBusyWhile(
                  `Updating rust \`${toolchain}\` toolchain`,
                  () => updatePromise
                )
              }
            }
          }]
        })
      })

  }

  /**
   * Checks for rustup, toolchain & rls components
   * If not found prompts to fix & throws error
   * @param {string} [cwd]
   */
  async _checkToolchain(cwd) {
    const toolchain = configToolchain()

    try {
      await rustupRun(toolchain, "rustc --version", { cwd })
      clearIdeRustInfos()
    } catch (e) {
      this._handleMissingToolchain(toolchain)
      throw e
    }
  }

  /**
   * Takes appropriate action when missing a toolchain
   * @param {string} toolchain
   */
  async _handleMissingToolchain(toolchain) {
    if (!await exec('rustup --version').catch(() => false)) {
      this._handleMissingRustup()
    } else if (await checkHasRls(toolchain)) {
      let clicked = await atomPrompt(`\`rustup\` missing ${toolchain} toolchain`, {
        detail: `rustup toolchain install ${toolchain}`,
      }, ['Install'])

      if (clicked === 'Install') {
        clearIdeRustInfos()
        const installPromise = installCompiler()
          .then(() => this._checkToolchain())
          .then(() => this._restartLanguageServers(`Installed Rls toolchain`))
          .catch(e => {
            console.warn(e)
            clearIdeRustInfos()
            let err = (e + '').split('\n')
            err = err.length && err[0] || `Error installing rust  \`${toolchain}\``
            atom.notifications.addError(err, {
              detail: 'Check the toolchain is valid & connection is available',
              dismissable: true
            })
          })

        if (this.busySignalService) {
          this.busySignalService.reportBusyWhile(
            `Installing rust \`${toolchain}\``,
            () => installPromise
          )
        }
      }
    } else {
      this._handleMissingToolchainMissingRls(toolchain)
    }
  }

  /**
   * Takes appropriate action when missing a toolchain that itself is missing
   * or missing vital components
   * @param {string} toolchain
   */
  async _handleMissingToolchainMissingRls(toolchain) {
    const note = {
      description: '**Warning**: This toolchain is unavailable or missing RLS.',
      buttons: [{
        text: 'Configure',
        onDidClick: () => atom.workspace.open('atom://config/packages/ide-rust')
      }],
    }

    if (toolchain === 'nightly') {
      note.description += ' Try using a previous _dated_ nightly.'
    } else if (toolchain.startsWith('nightly')) {
      note.description += ' Try using another nightly version.'
    }

    let suggestChannel = toolchain.startsWith('beta') && 'beta' ||
      toolchain.startsWith('stable') && 'stable' ||
      'nightly'

    try {
      let suggestedVersion = await suggestChannelOrDated(suggestChannel)
      if (suggestedVersion) {
        note.buttons.push({
          text: `Use ${suggestedVersion}`,
          className: 'btn-success',
          onDidClick: () => {
            clearIdeRustInfos()
            atom.config.set('ide-rust.rlsToolchain', suggestedVersion)
          }
        })
      }
    } catch (e) {
      console.warn(e)
    }

    atomPrompt(`\`rustup\` missing ${toolchain} toolchain`, note)
  }

  /** Takes appropriate action when missing rustup */
  async _handleMissingRustup() {
    try {
      let description = "Installs from https://www.rustup.rs"
      if (process.platform === 'linux')
        description += ", alternatively install rustup with _`apt install rustup`_ or similar and restart."

      let clicked = await atomPrompt("`rustup` is not available", {
        description,
        detail: "curl https://sh.rustup.rs -sSf | sh"
      }, ["Install"])

      if (clicked === "Install") {
        // Install rustup and try again
        let installRustupPromise = installRustup()
        if (this.busySignalService) {
          this.busySignalService.reportBusyWhile(
            `Installing rustup`,
            () => installRustupPromise
          )
        }
        await installRustupPromise
        await this._checkToolchain()
          .then(() => this._restartLanguageServers())
          .catch(logErr)
      }
    } catch (e) {
      e && console.warn(e)
    }
  }

  activate() {
    super.activate()

    // Get required dependencies
    require("atom-package-deps").install("ide-rust")

    // Watch rls.toml file changes -> update rls
    this.disposables.add(atom.project.onDidChangeFiles(events => {
      if (_.isEmpty(this.projects)) return

      for (const event of events) {
        if (event.path.endsWith('rls.toml')) {
          let projectPath = Object.keys(this.projects).find(key => event.path.startsWith(key))
          let rlsProject = projectPath && this.projects[projectPath]
          if (rlsProject) rlsProject.sendRlsTomlConfig()
        }
      }
    }))

    // Watch config toolchain changes -> switch, install & update toolchains, restart servers
    this.disposables.add(atom.config.onDidChange('ide-rust.rlsToolchain',
      _.debounce(async ({ newValue }) => {
        if (rlsCommandOverride()) {
          // don't bother checking toolchain if an override is being used
          return
        }

        try {
          await this._checkToolchain()
          await checkRls(this.busySignalService)
          let toolchainText = newValue && `\`${newValue}\``
          if (!toolchainText) {
            try {
              toolchainText = `default (\`${await rustupDefaultToolchain()}\`)`
            } catch (e) {
              toolchainText = "default"
            }
          }
          await this._restartLanguageServers(`Switched Rls toolchain to ${toolchainText}`)
          return this._promptToUpdateToolchain()
        } catch (e) {
          return logErr(e, console.info)
        }
      }, 1000)
    ))

    // watch config toolchain updates -> check for updates if enabling
    this.disposables.add(atom.config.onDidChange('ide-rust.checkForToolchainUpdates',
      ({ newValue: enabled }) => {
        if (enabled) this._promptToUpdateToolchain().catch(logErr)
      }
    ))

    // restart running servers if default config changes
    this.disposables.add(atom.config.onDidChange('ide-rust.rlsDefaultConfig',
      () => this._restartLanguageServers().catch(logErr)
    ))

    this.disposables.add(atom.commands.add(
      'atom-workspace',
      'ide-rust:restart-all-language-servers',
      () => this._restartLanguageServers('Rust language servers restarted')
    ))
  }

  deactivate() {
    this.disposables.dispose()
    return super.deactivate()
  }

  getInitializeParams(projectPath, childProcess) {
    const params = super.getInitializeParams(projectPath, childProcess) || {}
    params.initializationOptions = params.initializationOptions || {}
    // Don't build straight after initialize, wait for first `workspace/didChangeConfiguration`
    params.initializationOptions.omitInitBuild = true
    return params
  }

  postInitialization(server) {
    // track the server so we can keep its config updated
    let project = new RlsProject(server, () => this.busySignalService)
    this.projects[server.projectPath] = project

    server.process.on('exit', () => {
      delete this.projects[server.projectPath]
      this._refreshActiveOverrides()
    })

    project.sendRlsTomlConfig()

    this._refreshActiveOverrides()
  }

  getGrammarScopes() {
    return ["source.rust", "rust"]
  }
  getLanguageName() {
    return "Rust"
  }
  getServerName() {
    return "rust-analyzer"
  }

  filterChangeWatchedFiles(filePath) {
    // TODO ignore all files and wait for `client/registerCapability`
    // to inform us of the correct files to watch, until that's implemented
    // these filters take eliminate the brunt of the watch message spam
    return !filePath.includes('/.git/') &&
      !filePath.includes('/target/rls/') &&
      !filePath.includes('/target/debug/') &&
      !filePath.includes('/target/doc/') &&
      !filePath.includes('/target/release/')
  }

  // Rls can run a long time before gracefully shutting down, so it's better to
  // kill servers as the cargo builds should be kill-safe
  shutdownServersGracefully() {
    return false
  }

  serversSupportDefinitionDestinations() {
    return true
  }

  async startServerProcess(projectPath) {
    if (shouldIgnoreProjectPath(projectPath)) {
      console.warn("ide-rust disabled on", projectPath)
      // It's a bit ugly to just return as it causes some upstream error logs
      // But there doesn't seem to be a better option for path disabling at the moment
      return
    }

    if (!this._periodicUpdateChecking && await hasCommand("rustup")) {
      // if haven't started periodic checks for updates yet start now
      let periodicUpdateTimeoutId
      const periodicUpdate = async () => {
        await this._promptToUpdateToolchain().catch(logErr)
        periodicUpdateTimeoutId = setTimeout(periodicUpdate, PERIODIC_UPDATE_CHECK_MILLIS)
      }
      this.disposables.add(new Disposable(() => {
        clearTimeout(periodicUpdateTimeoutId)
        delete this._periodicUpdateChecking
      }))
      this._periodicUpdateChecking = true
      periodicUpdate().catch(logErr)
    }
    if (!this._conflictingPackageChecking) {
      showConflictingPackageWarnings()
      this.disposables.add(atom.packages.onDidActivatePackage(showConflictingPackageWarnings))
      this._conflictingPackageChecking = true
    }

    let cmdOverride = rlsCommandOverride()
    if (cmdOverride) {
      if (!this._warnedAboutRlsCommandOverride) {
        clearIdeRustInfos()
        atom.notifications.addInfo(`Using rls command \`${cmdOverride}\``)
        this._warnedAboutRlsCommandOverride = true
      }
      return logSuspiciousStdout(cp.spawn(cmdOverride, {
        env: await serverEnv(configToolchain()),
        shell: true,
        cwd: projectPath
      }))
    }

    try {
      await this._checkToolchain(projectPath)
      await checkRls(this.busySignalService, projectPath)
      const toolchain = configToolchain()
      const opts = {
        env: await serverEnv(toolchain, projectPath),
        cwd: projectPath
      }
      if (toolchain) {
        return logSuspiciousStdout(cp.spawn("rustup", ["run", toolchain, "rls"], opts))
      } else {
        return logSuspiciousStdout(cp.spawn("rls", opts))
      }
    } catch (e) {
      throw new Error("failed to start server: " + e)
    }
  }

  // Extends the outline provider by filtering the type variable, which is s
  // only used for local variables by RLS. This makes the outline view
  // cleaner and more useful.
  provideOutlines() {
    let provide = super.provideOutlines()
    let superOutline = provide.getOutline

    provide.getOutline = async (...args) => {
      let outline = await superOutline.apply(this, args)
      outline.outlineTrees = outline.outlineTrees
        .filter(o => o.icon !== "type-variable")
      return outline
    }

    return provide
  }

  // Workaround #133 that affects stable rust 1.35.0
  async getCodeFormat(...args) {
    const edits = await super.getCodeFormat(...args)
    for (const edit of edits) {
      const end = edit && edit.oldRange && edit.oldRange.end
      if (end && end.column > 18e18) {
        end.row += 1
        end.column = 0
        edit.newText += (process.platform === "win32" ? "\r\n" : "\n")
      }
    }
    return edits
  }
}

// override windows specific implementations
if (process.platform === "win32") {
  // handle different slashes
  // TODO ignore all files and wait for `client/registerCapability` as
  // in unix method
  RustLanguageClient.prototype.filterChangeWatchedFiles = filePath => {
    return !filePath.includes('\\.git\\') &&
      !filePath.includes('\\target\\rls\\') &&
      !filePath.includes('\\target\\debug\\') &&
      !filePath.includes('\\target\\doc\\') &&
      !filePath.includes('\\target\\release\\')
  }

  // handle different slashes & path separator
  envPath = () => {
    // Make sure the cargo directory is in PATH
    let envPath = process.env.PATH || ''
    if (!envPath.includes(".cargo\\bin"))
      envPath += `;${path.join(os.homedir(), ".cargo", "bin")}`
    return envPath
  }

  // curl | sh is not valid for windows, users must install rustup manually
  RustLanguageClient.prototype._handleMissingRustup = () => {
    atomPrompt("`rustup` is not available", {
      description: "`rustup` is required for ide-rust functionality. " +
        "**Install from https://www.rustup.rs and restart atom**."
    })
  }
}

module.exports = new RustLanguageClient()
