module.exports = {
  extends: ["eslint:recommended"],
  parserOptions: {
    ecmaVersion: 6,
  },
  env: {
    node: true,
  },
  rules: {
    semi: ["error", "never"],
    'no-console': "off",
  },
  globals: {
    Promise: true,
    atom: true,
  },
};
