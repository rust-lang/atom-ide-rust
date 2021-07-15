const timeout = process.env.CI ? 50000 : 2000;

describe("tests", () => {
  it(
    "activates and installs dependencies",
    async () => {
      /*    Activation     */
      // Trigger deferred activation
      atom.packages.triggerDeferredActivationHooks();
      // Activate activation hook
      atom.packages.triggerActivationHook("core:loaded-shell-environment");

      // Activate the package
      await atom.packages.activatePackage("ide-rust");
      expect(atom.packages.isPackageLoaded("ide-rust")).toBeTruthy();

      // wait until package-deps installs the deps
      const allDeps = atom.packages.getAvailablePackageNames();
      expect(allDeps.includes("atom-ide-base")).toBeTruthy();

      await atom.packages.activatePackage("atom-ide-base");
      expect(atom.packages.isPackageLoaded("atom-ide-base")).toBeTruthy();
    },
    timeout + 2000
  );
});
