const path = require("path")
const fs = require('fs')
const toml = require('toml')
const _ = require('underscore-plus')

/**
 * Container for references to a single Rls invocation
 * @param {ActiveServer} server
 * @param {function} busySignalServiceFn `() => [BusySignalService]`
 */
class RlsProject {
  constructor(server, busySignalServiceFn) {
    this.server = server
    this.lastSentConfig = {}
    this.getBusySignalService = busySignalServiceFn

    // Rls sends 3 custom build notifications in sequence
    // - rustDocument/beginBuild
    // - rustDocument/diagnosticsBegin
    // - rustDocument/diagnosticsEnd
    //
    // Certain factors can cause multiple builds to run concurrently
    // ie a `didChangeConfiguration` during a build, so we consider Rls
    // to be building as long as we're waiting for _any_ build.
    server.connection.onCustom('rustDocument/beginBuild', () => {
      if (!this._busyMessage) {
        let busySignal = this.getBusySignalService()
        this._busyMessage = busySignal &&
          busySignal.reportBusy(`RLS building ${path.basename(this.server.projectPath)}`)
        this._busyMessage.count = 0
      }

      this._busyMessage.count += 1
    })
    server.connection.onCustom('rustDocument/diagnosticsEnd', () => {
      if (this._busyMessage && this._busyMessage.count > 0) {
        this._busyMessage.count -= 1

        if (this._busyMessage.count === 0) {
            this._busyMessage.dispose()
            this._busyMessage = null
        }
      }
    })

    this.server.process.on('exit', () => this._busyMessage && this._busyMessage.dispose())
  }

  sendRlsTomlConfig() {
    let rlsTomlPath = path.join(this.server.projectPath, 'rls.toml')

    fs.readFile(rlsTomlPath, (err, data) => {
      if (err) return

      try {
        let config = toml.parse(data)
        if (_.isEqual(config, this.lastSentConfig)) return

        this.server.connection.didChangeConfiguration({
          settings: { rust: config }
        })
        this.lastSentConfig = config
      }
      catch (e) { console.warn(`Failed to read ${rlsTomlPath}`, e) }
    })
  }
}

module.exports = RlsProject
