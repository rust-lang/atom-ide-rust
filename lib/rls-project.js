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


    // Rls (>= 2018-02-24) sends `window/progress` notifications
    // see https://github.com/Microsoft/language-server-protocol/pull/245/files
    server.connection.onCustom('window/progress', params => {
      const busySignal = this.getBusySignalService()
      if (!busySignal) return

      let { id, title, message, percentage, done } = params
      let busyMessage = this._progress.get(id)

      if (done) {
        if (busyMessage) busyMessage.dispose()
        this._progress.delete(id)
      }
      else {
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
        }
        else {
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
      }
      else {
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
        settings: { rust: config }
      })
      this._lastSentConfig = config
    })
  }

  // Default Rls config according to package settings & Rls defaults
  defaultConfig() {
    const { allTargets, clippyPreference } = atom.config.get("ide-rust.rlsDefaultConfig")
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

module.exports = RlsProject
