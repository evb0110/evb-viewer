import {readdirSync} from 'node:fs';
import withNuxt from './.nuxt/eslint.config.mjs';
import stylistic from '@stylistic/eslint-plugin';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';
import customPlugin from './eslint-plugin-custom.mjs';
import importPlugin from 'eslint-plugin-import';
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

const moduleEntrypoints = [
    'public', 'index.ts', 'index.tsx', 'index.js', 'index.mjs', 'public.ts', 'public.tsx',
    'publicNative.ts', 'public.js', 'public.mjs', 'public/index.ts', 'public/index.tsx',
    'public/index.js', 'public/index.mjs',
];
const boundaryZones = [];
const addZone = (target, from, except = []) => boundaryZones.push({
    target,
    from,
    ...(except.length > 0 ? {except} : {}),
});

for (const [source, target] of [
    ['electron', 'app'], ['landing', 'app'], ['landing', 'electron'], ['electron', 'landing'],
    ['app', 'landing'], ['packages', 'app'], ['packages', 'electron'], ['packages', 'landing'],
    ['app/services', 'app/composables'], ['scripts', 'electron'], ['scripts', 'app'],
    ['app', 'scripts'], ['electron', 'scripts'], ['packages', 'scripts'], ['server', 'electron'],
    ['server', 'landing'], ['app', 'server'], ['electron', 'server'], ['landing', 'server'],
    ['packages', 'server'],
]) addZone(source, target);

for (const [source, allowed] of [
    ['packages/contracts', ['contracts', 'i18n-core']],
    ['packages/pdf-core', ['pdf-core', 'contracts']],
    ['packages/agent-core', ['agent-core', 'contracts']],
    ['packages/i18n-core', ['i18n-core']],
    ['packages/i18n-app', ['i18n-app', 'i18n-core']],
    ['packages/release-selection', ['release-selection', 'contracts']],
    ['packages/electron-worker-bundles', ['electron-worker-bundles']],
    ['packages/scan-cleanup', ['scan-cleanup', 'contracts']],
]) addZone(source, 'packages', allowed.map(name => `./${name}`));
addZone('packages/!(contracts|pdf-core|agent-core|release-selection|scan-cleanup)/**/*', 'packages/contracts');

for (const [prefix, allowed] of [
    ['app/modules', moduleEntrypoints],
    ['electron/features', [...moduleEntrypoints, 'contract.ts']],
]) {
    const owners = readdirSync(prefix, {withFileTypes: true})
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    for (const sourceOwner of owners) {
        for (const targetOwner of owners) {
            if (sourceOwner === targetOwner) continue;
            addZone(`${prefix}/${sourceOwner}`, `${prefix}/${targetOwner}`, allowed);
        }
    }
}
for (const owner of readdirSync('electron/features', {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    for (const importer of readdirSync('electron/features', {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
        if (owner !== importer) addZone(`electron/features/${importer}`, `electron/features/${owner}/main`);
    }
}

for (const ownerRoot of ['app/platform/browser-api', 'app/modules/document-viewer']) {
    const appChildren = readdirSync('app', {withFileTypes: true})
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    for (const child of appChildren) {
        if (ownerRoot.startsWith(`app/${child}/`)) {
            const ownerName = ownerRoot.slice(`app/${child}/`.length);
            addZone(`app/${child}/!(${ownerName})/**/*`, ownerRoot, ['public.ts']);
        } else {
            addZone(`app/${child}`, ownerRoot, ['public.ts']);
        }
    }
}
for (const owner of readdirSync('app/modules', {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    addZone('app/pages', `app/modules/${owner}`, moduleEntrypoints);
}
for (const [target, from] of [
    ['app/modules/pdf-viewer/runtime/annotations', 'app/modules/pdf-viewer/tools'],
    ['app/modules/pdf-viewer/tools', 'app/modules/pdf-viewer/runtime/annotations'],
    ['app/modules/pdf-viewer/runtime/save', 'app/modules/pdf-viewer/runtime/annotations'],
    ['app/modules/pdf-viewer/runtime/save', 'app/modules/pdf-viewer/tools'],
]) addZone(target, from);
addZone('app/!(modules/pdf-viewer)/**/*', 'app/modules/pdf-viewer/runtime/save');
for (const target of ['electron', 'packages', 'scripts', 'server', 'landing']) addZone(target, 'app/modules/pdf-viewer/runtime/save');
addZone('app/modules/pdf-viewer/engine', 'app/modules/pdf-viewer', ['./engine', './dom']);
addZone(['app', 'packages'], 'packages/contracts/platformApi.ts');
addZone('electron/native-tools', ['electron/pdf', 'electron/features/djvu']);
const ocrNativeToolPaths = [
    'electron/features/ocr/main/paths.ts',
    'electron/features/ocr/main/nativeToolPaths.ts',
    'electron/features/ocr/main/resolveOcrResourcesBase.ts',
    'electron/features/ocr/pipeline/dpiDetection.ts',
];
for (const entry of readdirSync('electron/features', {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    if (entry !== 'ocr') addZone(`electron/features/${entry}`, ocrNativeToolPaths);
}
for (const entry of ['pdf', 'djvu', 'native-tools']) addZone(`electron/${entry}`, ocrNativeToolPaths);
addZone('electron/native-tools', ocrNativeToolPaths);

const namingOnlyConfig = [
    {ignores: ['landing/.nuxt/**', 'landing/.output/**', 'landing/dist/**', 'landing/node_modules/**']},
    {
        files: ['landing/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
            },
        },
        plugins: {custom: customPlugin, 'import-classic': importPlugin},
        settings: {
            'import/resolver': {typescript: {project: './tsconfig.json'}},
        },
        rules: {
            'custom/file-naming': 'error',
            'import-classic/no-restricted-paths': ['error', {basePath: import.meta.dirname, zones: boundaryZones}],
        },
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
        plugins: {custom: customPlugin, 'import-classic': importPlugin},
        settings: {
            'import/resolver': {typescript: {project: './tsconfig.json'}},
        },
        rules: {
            'custom/file-naming': 'error',
            'import-classic/no-restricted-paths': ['error', {basePath: import.meta.dirname, zones: boundaryZones}],
        },
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
        'eslint.shared.mjs',
        'packages/contracts/scan-cleanup/nativeWire.generated.ts',
    ]},
    {
        plugins: {
            '@stylistic': stylistic,
            custom: customPlugin,
            'import-classic': importPlugin,
        },
        settings: {
            'import/resolver': {
                typescript: {
                    project: './tsconfig.json',
                },
            },
        },
        rules: {
            'import-classic/no-restricted-paths': ['error', {
                basePath: import.meta.dirname,
                zones: boundaryZones,
            }],
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
            // Keep shared package imports on their public entrypoints.
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
            'custom/app-tooltip-only': 'error',
            'custom/commonjs-named-imports': 'error',
            'custom/file-naming': 'error',
            'custom/no-core-correctness-timers': 'error',
            'custom/no-raw-red-presentation': 'error',
            'custom/no-direct-console-error': 'error',
            'custom/annotation-storage-public-access': 'error',
            'custom/pdfjs-import-boundary': 'error',
            'custom/platform-api-narrow-getter': 'error',
            'custom/contracts-node-runtime': 'error',
            'custom/workspace-format-comparison': 'error',
            'custom/component-directory-source': 'error',
            'custom/top-level-pdf-composable': 'error',
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
        files: ['tests/**/*'],
        rules: {
            'import-classic/no-restricted-paths': 'off',
            'custom/annotation-storage-public-access': 'off',
            'custom/pdfjs-import-boundary': 'off',
            'custom/platform-api-narrow-getter': 'off',
            'custom/contracts-node-runtime': 'off',
            'custom/workspace-format-comparison': 'off',
            'custom/component-directory-source': 'off',
            'custom/top-level-pdf-composable': 'off',
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
            'vue/prefer-true-attribute-shorthand': ['error', 'always'],
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
