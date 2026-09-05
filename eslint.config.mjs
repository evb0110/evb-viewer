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
            'custom/import-specifier-newline': 'error',
            'custom/destructuring-property-newline': 'error',
            'custom/app-tooltip-only': 'error',
            'custom/commonjs-named-imports': 'error',
            'custom/file-naming': 'error',
            'custom/no-core-correctness-timers': 'error',
            'custom/no-raw-red-presentation': 'error',
            'custom/no-direct-console-error': 'error',
            'custom/require-failure-receipt': 'error',
            'custom/require-classified-error-log': 'error',
            'custom/no-unclassified-diagnostic-code': 'error',
            ...stylisticRules,
        },
    },
    {
        files: [
            'app/**/*.{cjs,js,mjs,cts,mts,ts,tsx,vue}',
            'electron/**/*.{cjs,js,mjs,cts,mts,ts,tsx,vue}',
            'packages/**/*.{cjs,js,mjs,cts,mts,ts,tsx,vue}',
            'scripts/**/*.{cjs,js,mjs,cts,mts,ts,tsx,vue}',
            'server/**/*.{cjs,js,mjs,cts,mts,ts,tsx,vue}',
        ],
        ignores: [
            '**/__fixtures__/**',
            '**/__snapshots__/**',
            '**/__tests__/**',
            '**/e2e/**',
            '**/fixtures/**',
            '**/generated/**',
            '**/snapshots/**',
            '**/tests/**',
            '**/vendor/**',
            'packages/i18n-app/messages/**',
        ],
        rules: {
            'max-lines': [
                'error',
                {
                    max: 1200,
                    skipBlankLines: false,
                    skipComments: false,
                },
            ],
        },
    },
    ...[
        ['app/modules/agent-panel/components/AgentAssistantPanel.vue', 789],
        ['app/modules/agent-panel/composables/useAgentAssistantPanelController.ts', 1159],
        ['app/modules/pdf-viewer/components/PdfThumbnails.vue', 915],
        ['app/modules/native-pdf-viewer/components/NativePdfViewer.vue', 1312],
        ['app/modules/scan-cleanup/components/preview/PreviewShell.vue', 1298],
        ['app/modules/scan-cleanup/components/ScanCleanupThumbnailRail.vue', 1274],
        ['electron/features/agent/codexAssistant.ts', 1354],
        ['app/modules/workspace-shell/composables/file-operations/useFileOperationsSaveController.ts', 441],
        ['scripts/diagnostics/pdfNavigationBlinkTrace.ts', 1530],
        ['scripts/diagnostics/scan-cleanup-corpus-verify.mjs', 1429],
        ['scripts/diagnostics/scan-cleanup-word-loss-audit.mjs', 3400],
        ['app/modules/workspace-shell/components/DocumentWorkspace.vue', 1556],
        ['app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue', 1475],
        ['app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer.ts', 1216],
        ['app/platform/browser/browserDocumentRepository.ts', 1207],
        ['app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer.ts', 1296],
        ['app/modules/pdf-viewer/runtime/usePdfViewerFeatureController.ts', 1216],
        ['electron/ocr/jobManager.ts', 1067],
        ['packages/contracts/agentPlatformFeature.ts', 1813],
        ['app/modules/workspace-shell/components/AppShellRoot.vue', 900],
        ['app/modules/workspace-shell/agent/useDocumentWorkspaceAgent.ts', 1083],
        ['electron/features/agent/mcp/mcpServerCore.ts', 979],
        ['scripts/architecture/boundary-check.mjs', 1650],
        ['app/platform/browser-api/browserDjvuCapability.ts', 1202],
        ['electron/features/djvu/main/pdfExport.ts', 1288],
        ['packages/contracts/djvuPlatformFeature.ts', 1328],
        ['packages/contracts/ocrPlatformFeature.ts', 1368],
        // The documents feature keeps its method codecs and result schemas
        // together so the Electron and browser implementations cannot drift.
        // Print, decrypt, and annotation capabilities account for this small
        // amount of protocol growth beyond the shared file budget.
        ['packages/contracts/documentsPlatformFeatureSchemas.ts', 1210],
        // The documents API contract mirrors the native frame, the electron
        // bridge, and the browser bridge in one file; the #171 decrypt and
        // annotation capabilities are the growth this budget covers.
        ['packages/contracts/electronApiDocuments.ts', 1225],
        // The v3 protocol contract is one shared schema with its native
        // counterpart; splitting it would fork the pairing rather than shorten
        // it. The staged Analyze input window and optional Mixed/split evidence
        // are the growth this budget covers.
        ['packages/contracts/scan-cleanup/nativeProtocolV3.ts', 1242],
    ].map(([
        file,
        max,
    ]) => ({
        files: [file],
        rules: {
            'max-lines': [
                'error',
                {
                    max,
                    skipBlankLines: false,
                    skipComments: false,
                },
            ],
        },
    })),
    {
        files: ABSOLUTE_IMPORT_SOURCE_FILES,
        rules: {
            'custom/no-relative-imports': 'error',
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
            'scan-cleanup-core/**/*.ts',
            'scan-cleanup-adapters/**/*.ts',
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
            'scan-cleanup-core/**/*.ts',
            'scan-cleanup-adapters/**/*.ts',
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
