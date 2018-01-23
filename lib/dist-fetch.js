const https = require('https')
const _ = require('underscore-plus')

const datedNightlyHasRlsCache = new Map()
const DATED_REGEX = /(^[^-]+)-(\d{4,}-\d{2}-\d{2})$/

/**
 * @param {Date|string} date
 * @param {string=} channel
 * @return {Promise<string>} toolchain name
 */
function checkDatedNightlyHasRls(date, channel='nightly') {
  const dateString = _.isString(date) ? date : date.toISOString().split('T')[0]
  const cacheKey = `${channel}-${dateString}`

  let fetch = datedNightlyHasRlsCache.get(cacheKey) || new Promise((resolve, reject) => {
    https.get(`https://static.rust-lang.org/dist/${dateString}/channel-rust-${channel}.toml`, res => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed, status: ${res.statusCode}`))
        }
        res.setEncoding("utf8")
        let body = ""
        res.on("data", data => {
          body += data
          if (body.includes('rls-preview')) resolve(cacheKey)
        })
        res.on("end", () => reject(new Error("no 'rls-preview'")))
      })
      .on("error", e => {
        datedNightlyHasRlsCache.delete(cacheKey)
        reject(e)
      })
  })

  if (!datedNightlyHasRlsCache.has(cacheKey)) {
    datedNightlyHasRlsCache.set(cacheKey, fetch)
  }

  return fetch
}

/** @return {Promise<string>} latest nightly dated version with rls-preview */
function fetchLatestDatedNightlyWithRls() {
  const aDayMillis = 24 * 60 * 60 * 1000
  const minDate = new Date(Date.now() - 30 * aDayMillis)

  const check = day => {
    return checkDatedNightlyHasRls(day)
      .catch(e => {
        if (e && e.code === 'ENOTFOUND') throw e

        const yesterday = new Date(day - aDayMillis)
        if (yesterday >= minDate) return check(yesterday)
        else throw new Error("No nightly with 'rls-preview'")
      })
  }

  return check(new Date())
}

/**
 * @param {string} arg.toolchain toolchain to check
 * @param {string} [arg.currentVersion] current installed rustc version
 * @return {Promise<?string>} new version of update available (falsy otherwise)
 */
function fetchLatestDist({ toolchain, currentVersion="none" }) {
  return new Promise((resolve, reject) => {
    https.get(`https://static.rust-lang.org/dist/channel-rust-${toolchain}.toml`, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`check for toolchain update failed, status: ${res.statusCode}`))
      }

      res.setEncoding("utf8")
      let body = ""
      res.on("data", data => body += data)
      res.on("end", () => {
        // use a subsection as toml is slow to parse fully
        let rustcInfo = body.match(/(\[pkg\.rustc\][^[]*)/m)
        if (!rustcInfo) return reject(new Error('could not split channel toml output'))
        let rustcVersion = require('toml').parse(rustcInfo[1]).pkg.rustc.version.trim()
        resolve(
          !currentVersion.trim().endsWith(rustcVersion) &&
          body.includes('rls-preview') &&
          `rustc ${rustcVersion}`
        )
      })
    })
    .on("error", e => {
      console.warn("ide-rust: check for updates failed", e)
      resolve()
    })
  })
}

/**
 * Check a toolchain has rls, this can be done before installing
 * @param {string} toolchain
 * @return {Promise<boolean>}
 */
function checkHasRls(toolchain) {
  let dated = toolchain.match(DATED_REGEX)
  if (dated) {
    return checkDatedNightlyHasRls(dated[2], dated[1]).then(() => true).catch(() => false)
  }
  return fetchLatestDist({ toolchain }).then(v => !!v).catch(() => false)
}

module.exports = {
  fetchLatestDatedNightlyWithRls,
  fetchLatestDist,
  checkHasRls,
  DATED_REGEX,
}
