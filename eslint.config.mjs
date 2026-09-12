import { defineConfig, globalIgnores } from 'eslint/config';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import prettier from 'eslint-plugin-prettier';
import chaiFriendly from 'eslint-plugin-chai-friendly';
import tsParser from '@typescript-eslint/parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});

export default defineConfig([
    globalIgnores([
        '**/node_modules',
        '**/coverage',
        '**/deployments',
        '**/artifacts',
        '**/cache',
        '**/typechain-types',
    ]),
    {
        extends: compat.extends(
            'eslint:recommended',
            'plugin:@typescript-eslint/recommended',
            'prettier',
        ),

        plugins: {
            '@typescript-eslint': typescriptEslint,
            prettier,
        },

        languageOptions: {
            globals: {},
            parser: tsParser,
            ecmaVersion: 'latest',
            sourceType: 'module',
        },

        rules: {
            'prettier/prettier': 'warn',
            '@typescript-eslint/no-unused-vars': 'warn',
            '@typescript-eslint/no-explicit-any': 'warn',
        },
    },
    {
        // CommonJS config files run directly under Node, not bundled — declare
        // the Node/CJS globals they use so `module`/`require`/etc. aren't
        // flagged by no-undef.
        files: ['.solcover.js'],
        languageOptions: {
            globals: {
                module: 'writable',
                require: 'readonly',
                process: 'readonly',
                __dirname: 'readonly',
            },
        },
    },
    {
        // Chai's property-style assertions (e.g. `expect(x).to.be.properAddress`)
        // are getters with an assertion side effect, not "unused expressions" —
        // eslint-plugin-chai-friendly's rule understands this pattern while still
        // catching genuinely unused expressions elsewhere in test files.
        files: ['test/**/*.ts'],
        plugins: { 'chai-friendly': chaiFriendly },
        rules: {
            'no-unused-expressions': 'off',
            '@typescript-eslint/no-unused-expressions': 'off',
            'chai-friendly/no-unused-expressions': 'error',
        },
    },
]);
