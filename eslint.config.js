import js from '@eslint/js';

const nodeGlobals = Object.fromEntries(
  [
    'AbortController',
    'Buffer',
    'TextDecoder',
    'TextEncoder',
    'URL',
    'URLSearchParams',
    'clearTimeout',
    'console',
    'fetch',
    'process',
    'Response',
    'setImmediate',
    'setTimeout',
  ].map((name) => [name, 'readonly']),
);

export default [
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: nodeGlobals },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
