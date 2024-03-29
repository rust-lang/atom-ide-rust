const https = require("https")
const _ = require("underscore-plus")

const datedNightlyHasRlsCache = new Map()
const DATED_REGEX = /(^[^-]+)-(\d{4,}-\d{2}-\d{2})$/

/**
 * @param {string} manifest Toml
 * @returns {boolean}
 */
function manifest_includes_rls(manifest) {
  return manifest.includes("rls-preview") && !manifest.includes('[pkg.rls-preview]\nversion = ""')
}

/**
 * @param {Date | string} date
 * @param {string} [channel] Defaults to `nightly`
 * @returns {Promise<string>} Toolchain name
 */
function checkDatedDistHasRls(date, channel = "nightly") {
  const dateString = _.isString(date) ? date : date.toISOString().split("T")[0]
  const cacheKey = `${channel}-${dateString}`

  const fetch =
    datedNightlyHasRlsCache.get(cacheKey) ||
    new Promise((resolve, reject) => {
      https
        .get(`https://static.rust-lang.org/dist/${dateString}/channel-rust-${channel}.toml`, (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Failed, status: ${res.statusCode}`))
          }
          res.setEncoding("utf8")
          let body = ""
          res.on("data", (data) => {
            body += data
            if (manifest_includes_rls(body)) {
              resolve(cacheKey)
            }
          })
          res.on("end", () => reject(new Error("no 'rls-preview'")))
        })
        .on("error", (e) => {
          datedNightlyHasRlsCache.delete(cacheKey)
          reject(e)
        })
    })

  if (!datedNightlyHasRlsCache.has(cacheKey)) {
    datedNightlyHasRlsCache.set(cacheKey, fetch)
  }

  return fetch
}

/**
 * @param {string} [channel] Defaults to `nightly`
 * @returns {Promise<string>} Latest channel dated version with rls-preview
 */
function fetchLatestDatedDistWithRls(channel) {
  const aDayMillis = 24 * 60 * 60 * 1000
  const minDate = new Date(Date.now() - 30 * aDayMillis)

  const check = (day) => {
    return checkDatedDistHasRls(day, channel).catch((e) => {
      if (e && e.code === "ENOTFOUND") {
        throw e
      }

      const yesterday = new Date(day - aDayMillis)
      if (yesterday >= minDate) {
        return check(yesterday)
      } else {
        throw new Error("No nightly with 'rls-preview'")
      }
    })
  }

  return check(new Date())
}

/**
 * @param {string} arg.toolchain Toolchain to check
 * @param {string} [arg.currentVersion] Current installed rustc version
 * @returns {Promise<?string>} New version of update available (falsy otherwise)
 */
function fetchLatestDist({ toolchain, currentVersion = "none" }) {
  return new Promise((resolve, reject) => {
    https
      .get(`https://static.rust-lang.org/dist/channel-rust-${toolchain}.toml`, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`check for toolchain update failed, status: ${res.statusCode}`))
        }

        res.setEncoding("utf8")
        let body = ""
        res.on("data", (data) => (body += data))
        res.on("end", () => {
          // use a subsection as toml is slow to parse fully
          const rustcInfo = body.match(/(\[pkg\.rustc][^[]*)/m)
          if (!rustcInfo) {
            return reject(new Error("could not split channel toml output"))
          }
          const rustcVersion = require("toml").parse(rustcInfo[1]).pkg.rustc.version.trim()
          resolve(
            !currentVersion.trim().endsWith(rustcVersion) && manifest_includes_rls(body) && `rustc ${rustcVersion}`
          )
        })
      })
      .on("error", (e) => {
        console.warn("ide-rust: check for updates failed", e)
        resolve()
      })
  })
}

/**
 * Check a toolchain has rls, this can be done before installing
 *
 * @param {string} toolchain
 * @returns {Promise<boolean>}
 */
function checkHasRls(toolchain) {
  const dated = toolchain.match(DATED_REGEX)
  if (dated) {
    return checkDatedDistHasRls(dated[2], dated[1])
      .then(() => true)
      .catch(() => false)
  }
  return fetchLatestDist({ toolchain })
    .then((v) => Boolean(v))
    .catch(() => false)
}

/**
 * @param {string} channel Ie nightly, beta, stable
 * @returns {Promise<string>} Latest channel dated version with rls-preview or the channel itself if ok
 */
async function suggestChannelOrDated(channel) {
  const latestDatedPromise = fetchLatestDatedDistWithRls(channel)
  try {
    const latestIsOk = await fetchLatestDist({ toolchain: channel })
    if (latestIsOk) {
      return channel
    }
  } catch (e) {
    console.warn(e)
  }
  return latestDatedPromise
}

module.exports = {
  fetchLatestDist,
  checkHasRls,
  suggestChannelOrDated,
  DATED_REGEX,
}
