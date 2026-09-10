import withNuxt from './.nuxt/eslint.config.mjs';
import stylistic from '@stylistic/eslint-plugin';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';
import customPlugin from './eslint-plugin-custom.mjs';
import {
    arrayTypeRules,
    namingRules,
    strictTypeRules,
    stylisticRules,
} from './eslint.shared.mjs';

const ABSOLUTE_IMPORT_SOURCE_FILES = [
    'app/**/*.{ts,vue}',
    'electron/**/*.ts',
    'packages/**/*.ts',
    'scripts/**/*.ts',
    'server/**/*.ts',
    'tests/**/*.ts',
];

const namingOnlyConfig = [
    {
        files: ['landing/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
            },
        },
        plugins: {custom: customPlugin},
        rules: {'custom/file-naming': 'error'},
    },
    {
        files: ['landing/**/*.vue'],
        languageOptions: {
            parser: vueParser,
            parserOptions: {
                ecmaVersion: 2022,
                parser: tsParser,
                sourceType: 'module',
            },
        },
        plugins: {custom: customPlugin},
        rules: {'custom/file-naming': 'error'},
    },
];

const projectConfig = withNuxt(
    {ignores: [
        '!app/modules/**/public/**',
        '!electron/features/**/public/**',
        '**/.devkit/**',
        'landing/**',
        'eslint.config.mjs',
        'stylelint.config.mjs',
        'nuxt.config.ts',
        'landing/nuxt.config.ts',
        'landing/drizzle.config.ts',
        'eslint.shared.mjs',
    ]},
    {
        plugins: {
            '@stylistic': stylistic,
            custom: customPlugin,
        },
        rules: {
            'vue/no-multiple-template-root': 'off',
            'vue/html-self-closing': 'off',
            'vue/no-undef-components': [
                'error',
                {
                    ignorePatterns: [
                        '^U[A-Z]',
                        '^Icon$',
                        '^Nuxt[A-Z]',
                        '^AppTooltip$',
                        '^Lazy[A-Z]',
                        '^i18n-t$',
                        '^(ClientOnly|DevOnly|RouterLink|RouterView)$',
                        '^(Transition|TransitionGroup|KeepAlive|Suspense|Teleport)$',
                        '^(Head|Html|Body|Link|Meta|Style|Title|Base|NoScript)$',
                    ],
                },
            ],
            'vue/no-undef-properties': [
                'error',
                {
                    ignores: ['/^\\$/u'],
                },
            ],
            '@typescript-eslint/unified-signatures': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-inferrable-types': 'error',
            'no-return-await': 'error',
            // Import graph and architectural boundaries are enforced by
            // `check:architecture:imports`; keeping them out of ESLint avoids
            // resolver-heavy graph work on every lint pass.
            'no-restricted-imports': [
                'error',
                {patterns: [
                    {
                        group: [
                            '@i18n-core/*',
                            '@i18n-app/*',
                            '@releaseSelection/*',
                        ],
                        message: 'Import shared packages via their root entrypoint to keep package APIs slim.',
                    },
                ]},
            ],
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'TSAsExpression[expression.type="TSAsExpression"][expression.typeAnnotation.type="TSUnknownKeyword"]',
                    message: 'Avoid "as unknown as" double assertion. Use a type guard, generic parameter, or fix the underlying type instead.',
                },
            ],
            '@typescript-eslint/no-empty-object-type': [
                'error',
                { allowInterfaces: 'with-single-extends' },
            ],
            'prefer-promise-reject-errors': 'error',
            'custom/brace-return-after-if': 'error',
            'custom/app-tooltip-only': 'error',
            'custom/commonjs-named-imports': 'error',
            'custom/file-naming': 'error',
            'custom/no-core-correctness-timers': 'error',
            'custom/no-raw-red-presentation': 'error',
            'custom/no-direct-console-error': 'error',
            'custom/require-failure-receipt': 'error',
            'custom/require-classified-error-log': 'error',
            'custom/no-unclassified-diagnostic-code': 'error',
            'custom/no-removed-package-aliases': 'error',
            ...stylisticRules,
        },
    },
    {
        files: ABSOLUTE_IMPORT_SOURCE_FILES,
        rules: {
        },
    },
    {
        files: ['app/components/AppTooltip.vue'],
        rules: {
            'custom/app-tooltip-only': 'off',
        },
    },
    {
        files: [
            'packages/**/*.ts',
            'scripts/**/*.mjs',
        ],
        rules: {
            'no-restricted-imports': 'off',
        },
    },
    {
        files: ['app/platform/browser-api/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {patterns: [
                    {
                        group: [
                            '@i18n-core/*',
                            '@i18n-app/*',
                            '@releaseSelection/*',
                        ],
                        message: 'Import shared packages via their root entrypoint to keep package APIs slim.',
                    },
                ]},
            ],
        },
    },
    {
        files: [
            'electron/features/search/searchRequestPayload.ts',
            'electron/features/documents/createDocumentsPreloadFileClient.ts',
        ],
        rules: {
            'no-restricted-imports': 'off',
        },
    },
    {
        files: [
            'vitest.config.ts',
        ],
        rules: {
            'no-restricted-imports': 'off',
        },
    },
    {
        files: ['app/i18n/runtime-locales/**/*.ts'],
        rules: {
            'no-restricted-imports': 'off',
        },
    },
    {
        files: [
            'app/**/*.ts',
            'app/**/*.vue',
        ],
        ignores: [
            'app/composables/useTypedI18n.ts',
        ],
        rules: {
            'no-restricted-properties': [
                'error',
                {
                    object: 'window',
                    property: 'electronAPI',
                    message: 'Use hasElectronAPI()/getPlatformAPI() from @app/utils/platform instead of reaching into window.electronAPI directly.',
                },
            ],
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'CallExpression[callee.name="useI18n"]',
                    message: 'Use useTypedI18n() from @app/composables/useTypedI18n instead of calling useI18n() directly in the app.',
                },
                {
                    selector: 'TSAsExpression[expression.type="TSAsExpression"][expression.typeAnnotation.type="TSUnknownKeyword"]',
                    message: 'Avoid "as unknown as" double assertion. Use a type guard, generic parameter, or fix the underlying type instead.',
                },
            ],
        },
    },
    {
        files: ['app/**/*.ts'],
        ignores: ['**/*.d.ts'],
        rules: {
            'custom/arrow-composable': 'error',
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
            'landing/*.config.ts',
            'electron/**',
            'tests/**',
            'scripts/**/*.ts',
            'packages/scan-cleanup/core/**/*.ts',
            'packages/scan-cleanup/adapters/**/*.ts',
            '**/*.d.ts',
        ],
        languageOptions: {parserOptions: {projectService: true}},
        rules: {
            ...strictTypeRules,
            ...arrayTypeRules,
            ...namingRules,
            '@typescript-eslint/require-await': 'error',
            'no-return-await': 'off',
            '@typescript-eslint/no-restricted-imports': [
                'error',
                {paths: [{
                    name: 'vue',
                    message: 'Vue APIs are auto-imported by Nuxt. Use them directly without importing. Type imports (import type) are still allowed.',
                    allowTypeImports: true,
                }]},
            ],
        },
    },
    {
        files: [
            'scripts/**/*.ts',
        ],
        languageOptions: {parserOptions: {
            project: ['./tsconfig.scripts.json'],
            tsconfigRootDir: import.meta.dirname,
        }},
        rules: {
            ...strictTypeRules,
            ...arrayTypeRules,
            ...namingRules,
            '@typescript-eslint/require-await': 'error',
            'no-return-await': 'off',
            'no-empty': ['error', {allowEmptyCatch: true}],
            'no-restricted-imports': 'off',
        },
    },
    {
        files: ['electron/**/*.ts'],
        languageOptions: {parserOptions: {
            project: ['./electron/tsconfig.json'],
            tsconfigRootDir: import.meta.dirname,
        }},
        rules: {
            ...strictTypeRules,
            ...arrayTypeRules,
            ...namingRules,
            '@typescript-eslint/require-await': 'error',
            'no-return-await': 'off',
        },
    },
    {
        files: ['tests/**/*.ts'],
        rules: {
            'no-restricted-imports': 'off',
            ...arrayTypeRules,
            ...namingRules,
            '@typescript-eslint/consistent-type-imports': [
                'error',
                {
                    prefer: 'type-imports',
                    fixStyle: 'separate-type-imports',
                },
            ],
            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
            '@typescript-eslint/ban-ts-comment': [
                'error',
                {
                    'ts-ignore': true,
                    'ts-nocheck': true,
                    'ts-check': false,
                    'ts-expect-error': 'allow-with-description',
                    minimumDescriptionLength: 8,
                },
            ],
            '@typescript-eslint/require-await': 'off',
            'no-return-await': 'off',
        },
    },
    {
        files: ['**/*.vue'],
        plugins: {custom: customPlugin},
        languageOptions: {parserOptions: {projectService: true}},
        rules: {
            ...strictTypeRules,
            '@typescript-eslint/require-await': 'error',
            'no-return-await': 'off',
            ...arrayTypeRules,
            ...namingRules,
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
                {
                    selector: 'TSAsExpression[expression.type="TSAsExpression"][expression.typeAnnotation.type="TSUnknownKeyword"]',
                    message: 'Avoid "as unknown as" double assertion. Use a type guard, generic parameter, or fix the underlying type instead.',
                },
            ],
            '@typescript-eslint/no-restricted-imports': [
                'error',
                {paths: [{
                    name: 'vue',
                    message: 'Vue APIs are auto-imported by Nuxt. Use them directly without importing. Type imports (import type) are still allowed.',
                    allowTypeImports: true,
                }]},
            ],
            'custom/vue-boolean-prop-shorthand': 'error',
            'custom/brace-return-after-if': 'error',
            'custom/no-scss-ampersand-concatenation': 'error',
            'custom/nuxt-ui-semantic-utilities': 'error',
            'custom/tailwind-class-shorthand': 'error',
            'custom/vue-define-emits-tuple': 'error',
        },
    },
);

export default process.env.EVB_ESLINT_NAMING_ONLY === '1'
    ? namingOnlyConfig
    : projectConfig;
