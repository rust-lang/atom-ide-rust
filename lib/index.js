const cp = require("child_process")
const os = require("os")
const path = require("path")
const _ = require('underscore-plus')
const RlsProject = require('./rls-project.js')
const { CompositeDisposable, Disposable } = require('atom')
const { AutoLanguageClient } = require("atom-languageclient")

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

  return new Promise((resolve, reject) => {
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

/** Developer override of the command to start a Rls instance */
function rlsCommandOverride() {
  return atom.config.get('ide-rust.rlsCommandOverride')
}

// Installs nightly
function installCompiler() {
  return exec(`rustup toolchain install ${configToolchain()}`)
}

/**
 * Checks for rustup and nightly toolchain
 * If not found, asks to install. If user declines, throws error
 * @param [busySignalService]
 */
function checkToolchain(busySignalService) {

  return new Promise((resolve, reject) => {
    exec(`rustup run ${configToolchain()} rustc --version`)
      .then(resolve)
      .catch(() => {
        // If not found, install it
        // Ask to install
        atomPrompt(
          `\`rustup\` missing ${configToolchain()} toolchain`,
          {
            detail: `rustup toolchain install ${configToolchain()}`
          },
          ["Install"]
        ).then(response => {
          if (response === "Install") {
            let installPromise = installCompiler()
              .then(checkToolchain)
              .then(resolve)
              .catch(e => {
                console.warn(e)
                clearIdeRustInfos()
                let err = (e + '').split('\n')
                err = err.length && err[0] || `Error installing rust  \`${configToolchain()}\``
                atom.notifications.addError(err, {
                  detail: 'Check the toolchain is valid & connection is available',
                  dismissable: true
                })
                resolve()
              })

              busySignalService && busySignalService.reportBusyWhile(
                `Installing rust \`${configToolchain()}\``,
                () => installPromise)
          } else {
            reject()
          }
        })
      })
      .catch(() => {
        // Missing rustup
        // Ask to install
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
              .then(checkToolchain)
              .then(resolve)
              .catch(reject)
          } else {
            reject()
          }
        })
      })
  })
  .then(() => clearIdeRustInfos())
}

/**
 * Check for and install Rls
 * @param [busySignalService]
 */
function checkRls(busySignalService) {
  let toolchain = configToolchain()

  return exec(`rustup component list --toolchain ${toolchain}`).then(results => {
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
        atom.notifications.addError(`\`rls-preview\` was not found on \`${toolchain}\``, {
          detail: 'Try configuring another toolchain, like a previous nightly or `beta`',
          dismissable: true
        })
        e._logged = true
        throw e
      })
      .then(() => exec(`rustup component add rust-src --toolchain ${toolchain}`))
      .then(() =>
        exec(`rustup component add rust-analysis --toolchain ${toolchain}`)
      )
      .catch(e => {
        if (!e._logged)
          atom.notifications.addError(`\`rust-src\`/\`rust-analysis\` not found on \`${toolchain}\``, {
            dismissable: true
          })
      })

    busySignalService && busySignalService.reportBusyWhile(
      `Adding components rls-preview, rust-src, rust-analysis`,
      () => installRlsPromise)

    return installRlsPromise
  })
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
          ' For example ***beta*** or ***nightly-2017-11-01***.',
        type: 'string',
        default: 'nightly'
      }
    }
  }

  activate() {
    super.activate()

    // Get required dependencies
    require("atom-package-deps").install("ide-rust", false)

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

    this.disposables.add(atom.config.onDidChange('ide-rust.rlsToolchain',
      _.debounce(({ newValue }) => {
        checkToolchain(this.busySignalService)
          .then(() => checkRls(this.busySignalService))
          .then(() => {
            // TODO I'd actually like to restart all servers with the new toolchain here
            // but this doesn't currently seem possible see https://github.com/atom/atom-languageclient/issues/135
            // Until it is possible the 'Reload' button should help
            atomPrompt(`Switched Rls toolchain to \`${newValue}\``, {
              detail: 'Close and reopen editor windows or reload ' +
                'atom to ensure usage of the new toolchain',
              buttons: [{
                text: 'Reload',
                onDidClick: () => atom.commands.dispatch(window, 'window:reload')
              }]
            })
          })
      }, 1000)
    ))
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
    return !filePath.includes('/.git/') && !filePath.includes('/target/rls/')
  }

  startServerProcess() {
    let toolchain
    return checkToolchain(this.busySignalService)
      .then(toolchain_ => {
        toolchain = toolchain_

        return checkRls(this.busySignalService)
      })
      .then(() => {
        let rustSrcPath = process.env["RUST_SRC_PATH"] || ""
        if (rustSrcPath.length === 0) {
          rustSrcPath = path.join(
            os.homedir(),
            ".rustup/toolchains/" + toolchain + "/lib/rustlib/src/rust/src/"
          )
        }

        let cmdOverride = rlsCommandOverride()
        let env = {
          PATH: getPath(),
          RUST_SRC_PATH: rustSrcPath
        }

        if (cmdOverride) {
          if (!this._warnedAboutRlsCommandOverride) {
            clearIdeRustInfos()
            atom.notifications.addInfo(`Using rls command \`${cmdOverride}\``)
            this._warnedAboutRlsCommandOverride = true
          }
          return cp.spawn(cmdOverride, {
            env,
            shell: true
          })
        }
        else {
          return cp.spawn("rustup", ["run", configToolchain(), "rls"], { env })
        }
      })
  }
}

module.exports = new RustLanguageClient()
