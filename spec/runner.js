"use babel";
import { createRunner } from "atom-jasmine3-test-runner";
import pkg from "../package.json";

// https://github.com/UziTech/atom-jasmine3-test-runner#api
export default createRunner({
  testPackages: Array.from(
    pkg["package-deps"].map((p) => (typeof p === "string" ? p : p.name))
  ),
  timeReporter: true,
  specHelper: true,
  silentInstallation: true,
});
