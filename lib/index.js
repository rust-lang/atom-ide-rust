const cp = require("child_process")
const os = require("os")
const path = require("path")
const { CompositeDisposable, Disposable } = require("atom")
const { AutoLanguageClient } = require("atom-languageclient")
const RustProject = require("./rust-project.js")
const {
  fetchLatestDist,
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

function clearIdeRustNotifications(prefix = 'ide-rust') {
  for (const note of atom.notifications.getNotifications()) {
    if (note.getOptions()._src && note.getOptions()._src.startsWith(prefix)) {
      note.dismiss()
    }
  }
}

function atomPrompt(message, options, buttons) {
  clearIdeRustNotifications()

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
  return "stable"
}

function rustupRun(toolchain, command, opts={}) {
  return toolchain && exec(`rustup run ${toolchain} ${command}`, opts) || exec(`${command}`, opts)
}

function notifyLanguageServerCommandFailed(languageServerCmd) {
  clearIdeRustNotifications("ide-rust.langServerCommand")
  let description = "Make sure the **rust-analyzer** binary is installed  and in `$PATH`."
    + "\n\nSee https://rust-analyzer.github.io/manual.html#rust-analyzer-language-server-binary."

  atom.notifications.addError(`Could not run \`${languageServerCmd}\``, {
    description,
    dismissable: true,
    _src: "ide-rust.langServerCommand"
  })
}

async function rustupDefaultToolchain() {
  // linux: "stable-x86_64-unknown-linux-gnu (default)"
  // mac: "stable (default)"
  let { stdout } = await exec("rustup default")
  return stdout.split("-")[0].trim().split(" ")[0]
}

async function hasCommand(rustCommand) {
  try {
    await exec(`${rustCommand} --version`)
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

/** @return {string} command to start the language server */
function langServerCommand() {
  return atom.config.get('ide-rust.languageServerCommand') || "rust-analyzer"
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

/** @return {string} environment variable path */
let envPath = () => {
  // Make sure the cargo directory is in PATH
  let envPath = process.env.PATH || ''
  if (!envPath.includes(".cargo/bin"))
    envPath += `:${path.join(os.homedir(), ".cargo/bin")}`
  return envPath
}

/**
 * @return {Promise<object>} environment vars
 */
function serverEnv() {
  const env = process.env
  env.PATH = envPath()
  env.RUST_BACKTRACE = env.RUST_BACKTRACE || "1"

  // if (!env.RUST_LOG && atom.config.get('core.debugLSP')) {
  //   env.RUST_LOG = 'info'
  // }

  return env
}

/**
 * Adds a listener on stdout to warn of non-LSP looking lines (potentially from wayward
 * server-side printing). Non-LSP stdout usage will break vscode-jsonrpc.
 * @param {ChildProcess} process language server
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
      .forEach(line => console.error("Rust LS suspicious stdout:", line))
  })
  return process
}

class RustLanguageClient extends AutoLanguageClient {
  constructor() {
    super()
    /** (projectPath -> RustProject) mappings */
    this.projects = {}
    this.activeOverrides = new Set()
    this.disposables = new CompositeDisposable()

    // remove legacy configs
    atom.config.unset("ide-rust.rlsToolchain")
    atom.config.unset("ide-rust.rlsDefaultConfig")
    atom.config.unset("ide-rust.rlsCommandOverride")

    /** Configuration schema */
    this.config = {
      languageServerCommand: {
        description: 'Command that runs rust-analyzer. By default it should in PATH.',
        type: 'string',
        default: 'rust-analyzer',
        order: 1
      },
      checkForToolchainUpdates: {
        description: 'Check on startup & periodically for rustup toolchain updates, prompting to install if available.',
        type: 'boolean',
        default: true,
        order: 2
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

        atom.notifications.addInfo(`Rust \`${toolchain}\` toolchain update available`, {
          description: newVersion,
          _src: 'ide-rust',
          dismissable: true,
          buttons: [{
            text: dated ? 'Update & Switch' : 'Update',
            onDidClick: () => {
              clearIdeRustNotifications()

              const updatePromise = exec(`rustup update ${toolchain}`)
                .then(() => this._checkToolchain())
                .then(() => this._restartLanguageServers(`Updated rust toolchain`))
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
   * Checks for rustup & toolchain components
   * If not found prompts to fix & throws error
   * @param {string} [cwd]
   */
  async _checkToolchain(cwd) {
    const toolchain = configToolchain()

    try {
      await rustupRun(toolchain, "rustc --version", { cwd })
      clearIdeRustNotifications()
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
    } else {
      let clicked = await atomPrompt(`\`rustup\` missing ${toolchain} toolchain`, {
        detail: `rustup toolchain install ${toolchain}`,
      }, ['Install'])

      if (clicked === 'Install') {
        clearIdeRustNotifications()
        const installPromise = installCompiler()
          .then(() => this._checkToolchain())
          .then(() => this._restartLanguageServers(`Installed rust toolchain`))
          .catch(e => {
            console.warn(e)
            clearIdeRustNotifications()
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

  async activate() {
    super.activate()

    // Get required dependencies
    await (require("atom-package-deps").install("ide-rust"))

    // // Watch rls.toml file changes -> update rls
    // this.disposables.add(atom.project.onDidChangeFiles(events => {
    //   if (_.isEmpty(this.projects)) return
    //
    //   for (const event of events) {
    //     if (event.path.endsWith('rls.toml')) {
    //       let projectPath = Object.keys(this.projects).find(key => event.path.startsWith(key))
    //       let rlsProject = projectPath && this.projects[projectPath]
    //       if (rlsProject) rlsProject.sendRlsTomlConfig()
    //     }
    //   }
    // }))

    // watch config toolchain updates -> check for updates if enabling
    this.disposables.add(atom.config.onDidChange('ide-rust.checkForToolchainUpdates',
      ({ newValue: enabled }) => {
        if (enabled) this._promptToUpdateToolchain().catch(logErr)
      }
    ))

    // watch languageServerCommand -> restart servers
    this.disposables.add(atom.config.onDidChange('ide-rust.languageServerCommand',
      () => this._restartLanguageServers()
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
    let project = new RustProject(server, () => this.busySignalService)
    this.projects[server.projectPath] = project

    server.process.on('exit', () => {
      delete this.projects[server.projectPath]
      this._refreshActiveOverrides()
    })

    // project.sendRlsTomlConfig()

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
      !filePath.includes('/target/debug/') &&
      !filePath.includes('/target/doc/') &&
      !filePath.includes('/target/release/')
  }

  // Kill servers fast (#196)
  shutdownGracefully = false

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

    const languageServerCmd = langServerCommand()

    if (!(await hasCommand(languageServerCmd))) {
      notifyLanguageServerCommandFailed(languageServerCmd)
      return
    }
    clearIdeRustNotifications("ide-rust.langServerCommand")

    return logSuspiciousStdout(cp.spawn(languageServerCmd, {
      env: serverEnv(),
      shell: true,
      cwd: projectPath
    }))
  }

  // Extends the outline provider by filtering the type variable, which is
  // only used for local variables by the language server. This makes the
  // outline view cleaner and more useful.
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

  /**
   * Hide unsupported rust-analyzer custom actions
   * @param {(ls.Command | ls.CodeAction)[]} actions
   * @returns {(ls.Command | ls.CodeAction)[]} filtered actions
   */
  filterCodeActions(actions) {
    return actions.filter(a => !a.command || a.command.command !== "rust-analyzer.applySourceChange")
  }

  // /**
  //  * TODO: Handle rust-analyzer custom actions
  //  * @param {(ls.Command | ls.CodeAction)} action
  //  * @returns {Promise<boolean>} continue with default handling
  //  */
  // async onApplyCodeActions(action) {
  //   return true
  // }

  /**
   * Extend base-class to workaround the limited markdown support.
   * @param {TextEditor} editor
   * @param {Point} point
   * @returns {Promise<atomIde.Datatip | null>}
   */
  async getDatatip(editor, ...args) {
    let datatip = await super.getDatatip(editor, ...args)
    try {
      if (datatip) {
        datatip.markedStrings = datatip.markedStrings
          .flatMap(m => {
            if (!m.grammar && m.type === "markdown" && m.value) {
              return convertMarkdownToSnippets(m.value)
            } else {
              return m
            }
          })
          .filter(m => m.value)
      }
    } catch (e) {
      console.error("Error processing datatip", e)
    }
    return datatip
  }
}

/**
 * Convert "foo\n```rust\nHashSet<u32, String>\n```\nbar"
 * to [{type: "markdown", value: "foo"}, {type:"snippet", value: "HashSet<u32, String>", ...}, ...]
 * @param {string} value
 * @returns {object[]}
 */
function convertMarkdownToSnippets(value) {
  // even indices are text, odds are rust snippets
  return value.split(/\s*```rust\s*((?:.|\s)+?)\s*```/)
    .map((bit, index) => {
      if (index % 2 == 0) {
        return {
          type: "markdown",
          value: bit,
        }
      } else {
        return {
          type: "snippet",
          grammar: atom.grammars.grammarForScopeName("source.rust"),
          value: bit,
        }
      }
    })
}

// override windows specific implementations
if (process.platform === "win32") {
  // handle different slashes
  // TODO ignore all files and wait for `client/registerCapability` as
  // in unix method
  RustLanguageClient.prototype.filterChangeWatchedFiles = filePath => {
    return !filePath.includes('\\.git\\') &&
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
