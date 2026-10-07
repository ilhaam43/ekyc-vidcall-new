import js from '@eslint/js';
import globals from 'globals';
export default [
  { ignores: ['node_modules/**', '**/dist/**', 'infra/jitsi/upstream/**', '.local/**', 'coverage/**'] },
  { files: ['**/*.{js,jsx,mjs}'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } }, globals: { ...globals.node, ...globals.browser } }, rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
];
