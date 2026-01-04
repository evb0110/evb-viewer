import withNuxt from './.nuxt/eslint.config.mjs';
import stylistic from '@stylistic/eslint-plugin';
import customPlugin from './eslint-plugin-custom.mjs';

const stylisticRules = {
    '@stylistic/indent': [
        'error',
        4,
    ],
    '@stylistic/quotes': [
        'error',
        'single',
    ],
    '@stylistic/semi': [
        'error',
        'always',
    ],
    '@stylistic/comma-dangle': [
        'error',
        'always-multiline',
    ],
    '@stylistic/array-bracket-newline': [
        'error',
        { minItems: 2 },
    ],
    '@stylistic/array-element-newline': [
        'error',
        { minItems: 2 },
    ],
    '@stylistic/object-curly-newline': [
        'error',
        { minProperties: 2 },
    ],
    '@stylistic/object-property-newline': [
        'error',
        { allowAllPropertiesOnSameLine: false },
    ],
};

export default withNuxt(
    {ignores: [
        '**/.devkit/**',
        'scripts/**',
    ]},
    {
        plugins: {
            '@stylistic': stylistic,
            custom: customPlugin,
        },
        rules: {
            'vue/no-multiple-template-root': 'off',
            'vue/html-self-closing': 'off',
            '@typescript-eslint/unified-signatures': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-inferrable-types': 'error',
            'no-return-await': 'error',
            'import/no-relative-parent-imports': 'error',
            'custom/brace-return-after-if': 'error',
            'custom/import-specifier-newline': 'error',
            ...stylisticRules,
        },
    },
    {
        files: [
            '**/*.ts',
            '**/*.tsx',
        ],
        ignores: [
            '*.config.ts',
            '*.config.mts',
            '*.config.mjs',
            'eslint.config.mjs',
            'nuxt.config.ts',
            'electron/**',
            '**/*.d.ts',
        ],
        languageOptions: {parserOptions: {projectService: true}},
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
        files: ['electron/**/*.ts'],
        rules: {'no-restricted-imports': [
            'error',
            {patterns: [{
                group: ['./*'],
                message: 'Use absolute imports with @electron/ prefix instead of relative imports',
            }]},
        ]},
    },
    {
        files: ['**/*.vue'],
        plugins: {custom: customPlugin},
        languageOptions: {parserOptions: {projectService: true}},
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
        },
    },
);
