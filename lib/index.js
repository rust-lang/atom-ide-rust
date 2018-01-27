const cp = require("child_process")
const os = require("os")
const path = require("path")
const _ = require('underscore-plus')
const { CompositeDisposable, Disposable } = require('atom')
const { AutoLanguageClient } = require("atom-languageclient")
const RlsProject = require('./rls-project.js')
const {
  fetchLatestDatedNightlyWithRls,
  fetchLatestDist,
  checkHasRls,
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

function exec(command) {
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
      Object.assign(
        {
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
 * @return {string} `rustc --print sysroot` stdout
 */
function rustcSysroot(toolchain) {
  return cp.execSync(`rustup run ${toolchain} rustc --print sysroot`, {
    env: { PATH: getPath() }
  }).toString().trim()
}

/**
 * @param {string} [toolchain]
 * @return {object} environment vars
 */
function serverEnv(toolchain) {
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
      env.RUST_SRC_PATH = path.join(rustcSysroot(toolchain), "/lib/rustlib/src/rust/src/")
    }
    catch (e) {
      console.error("Failed to find sysroot", e)
    }
  }
  return env
}

// ongoing promise
let _checkingRls

/**
 * Check for and install Rls
 * @param {BusySignalService} [busySignalService]
 * @return {Promise<*>} rls installed
 */
function checkRls(busySignalService) {
  let toolchain = configToolchain()

  if (_checkingRls) return _checkingRls

  _checkingRls = exec(`rustup component list --toolchain ${toolchain}`).then(results => {
    const { stdout } = results
    if (
      stdout.search(/^rls-preview.* \((default|installed)\)$/m) >= 0 &&
      stdout.search(/^rust-analysis.* \((default|installed)\)$/m) >= 0 &&
      stdout.search(/^rust-src.* \((default|installed)\)$/m) >= 0
    ) {
      // Have RLS
      return
    }

    // Don't have RLS
    let installRlsPromise = exec(`rustup component add rls-preview --toolchain ${toolchain}`)
      .catch(e => {
        if (toolchain.startsWith('nightly')) {
          // 'rls-preview' not available search for a decent suggestion
          return fetchLatestDatedNightlyWithRls()
            .catch(console.warn)
            .then(version => { throw [e, version] })
        }
        else throw [e]
      })
      .catch(e => {
        let latestRlsNightly = e[1]

        const note = {
          detail: 'Try configuring another toolchain, like a dated nightly or `beta`',
          dismissable: true,
          _src: 'ide-rust',
          buttons: [{
            text: 'Configure',
            onDidClick: () => atom.workspace.open('atom://config/packages/ide-rust')
          }]
        }
        if (latestRlsNightly) {
          note.buttons.push({
            text: `Use ${latestRlsNightly}`,
            onDidClick: () => atom.config.set('ide-rust.rlsToolchain', latestRlsNightly)
          })
        }

        atom.notifications.addError(`\`rls-preview\` was not found on \`${toolchain}\``, note)

        e[0]._logged = true
        throw e[0]
      })
      .then(() => exec(`rustup component add rust-src --toolchain ${toolchain}`))
      .then(() => exec(`rustup component add rust-analysis --toolchain ${toolchain}`))
      .catch(e => {
        if (!e._logged) {
          atom.notifications.addError(`\`rust-src\`/\`rust-analysis\` not found on \`${toolchain}\``, {
            dismissable: true
          })
        }
        throw e
      })

    if (busySignalService) {
      busySignalService.reportBusyWhile(
        `Adding components rls-preview, rust-src, rust-analysis`,
        () => installRlsPromise
      )
    }

    return installRlsPromise
  })

  try {
    return _checkingRls
  }
  finally {
    let clearOngoing = () => _checkingRls = null
    _checkingRls.then(clearOngoing).catch(clearOngoing)
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
        default: 'nightly'
      },
      checkForToolchainUpdates: {
        description: 'Check on startup for toolchain updates, prompting to install if available',
        type: 'boolean',
        default: true
      }
    }
  }

  /** @param {string} reason Reason for the restart shown in the notification */
  _restartLanguageServers(reason) {
    this.restartAllServers().then(() => atom.notifications.addSuccess(reason, { _src: 'ide-rust' }))
  }

  // check for toolchain updates if installed & not dated
  _promptToUpdateToolchain() {
    const confToolchain = configToolchain()

    if (atom.config.get('ide-rust.checkForToolchainUpdates')) {
      const dated = confToolchain.match(DATED_REGEX)
      const toolchain = (dated ? dated[1] : confToolchain)

      exec(`rustup run ${confToolchain} rustc --version`)
        .then(({ stdout }) => fetchLatestDist({ toolchain, currentVersion: stdout }))
        .catch(() => false)
        .then(newVersion => {
          if (newVersion) {
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
                    .catch(e => console.error(e))

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
        })
        .catch(e => console.error(e))
    }
  }

  /**
   * Checks for rustup and nightly toolchain
   * If not found, asks to install. If user declines, throws error
   * @param {BusySignalService} [busySignalService]
   * @return {Promise<*>} toolchain is ok
   */
  _checkToolchain(busySignalService) {
    return new Promise((resolve, reject) => {
      exec(`rustup run ${configToolchain()} rustc --version`)
        .then(resolve)
        .catch(() => checkHasRls(configToolchain()).then(hasRls => {
          // Toolchain not found, prompt to install
          let toolchain = configToolchain()
          const title = `\`rustup\` missing ${toolchain} toolchain`

          if (hasRls) {
            atomPrompt(title, {
              detail: `rustup toolchain install ${toolchain}`,
              buttons: [{
                text: 'Install',
                onDidClick: () => {
                  clearIdeRustInfos()
                  let installPromise = installCompiler()
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

                  if (busySignalService) {
                    busySignalService.reportBusyWhile(
                      `Installing rust \`${toolchain}\``,
                      () => installPromise
                    )
                  }
                }
              }],
            })
          }
          else {
            const note = {
              description: '**Warning**: This toolchain is missing Rls, or is unavilable.',
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

            fetchLatestDatedNightlyWithRls()
              .catch(e => console.warn(e))
              .then(version => {
                if (version) {
                  note.buttons.push({
                    text: `Use ${version}`,
                    className: 'btn-success',
                    onDidClick: () => {
                      clearIdeRustInfos()
                      atom.config.set('ide-rust.rlsToolchain', version)
                    }
                  })
                }
                atomPrompt(title, note)
              })
          }
        }))
        .catch(e => {
          e && console.warn(e)
          // Missing rustup, prompt to install
          atomPrompt(
            "`rustup` is not available",
            {
              description: "From https://www.rustup.rs/",
              detail: "curl https://sh.rustup.rs -sSf | sh"
            },
            ["Install"]
          ).then(response => {
            if (response === "Install") {
              // Install rustup and try again
              installRustup()
                .then(() => this._checkToolchain())
                .then(resolve)
                .catch(reject)
            } else {
              reject()
            }
          })
        })
        .then(() => reject())
    })
    .then(() => clearIdeRustInfos())
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
        this._checkToolchain(this.busySignalService)
          .then(() => checkRls(this.busySignalService))
          .then(() => this._restartLanguageServers(`Switched Rls toolchain to \`${newValue}\``))
          .then(() => this._promptToUpdateToolchain())
      }, 1000)
    ))

    // watch config toolchain updates -> check for updates if enabling
    this.disposables.add(atom.config.onDidChange('ide-rust.checkForToolchainUpdates',
      ({ newValue: enabled }) => {
        if (enabled) this._promptToUpdateToolchain()
      }
    ))

    // check for updates (if enabled) every so often
    let periodicUpdateTimeoutId
    const periodicUpdate = () => {
      this._promptToUpdateToolchain()
      periodicUpdateTimeoutId = setTimeout(periodicUpdate, PERIODIC_UPDATE_CHECK_MILLIS)
    }
    this.disposables.add(new Disposable(() => {
      clearTimeout(periodicUpdateTimeoutId)
    }))
    periodicUpdate()
  }

  deactivate() {
    this.disposables.dispose()
    return super.deactivate()
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
    return ["source.rust"]
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
      !filePath.includes('/target/release/')
  }

  startServerProcess(projectPath) {
    let cmdOverride = rlsCommandOverride()
    if (cmdOverride) {
      if (!this._warnedAboutRlsCommandOverride) {
        clearIdeRustInfos()
        atom.notifications.addInfo(`Using rls command \`${cmdOverride}\``)
        this._warnedAboutRlsCommandOverride = true
      }
      return cp.spawn(cmdOverride, {
        env: serverEnv(),
        shell: true,
        cwd: projectPath
      })
    }

    return this._checkToolchain(this.busySignalService)
      .then(() => checkRls(this.busySignalService))
      .then(() => {
        let toolchain = configToolchain()
        return cp.spawn("rustup", ["run", toolchain, "rls"], {
          env: serverEnv(toolchain),
          cwd: projectPath
        })
      })
      .catch(e => {
        throw e || new Error("failed to start server")
      })
  }
}

module.exports = new RustLanguageClient()
