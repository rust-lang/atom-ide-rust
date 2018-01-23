module.exports = {
  extends: ["eslint:recommended"],
  env: {
    es6: true,
    node: true,
    browser: true,
  },
  rules: {
    semi: ["warn", "never"],
    "no-console": "off",
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
