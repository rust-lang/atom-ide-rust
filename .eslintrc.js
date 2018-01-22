module.exports = {
  extends: ["eslint:recommended"],
  env: {
    es6: true,
    node: true,
    browser: true,
  },
  rules: {
    semi: ["error", "never"],
    "no-console": "off",
  },
  globals: {
    atom: true,
  },
};
