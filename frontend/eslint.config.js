import js from '@eslint/js'
import globals from 'globals'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

// jsx-a11y is wired in to surface accessibility regressions on new code without
// failing CI on the pre-existing baseline. Each rule below is downgraded to
// "warn" so the codebase stays green until someone has time to clean them up —
// new violations still show up in the lint output.
const a11yWarnOverrides = Object.fromEntries(
  Object.keys(jsxA11y.flatConfigs.recommended.rules).map((rule) => [rule, 'warn'])
)

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      ...a11yWarnOverrides,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
)
