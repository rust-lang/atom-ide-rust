const CONFLICTING_PACKAGES = [
  // other language server clients - should only use one
  "languageserver-rust",
  "tokamak",
  "atom-rust",
  // rust-analyzer provides lints
  "linter-rust",
  // rust-analyzer provides rustfmt functionality
  "rustfmt",
  // rust-analyzer provides completion
  "racer",
  "racer-v2",
  "racer-plus",
  "autocomplete-racer",
]

/**
 * @param {string} pkg
 * @returns {boolean}
 */
function alreadyNotifying(pkg) {
  return atom.notifications.getNotifications().some((note) => note.getOptions()._src === `ide-rust-conflict-${pkg}`)
}

/** Scans current active packages and shows notifications to help handle conflicts */
function showConflictingPackageWarnings() {
  for (const pkg of CONFLICTING_PACKAGES) {
    if (atom.packages.isPackageActive(pkg) && !alreadyNotifying(pkg)) {
      const note = atom.notifications.addInfo("Choose a rust package", {
        description:
          `You have both \`ide-rust\` and \`${pkg}\` enabled, which ` +
          "include conflicting/duplicate functionality. " +
          "To avoid problems disable one of the packages.",
        dismissable: true,
        _src: `ide-rust-conflict-${pkg}`,
        buttons: [
          {
            text: `Disable ${pkg}`,
            onDidClick: () => {
              atom.packages.disablePackage(pkg)
              note.dismiss()
            },
          },
          {
            text: "Disable ide-rust",
            onDidClick: () => {
              atom.notifications
                .getNotifications()
                .filter((note) => {
                  const src = note.getOptions()._src
                  return src && src.startsWith("ide-rust")
                })
                .forEach((note) => note.dismiss())
              atom.packages.disablePackage("ide-rust")
            },
          },
        ],
      })
    }
  }
}

module.exports = {
  showConflictingPackageWarnings,
}
