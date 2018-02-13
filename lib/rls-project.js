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
    this.lastSentConfig = null
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
      if (this._busyMessage) {
        this._busyMessage.count += 1
      }
      else {
        let busySignal = this.getBusySignalService()
        if (busySignal) {
          this._busyMessage = busySignal
            .reportBusy(`RLS building ${path.basename(this.server.projectPath)}`)
          this._busyMessage.count = 1
        }
      }
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

  /**
   * Send rls.toml as `workspace/didChangeConfiguration` message (or empty/default if no rls.toml)
   */
  sendRlsTomlConfig() {
    let rlsTomlPath = path.join(this.server.projectPath, 'rls.toml')

    fs.readFile(rlsTomlPath, (err, data) => {
      let config = {}
      if (!err) {
        try {
          config = toml.parse(data)
        } catch (e) {
          console.warn(`Failed to read ${rlsTomlPath}`, e)
        }
      }

      if (_.isEqual(config, this.lastSentConfig)) return

      this.server.connection.didChangeConfiguration({
        settings: { rust: config }
      })
      this.lastSentConfig = config
    })
  }
}

module.exports = RlsProject
