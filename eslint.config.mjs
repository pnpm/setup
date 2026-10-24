import eslintConfig, { sizeAndShapeRules } from '@pnpm/eslint-config'
import * as regexpPlugin from 'eslint-plugin-regexp'
import tseslint from 'typescript-eslint'

// Code that still exceeds the size and shape limits. Remove a file from this
// list once it is refactored to pass them.
const PENDING_SIZE_AND_SHAPE_REFACTOR = [
  'src/install-pnpm/locked-version.ts',
  'src/install-pnpm/project.ts',
  'src/install-pnpm/run.ts',
  'src/install-runtime/index.ts',
  'src/install-runtime/node-version-file.ts',
  'src/pnpm-install/index.ts',
]

// The shared config applies its rules to TypeScript. The tests here are
// JavaScript modules, so the same rules are applied to them, without the
// rules that need type information.
const forJavaScript = eslintConfig
  .filter(config => config.files?.some(pattern => pattern.endsWith('.ts')))
  .map(config => ({ ...config, files: config.files.map(pattern => pattern.replace(/\.ts$/, '.mjs')) }))

export default [
  {
    ignores: ['**/node_modules', 'dist'],
  },
  ...eslintConfig,
  ...forJavaScript,
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.mjs'],
  },
  {
    files: ['**/*.mjs'],
    rules: {
      // pnpm's own rule that needs type information.
      'conditions/no-object-methods-on-map': 'off',
      'import-x/no-extraneous-dependencies': ['error', {
        devDependencies: ['**/*.test.mjs', 'eslint.config.mjs'],
      }],
    },
  },
  {
    // ESLint reads the config from its default export.
    files: ['eslint.config.mjs'],
    rules: {
      'import-x/no-default-export': 'off',
    },
  },
  regexpPlugin.configs['flat/recommended'],
  {
    files: PENDING_SIZE_AND_SHAPE_REFACTOR,
    rules: Object.fromEntries(Object.keys(sizeAndShapeRules).map(rule => [rule, 'off'])),
  },
]
