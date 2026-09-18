import js from '@eslint/js';
import globals from 'globals';

// Flat config (ESLint 9). Goal: catch the things that rot silently in a
// framework-less, formerly-unlinted ESM codebase — undeclared globals, unused
// vars/imports, dead code — without drowning the signal in style nits.
export default [
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },

  js.configs.recommended,

  {
    // Browser app.
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      // Scratch vectors and intentional throwaways are prefixed with _.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  {
    // Node tooling: dev servers, asset pipelines, headless verification, tests.
    // The verification scripts embed page.evaluate(() => …) callbacks that run
    // in the BROWSER, so they legitimately touch window/document too.
    files: ['scripts/**/*.mjs', 'test/**/*.js', '*.config.js', 'vite.config.*'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
