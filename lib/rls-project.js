const path = require("path")
const fs = require('fs')
const toml = require('toml')
const _ = require('underscore-plus')

/**
 * Container for references to a single Rls invocation
 * @param {ActiveServer} server
 * @param {function} busySignalServiceFn `() => ?BusySignalService`
 */
class RlsProject {
  constructor(server, busySignalServiceFn) {
    this.server = server
    this.getBusySignalService = busySignalServiceFn
    this._lastSentConfig = null

    /** @type {Map<string, BusyMessage>} */
    this._progress = new Map()

    /** @type {?BusyMessage} */
    this._rustDocBusyMessage = null

    this._disposable = atom.notifications.onDidAddNotification(async note => {
      if (this._disposable &&
        (!this.server ||
          !this.server.connection ||
          !this.server.connection.isConnected)) {
        this._disposable.dispose()
        return
      }

      await handleMultiCrateProjectErrors(this.server.projectPath, note)
    })

    // Rls (>= 2018-02-24) sends `window/progress` notifications
    // see https://github.com/Microsoft/language-server-protocol/pull/245/files
    server.connection.onCustom('window/progress', params => {
      const busySignal = this.getBusySignalService()
      if (!busySignal) return

      let {
        id,
        title,
        message,
        percentage,
        done
      } = params
      let busyMessage = this._progress.get(id)

      if (done) {
        if (busyMessage) busyMessage.dispose()
        this._progress.delete(id)
      } else {
        let busyText = `${path.basename(this.server.projectPath)} RLS ${title.toLowerCase()}`
        if (busyMessage) {
          // use previous percentages/messages according to the spec
          percentage = percentage || busyMessage.lastProgressPercentage
          message = message || busyMessage.lastProgressMessage
        }
        if (percentage) busyText += ` ${percentage.toFixed()}%`
        if (message) busyText += `: ${message}`

        if (busyMessage) {
          busyMessage.setTitle(busyText)
        } else {
          busyMessage = busySignal.reportBusy(busyText)
          this._progress.set(id, busyMessage)
        }

        busyMessage.lastProgressPercentage = percentage
        busyMessage.lastProgressMessage = message
      }
    })

    // Rls (< 2018-02-24) sends 3 custom build notifications in sequence
    // - rustDocument/beginBuild
    // - rustDocument/diagnosticsBegin
    // - rustDocument/diagnosticsEnd
    //
    // Certain factors can cause multiple builds to run concurrently
    // ie a `didChangeConfiguration` during a build, so we consider Rls
    // to be building as long as we're waiting for _any_ build.
    server.connection.onCustom('rustDocument/beginBuild', () => {
      if (this._rustDocBusyMessage) {
        this._rustDocBusyMessage.count += 1
      } else {
        let busySignal = this.getBusySignalService()
        if (busySignal) {
          this._rustDocBusyMessage = busySignal
            .reportBusy(`${path.basename(this.server.projectPath)} RLS building`)
          this._rustDocBusyMessage.count = 1
        }
      }
    })
    server.connection.onCustom('rustDocument/diagnosticsEnd', () => {
      if (this._rustDocBusyMessage && this._rustDocBusyMessage.count > 0) {
        this._rustDocBusyMessage.count -= 1

        if (this._rustDocBusyMessage.count === 0) {
          this._rustDocBusyMessage.dispose()
          this._rustDocBusyMessage = null
        }
      }
    })

    // clean up any busy messages
    this.server.process.on('exit', () => {
      this._progress.forEach(msg => msg.dispose())
      this._progress.clear()
      this._rustDocBusyMessage && this._rustDocBusyMessage.dispose()
    })
  }

  // Send rls.toml as `workspace/didChangeConfiguration` message (or default if no rls.toml)
  sendRlsTomlConfig() {
    let rlsTomlPath = path.join(this.server.projectPath, 'rls.toml')

    fs.readFile(rlsTomlPath, (err, data) => {
      let config = this.defaultConfig()
      if (!err) {
        try {
          Object.assign(config, toml.parse(data))
        } catch (e) {
          console.warn(`Failed to read ${rlsTomlPath}`, e)
        }
      }

      if (_.isEqual(config, this._lastSentConfig)) return

      this.server.connection.didChangeConfiguration({
        settings: {
          rust: config
        }
      })
      this._lastSentConfig = config
    })
  }

  // Default Rls config according to package settings & Rls defaults
  defaultConfig() {
    const {
      allTargets,
      clippyPreference
    } = atom.config.get("ide-rust.rlsDefaultConfig")

    const rlsConfig = {}
    if (allTargets === "On" || allTargets === "Off") {
      rlsConfig.all_targets = allTargets === "On"
    }
    if (clippyPreference !== "Rls Default") {
      rlsConfig.clippy_preference = clippyPreference
    }
    return rlsConfig
  }
}

/**
 * Converts fs async callback functions to use promises
 * @param {function} functionWithCallback
 * @return {function} async function
 */
function callbackAsync(functionWithCallback) {
  return async (...args) => {
    return new Promise((resolve, reject) => {
      functionWithCallback(...args, (err, ...out) => {
        if (err) {
          reject(err)
        } else {
          resolve(...out)
        }
      })
    })
  }
}

const asyncLstat = callbackAsync(fs.lstat)

/**
 * Check error notifications to see if the cause is a multi-crate project & offer help.
 *
 * See https://github.com/rust-lang/atom-ide-rust#multi-crate-projects
 *
 * @param {string} projectPath
 * @param {Notification} errorNote
 */
async function handleMultiCrateProjectErrors(projectPath, errorNote) {
  const options = errorNote.options || {}
  const detail = options.detail || ''

  if (options._src !== 'ide-rust' &&
    errorNote.getType() === 'error' &&
    (errorNote.getMessage() || '').startsWith('could not find `Cargo.toml`') &&
    detail.endsWith(projectPath)) {

    let root_manifest = await (asyncLstat(path.join(projectPath, 'Cargo.toml')).catch(() => false))
    if (root_manifest) {
      return
    }

    try {
      const ls = await callbackAsync(fs.readdir)(projectPath)
      const childProjects = []
      for (const f of ls) {
        let file = path.join(projectPath, f)
        let stat = await asyncLstat(file)
        if (stat.isDirectory()) {
          let has_manifest = await (asyncLstat(path.join(file, 'Cargo.toml')).catch(() => false))
          if (has_manifest) {
            childProjects.push(f)
          }
        }
      }

      if (childProjects.length) {
        let newNote
        const projects = childProjects.map(p => `"${p}"`).join(', ')
        const workspaceManifest = `[workspace]\nmembers = [${projects}]`
        let options = {
          _src: 'ide-rust',
          dismissable: true,
          description: `Child projects without a root (or higher) workspace are not supported. A root manifest at _${path.join(projectPath, 'Cargo.toml')}_ could allow RLS to build the projects as a workspace.\n\nSee [atom-ide-rust#multi-crate-projects](https://github.com/rust-lang/atom-ide-rust#multi-crate-projects)`,
          buttons: [{
            text: 'Add workspace Cargo.toml',
            onDidClick: async () => {
              await callbackAsync(fs.writeFile)(path.join(projectPath, 'Cargo.toml'), workspaceManifest)
              newNote.dismiss()
              errorNote.dismiss()
            }
          }, {
            text: 'Ignore project',
            onDidClick: () => {
              const ignoredPaths = atom.config.get('ide-rust.ignoredProjectPaths')
              atom.config.set('ide-rust.ignoredProjectPaths', [ignoredPaths, projectPath].join(', '))
              newNote.dismiss()
              errorNote.dismiss()
            }
          }]
        }
        newNote = atom.notifications.addInfo('Multi-crate project detected', options)
      }
    } catch (e) {
      console.warn(e)
    }
  }
}

module.exports = RlsProject
