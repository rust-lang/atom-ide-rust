module.exports = {
  extends: ["eslint:recommended"],
  parserOptions: {
    ecmaVersion: 2017,
  },
  env: {
    es6: true,
    node: true,
    browser: true,
  },
  rules: {
    semi: ["warn", "never"],
    "no-unused-vars": "warn",
    "no-console": ["warn", { allow: ["debug", "info", "warn", "error"] }],
    "valid-jsdoc": ["warn", {
      requireParamDescription: false,
      requireReturn: false,
      requireReturnDescription: false,
    }],
  },
  globals: {
    atom: true,
  },
};
