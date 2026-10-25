import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { loggingLintConfig } from '@quynhonsemiconductor/observability/eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'db/migrations/**', '**/*.js'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // One log shape, one bootstrap (@quynhonsemiconductor/observability/eslint): no `console` in app code or in db/ scripts (use
  // `createScriptLogger`, or `process.stdout.write` for a human-facing report), and no `NestFactory.create*` outside tests (use
  // `createHttpApp` / `createWorkerApp`). The coverage-floor checker is CI tooling, not app code.
  ...loggingLintConfig({ consoleAllowedIn: ['test/check-coverage-floors.ts'] }),
);
