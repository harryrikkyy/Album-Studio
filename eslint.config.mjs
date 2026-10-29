// ESLint flat config. Prettier owns formatting; ESLint checks correctness in all JavaScript and, for
// the interface, TypeScript and accessibility rules. Findings still to fix are recorded in
// eslint-suppressions.json, which may only shrink.
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const underscoreMeansUnused = { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }

export default defineConfig([
  globalIgnores(['**/dist/', 'bench/fixture/', 'native/photocraft/']),
  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node },
    rules: {
      'no-unused-vars': ['warn', underscoreMeansUnused],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      'no-inner-declarations': 'off',
      'prefer-const': 'warn',
    },
  },
  // The shared modules' wrappers still look for a browser `window`.
  { files: ['src/**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['**/*.mjs'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
  {
    files: ['native/ui/**/*.{ts,tsx}', 'native/contracts/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: globals.browser },
    rules: { '@typescript-eslint/no-unused-vars': ['error', underscoreMeansUnused] },
  },
  { files: ['native/ui/src/**/*.tsx'], extends: [jsxA11y.flatConfigs.recommended] },
])
