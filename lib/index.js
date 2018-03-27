const cp = require("child_process")
const os = require("os")
const path = require("path")
const _ = require('underscore-plus')
const { CompositeDisposable, Disposable } = require('atom')
const { AutoLanguageClient } = require("atom-languageclient")
const RlsProject = require('./rls-project.js')
const {
  fetchLatestDist,
  checkHasRls,
  suggestChannelOrDated,
  DATED_REGEX,
} = require('./dist-fetch')

/** @type {number} interval between toolchain update checks, milliseconds */
const PERIODIC_UPDATE_CHECK_MILLIS = 6 * 60 * 60 * 1000

function getPath() {
  // Make sure the cargo directory is in PATH
  let { PATH } = process.env
  PATH = PATH + ":" + path.join(os.homedir(), ".cargo/bin")
  return PATH
}

async function exec(command) {
  return new Promise((resolve, reject) => {
    cp.exec(command, { env: { PATH: getPath() } }, (err, stdout, stderr) => {
      if (err != null) {
        reject(err)
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

function logErr(e, logFn = console.warn) {
  const message = e && '' + e
  message && logFn(message)
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

/** @return {?string} developer override of the command to start a Rls instance */
function rlsCommandOverride() {
  return atom.config.get('ide-rust.rlsCommandOverride')
}

// Installs nightly
function installCompiler() {
  return exec(`rustup toolchain install ${configToolchain()}`)
}

/**
 * @param {string} toolchain
 * @return {Promise<string>} `rustc --print sysroot` stdout
 */
async function rustcSysroot(toolchain) {
  let { stdout } = await exec(`rustup run ${toolchain} rustc --print sysroot`)
  return stdout.trim()
}

/**
 * @param {string} [toolchain]
 * @return {Promise<object>} environment vars
 */
async function serverEnv(toolchain) {
  const env = {
    PATH: getPath(),
    RUST_BACKTRACE: '1',
    RUST_LOG: process.env.RUST_LOG,
  }

  if (!env.RUST_LOG && atom.config.get('core.debugLSP')) {
    env.RUST_LOG = 'rls=warn'
  }

  if (toolchain) {
    try {
      let sysroot = await rustcSysroot(toolchain)
      env.RUST_SRC_PATH = path.join(sysroot, "/lib/rustlib/src/rust/src/")
    }
    catch (e) {
      console.warn("Failed to find sysroot: " + e)
    }
  }
  return env
}

/**
 * Install rls-preview, rust-src, rust-analysis
 * @param {string} toolchain
 */
async function installRlsComponents(toolchain) {
  try {
    await exec(`rustup component add rls-preview --toolchain ${toolchain}`)
  }
  catch (e) {
    let suggestedVersion
    if (toolchain.startsWith('nightly')) {
      // 'rls-preview' not available search for a decent suggestion
      suggestedVersion = await suggestChannelOrDated('nightly').catch(e => console.warn(e))
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
    if (suggestedVersion) {
      note.buttons.push({
        text: `Use ${suggestedVersion}`,
        onDidClick: () => atom.config.set('ide-rust.rlsToolchain', suggestedVersion)
      })
    }
    atom.notifications.addError(`\`rls-preview\` was not found on \`${toolchain}\``, note)
    throw e
  }

  try {
    await exec(`rustup component add rust-src --toolchain ${toolchain}`)
    await exec(`rustup component add rust-analysis --toolchain ${toolchain}`)
  }
  catch (e) {
    atom.notifications.addError(`\`rust-src\`/\`rust-analysis\` not found on \`${toolchain}\``, {
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
      .filter(l => l.trim() && !l.startsWith("Content-Length:") && !l.includes('"jsonrpc":"2.0"'))
      .forEach(line => console.error("Rust (RLS) suspicious stdout:", line))
  })
  return process
}

// ongoing promise
let _checkingRls

/**
 * Check for and install Rls
 * @param {?BusySignalService} busySignalService
 * @return {Promise<*>} rls installed
 */
async function checkRls(busySignalService) {
  if (_checkingRls) return _checkingRls

  const toolchain = configToolchain()
  _checkingRls = (async () => {
    let { stdout: toolchainList } = await exec(`rustup component list --toolchain ${toolchain}`)
    if (
      toolchainList.search(/^rls-preview.* \((default|installed)\)$/m) >= 0 &&
      toolchainList.search(/^rust-analysis.* \((default|installed)\)$/m) >= 0 &&
      toolchainList.search(/^rust-src.* \((default|installed)\)$/m) >= 0
    ) {
      return // have rls
    }
    // try to install rls
    const installRlsPromise = installRlsComponents(toolchain)
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
  }
  finally {
    _checkingRls = null
  }
}

class RustLanguageClient extends AutoLanguageClient {
  constructor() {
    super()
    /** (projectPath -> RlsProject) mappings */
    this.projects = {}
    this.disposables = new CompositeDisposable()

    /** Configuration schema */
    this.config = {
      rlsToolchain: {
        description: 'Sets the toolchain installed using rustup and used to run the Rls.' +
          ' For example ***beta*** or ***nightly-yyyy-mm-dd***.',
        type: 'string',
        default: 'nightly',
        order: 1
      },
      checkForToolchainUpdates: {
        description: 'Check on startup & periodically for toolchain updates, prompting to install if available',
        type: 'boolean',
        default: true,
        order: 2
      },
      rlsDefaultConfig: {
        title: "Rls Configuration",
        description: 'Configuration default sent to all Rls instances, overridden by project rls.toml configuration',
        type: 'object',
        collapsed: false,
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
            description: 'Controls eagerness of clippy diagnostics. `Opt-in` requires each crate specifying `#![warn(clippy)]. Note clippy is only available on Rls releases that have it enabled at compile time.',
            type: "string",
            default: "Rls Default",
            order: 2,
            enum: ["On", "Opt-in", "Off", "Rls Default"]
          }
        }
      }
    }
  }

  /** @param {?string} reason Reason for the restart shown in the notification */
  async _restartLanguageServers(reason) {
    await this.restartAllServers()
    if (reason) atom.notifications.addSuccess(reason, { _src: 'ide-rust' })
  }

  // check for toolchain updates if installed & not dated
  async _promptToUpdateToolchain() {
    if (!atom.config.get('ide-rust.checkForToolchainUpdates')) return

    const confToolchain = configToolchain()
    const dated = confToolchain.match(DATED_REGEX)
    const toolchain = (dated ? dated[1] : confToolchain)

    let { stdout: currentVersion } = await exec(`rustup run ${confToolchain} rustc --version`)
    let newVersion = await fetchLatestDist({ toolchain, currentVersion }).catch(() => false)
    if (!newVersion) return

    atom.notifications.addInfo(`Rls \`${toolchain}\` toolchain update available`, {
      description: newVersion,
      _src: 'ide-rust',
      dismissable: true,
      buttons: [{
        text: confToolchain === toolchain ? 'Update' : 'Update & Switch',
        onDidClick: () => {
          clearIdeRustInfos()

          const updatePromise = exec(`rustup update ${toolchain}`)
            // set config in case going from dated -> latest
            .then(() => atom.config.set('ide-rust.rlsToolchain', toolchain))
            .then(() => this._checkToolchain())
            .then(() => checkRls())
            .then(() => this._restartLanguageServers(`Updated Rls toolchain`))
            .catch(logErr)

          if (this.busySignalService) {
            this.busySignalService.reportBusyWhile(
              `Updating rust \`${toolchain}\` toolchain`,
              () => updatePromise
            )
          }
        }
      }]
    })
  }

  /**
   * Checks for rustup, toolchain & rls components
   * If not found prompts to fix & throws error
   */
  async _checkToolchain() {
    const toolchain = configToolchain()

    try {
      await exec(`rustup run ${toolchain} rustc --version`)
      clearIdeRustInfos()
    }
    catch (e) {
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
    }
    else if (await checkHasRls(toolchain)) {
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
    }
    else {
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
      description: '**Warning**: This toolchain is unavilable or missing Rls.',
      buttons: [{
        text: 'Configure',
        onDidClick: () => atom.workspace.open('atom://config/packages/ide-rust')
      }],
    }

    if (toolchain === 'nightly') {
      note.description += ' Try using a previous _dated_ nightly.'
    }
    else if (toolchain.startsWith('nightly')) {
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
    }
    catch (e) {
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
    }
    catch (e) {
      e && console.warn(e)
    }
  }

  activate() {
    super.activate()

    // Get required dependencies
    require("atom-package-deps").install("ide-rust", false)

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
      _.debounce(({ newValue }) => {
        return this._checkToolchain()
          .then(() => checkRls(this.busySignalService))
          .then(() => this._restartLanguageServers(`Switched Rls toolchain to \`${newValue}\``))
          .then(() => this._promptToUpdateToolchain())
          .catch(e => logErr(e, console.info))
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
    })

    project.sendRlsTomlConfig()
  }

  getGrammarScopes() {
    return ["source.rust", "rust"]
  }
  getLanguageName() {
    return "Rust"
  }
  getServerName() {
    return "RLS"
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

  async startServerProcess(projectPath) {
    if (!this._periodicUpdateChecking) {
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
      await this._checkToolchain()
      await checkRls(this.busySignalService)
      let toolchain = configToolchain()
      return logSuspiciousStdout(cp.spawn("rustup", ["run", toolchain, "rls"], {
        env: await serverEnv(toolchain),
        cwd: projectPath
      }))
    }
    catch (e) {
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
}

module.exports = new RustLanguageClient()
