import withNuxt from './.nuxt/eslint.config.mjs';
import format from 'eslint-plugin-format';
import customPlugin from './eslint-plugin-custom.mjs';

export default withNuxt(
    {
        ignores: ['**/.devkit/**'],
    },
    {
        plugins: {
            custom: customPlugin,
        },
        rules: {
            'vue/no-multiple-template-root': 'off',
            'vue/html-self-closing': 'off',
            '@typescript-eslint/unified-signatures': 'off',
            'no-return-await': 'error',
            'custom/brace-return-after-if': 'error',
        },
    },
    {
        files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
        ignores: ['**/*.d.ts'],
        plugins: {
            format,
        },
        rules: {
            'format/prettier': [
                'error',
                {
                    tabWidth: 4,
                    useTabs: false,
                    parser: 'typescript',
                    singleQuote: true,
                },
            ],
        },
    },
    {
        files: ['**/*.ts', '**/*.tsx'],
        ignores: [
            '*.config.ts',
            '*.config.mts',
            '*.config.mjs',
            'eslint.config.mjs',
            'nuxt.config.ts',
            'electron/**',
            '**/*.d.ts',
        ],
        languageOptions: {
            parserOptions: {
                projectService: true,
            },
        },
        rules: {
            '@typescript-eslint/require-await': 'error',
            '@typescript-eslint/array-type': [
                'error',
                {
                    default: 'array-simple',
                    readonly: 'array-simple',
                },
            ],
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'typeAlias',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^T[A-Z]',
                        match: true,
                    },
                },
                {
                    selector: 'interface',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^I[A-Z]',
                        match: true,
                    },
                },
            ],
        },
    },
    {
        files: ['**/*.css', '**/*.scss'],
        plugins: {
            format,
        },
        languageOptions: {
            parser: format.parserPlain,
        },
        rules: {
            'format/prettier': [
                'error',
                {
                    tabWidth: 4,
                    useTabs: false,
                    parser: 'scss',
                    singleQuote: true,
                },
            ],
        },
    },
    {
        files: ['**/*.vue'],
        plugins: {
            format,
            custom: customPlugin,
        },
        languageOptions: {
            parserOptions: {
                projectService: true,
            },
        },
        rules: {
            '@typescript-eslint/require-await': 'error',
            '@typescript-eslint/array-type': [
                'error',
                {
                    default: 'array-simple',
                    readonly: 'array-simple',
                },
            ],
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'typeAlias',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^T[A-Z]',
                        match: true,
                    },
                },
                {
                    selector: 'interface',
                    format: ['PascalCase'],
                    custom: {
                        regex: '^I[A-Z]',
                        match: true,
                    },
                },
            ],
            'vue/no-restricted-syntax': [
                'error',
                {
                    selector:
                        'VExpressionContainer > * Identifier[name="$props"]',
                    message:
                        'Use destructured props from defineProps() instead of $props',
                },
            ],
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'Identifier[name="$props"]',
                    message:
                        'Use destructured props from defineProps() instead of $props',
                },
                {
                    selector: 'Identifier[name="withDefaults"]',
                    message:
                        'use props destructuring. beware that withDefaults is not compatible with destructured props. Use default values in destructuring pattern directly, vue 3.5 supports them',
                },
            ],
            'custom/vue-boolean-prop-shorthand': 'error',
            'custom/brace-return-after-if': 'error',
            'format/prettier': [
                'error',
                {
                    tabWidth: 4,
                    useTabs: false,
                    parser: 'vue',
                    singleQuote: true,
                },
            ],
        },
    },
);
