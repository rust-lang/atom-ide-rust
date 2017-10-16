const cp = require("child_process")
const os = require("os")
const path = require("path")
const { AutoLanguageClient } = require("atom-languageclient")

// TODO: Support windows
// TODO: Progress notifications during installation

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

function atomPrompt(message, options, buttons) {
  return new Promise((resolve, reject) => {
    const notification = atom.notifications.addInfo(
      message,
      Object.assign(
        {
          dismissable: true,
          buttons: buttons.map(button => ({
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

function installStable() {
  return exec("rustup toolchain install stable")
}

function setDefaultToolchain() {
  return exec("rustup default stable")
}

// Checks for rustup and a default toolchain
// If not found, asks to install. If user declines, throws error
function checkToolchain() {
  return new Promise((resolve, reject) => {
    exec("rustup toolchain list")
      .then(results => {
        const { stdout } = results
        const matches = /(.*) \(default\)$/im.exec(stdout)

        // If default toolchain found, we're done
        if (matches && matches.length > 1) {
          return resolve(matches[1])
        }

        // If no default toolchain found, install stable toolchain
        // Ask to install
        atomPrompt(
          "`rustup` missing default toolchain",
          {
            detail: "rustup toolchain install stable && rustup default stable"
          },
          ["Install"]
        ).then(response => {
          if (response === "Install") {
            installStable()
              .then(() => setDefaultToolchain())
              .then(checkToolchain)
              .then(resolve)
              .catch(reject)
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
}

// Check for and install RLS
function checkRls() {
  return exec("rustup component list").then(results => {
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
    return exec("rustup component add rls-preview")
      .then(() => exec("rustup component add rust-src"))
      .then(() =>
        exec("rustup component add rust-analysis")
      )
  })
  .catch(() => {
    atom.notifications.addError("Unable to install RLS components", {
      dismissable: true,
      detail: "Please ensure your default toolchain is at least version 1.21"
    })
  })
}

class RustLanguageClient extends AutoLanguageClient {
  activate() {
    super.activate()

    // Get required dependencies
    require("atom-package-deps").install("ide-rust", false)
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

  startServerProcess() {
    let toolchain
    return checkToolchain()
      .then(toolchain_ => {
        toolchain = toolchain_

        return checkRls()
      })
      .then(() => {
        let rustSrcPath = process.env["RUST_SRC_PATH"] || ""
        if (rustSrcPath.length === 0) {
          rustSrcPath = path.join(
            os.homedir(),
            ".rustup/toolchains/" + toolchain + "/lib/rustlib/src/rust/src/"
          )
        }

        return cp.spawn("rustup", ["run", "rls"], {
          env: {
            PATH: getPath(),
            RUST_SRC_PATH: rustSrcPath
          }
        })
      })
  }
}

module.exports = new RustLanguageClient()
