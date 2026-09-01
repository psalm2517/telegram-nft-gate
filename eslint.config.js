import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['web/dist/**', '.wrangler/**', 'node_modules/**', 'worker-configuration.d.ts'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      globals: { ...globals.worker, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },

  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  {
    // Interface-extension shims and ambient declarations.
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/no-empty-object-type': 'off' },
  },
);
