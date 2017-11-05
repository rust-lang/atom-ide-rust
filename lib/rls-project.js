const path = require("path")
const fs = require('fs')
const toml = require('toml')
const _ = require('underscore-plus')

/** Container for references to a single Rls invocation */
class RlsProject {
  constructor(server) {
    this.server = server
    this.rlsTomlPath = path.join(this.server.projectPath, 'rls.toml')
    this.projectTargetPath = path.join(this.server.projectPath, 'target')
    this.projectDotGitPath = path.join(this.server.projectPath, '.git')
    this.lastSentConfig = {}
  }

  sendRlsTomlConfig() {
    fs.readFile(this.rlsTomlPath, (err, data) => {
      if (err) return

      try {
        let config = toml.parse(data)
        if (_.isEqual(config, this.lastSentConfig)) return

        this.server.connection.didChangeConfiguration({
          settings: { rust: config }
        })
        this.lastSentConfig = config
      }
      catch (e) { console.warn(`Failed to read ${this.rlsTomlPath}`, e) }
    })
  }
}

module.exports = RlsProject
