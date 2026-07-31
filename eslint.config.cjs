module.exports = [
  {
    ignores: ['node_modules/**', 'client/dist/**']
  },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: { ecmaVersion: 2021, sourceType: 'module' },
    env: { browser: true, node: true, es2021: true },
    extends: ['eslint:recommended', 'plugin:react/recommended', 'plugin:react-hooks/recommended', 'prettier'],
    settings: { react: { version: 'detect' } }
  }
];
