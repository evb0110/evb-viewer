import type { TestProjectConfiguration } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import AutoImport from 'unplugin-auto-import/vite';
import Vue from '@vitejs/plugin-vue';
import { vitestResolveAlias } from './scripts/vitestResolveAlias';
import {
    listNightlyElectronE2ELanes,
    listRequiredElectronE2ELanes,
} from './scripts/electron-e2e-lanes.mjs';

const vitestResolveConfig = { alias: vitestResolveAlias };

// Mirrors `css.preprocessorOptions.scss.additionalData` in `nuxt.config.ts`, with
// the `~` alias spelled out, so a component's `<style lang="scss">` block compiles
// under Vitest exactly as it does in the app build. Sass reads the path out of a
// quoted string, where a Windows separator would be an escape, so keep it posix.
const scssPreprocessorOptions = { additionalData: `@use "${
    fileURLToPath(new URL('app/assets/css/transitions', import.meta.url)).replaceAll('\\', '/')
}" as *;\n` };

const unitTestSetupFiles = ['tests/setup.ts'];
const appUnitTestSetupFiles = [
    ...unitTestSetupFiles,
    'tests/setupApp.ts',
];
export const unitSlowTestThresholdMs = 300;
export const electronE2ETeardownTimeoutMs = 30_000;

const vitestProjectNames = {
    unitCore: 'unit-core',
    unitApp: 'unit-app',
    unitElectron: 'unit-electron',
    unitScripts: 'unit-scripts',
    unitPolicy: 'unit-policy',
    browserIntegration: 'browser-integration',
    nativeIntegration: 'native-integration',
    electronBundleStaticIntegrity: 'electron-bundle-static-integrity',
} as const;

const electronBundleStaticIntegrityTestFiles = ['tests/unit/electron/bundleIntegrity.test.ts'];
const browserIntegrationTestFiles = ['tests/integration/browser/**/*.test.ts'];
const unitPolicyTestFiles = ['tests/unit/scripts/*Policy.test.ts'];

function createUnitAutoImportPlugin() {
    return AutoImport({
        imports: [
            'vue',
            { 'vue-i18n': ['useI18n'] },
        ],
        dirs: ['app/composables/**'],
    });
}

function createUnitTestProject(
    name: string,
    include: string[],
    {
        autoImport = false,
        vueComponents = false,
        processCss = false,
        exclude = [],
        setupFiles,
    }: {
        autoImport?: boolean;
        vueComponents?: boolean;
        processCss?: boolean;
        exclude?: string[];
        setupFiles?: string[];
    } = {},
) {
    return {
        plugins: [
            ...(vueComponents ? [Vue()] : []),
            ...(autoImport ? [createUnitAutoImportPlugin()] : []),
        ],
        resolve: vitestResolveConfig,
        ...(processCss ? {css: {preprocessorOptions: {scss: scssPreprocessorOptions}}} : {}),
        ...(name === vitestProjectNames.unitCore ? {esbuild: {tsconfigRaw: '{}'}} : {}),
        test: {
            name,
            include,
            exclude: [
                ...electronBundleStaticIntegrityTestFiles,
                ...exclude,
            ],
            globals: false,
            ...(processCss ? {css: true} : {}),
            setupFiles: setupFiles ?? unitTestSetupFiles,
        },
    } satisfies TestProjectConfiguration;
}

function createBundleIntegrityTestProject() {
    return {
        resolve: vitestResolveConfig,
        test: {
            name: vitestProjectNames.electronBundleStaticIntegrity,
            include: electronBundleStaticIntegrityTestFiles,
            globals: false,
            setupFiles: unitTestSetupFiles,
        },
    } satisfies TestProjectConfiguration;
}

function createElectronE2ETestProject({
    name,
    directory,
}: {
    name: string;
    directory: string;
}) {
    return {
        resolve: vitestResolveConfig,
        test: {
            name,
            include: [`${directory}/*.e2e.test.ts`],
            globalSetup: ['tests/e2e/electron/globalSetup.ts'],
            globals: false,
            fileParallelism: false,
            maxWorkers: 1,
            // Retry only session/fixture infrastructure failures, never an
            // assertion or user-flow failure.
            retry: process.env.CI
                ? {
                    condition: /\[INFRA\]/u,
                    count: 2,
                }
                : 0,
            testTimeout: 90_000,
            hookTimeout: 150_000,
            sequence: { concurrent: false },
        },
    } satisfies TestProjectConfiguration;
}

export const vitestProjects = [
    createUnitTestProject(
        vitestProjectNames.unitCore,
        [
            'tests/unit/contracts/**/*.test.ts',
            'tests/unit/helpers/**/*.test.ts',
            'tests/unit/i18n/**/*.test.ts',
            'tests/unit/packages/**/*.test.ts',
            'tests/unit/pdf/**/*.test.ts',
            'tests/unit/pdf-core/**/*.test.ts',
            'tests/unit/pdf-viewer/**/*.test.ts',
            'tests/unit/server/**/*.test.ts',
        ],
        { autoImport: true },
    ),
    createUnitTestProject(
        vitestProjectNames.nativeIntegration,
        ['tests/integration/native/**/*.test.ts'],
        {setupFiles: unitTestSetupFiles},
    ),
    createUnitTestProject(
        vitestProjectNames.browserIntegration,
        browserIntegrationTestFiles,
        {
            // Browser-integration specs mount real SFCs in a DOM environment and
            // hand the component's own rendered markup and its own compiled
            // styles to Chromium, so this project needs the app unit project's
            // Vue/auto-import/setup pipeline plus real CSS compilation.
            autoImport: true,
            vueComponents: true,
            processCss: true,
            setupFiles: appUnitTestSetupFiles,
        },
    ),
    createUnitTestProject(
        vitestProjectNames.unitApp,
        ['tests/unit/app/**/*.test.ts'],
        {
            autoImport: true,
            vueComponents: true,
            setupFiles: appUnitTestSetupFiles,
        },
    ),
    createUnitTestProject(
        vitestProjectNames.unitElectron,
        [
            'tests/unit/e2e/**/*.test.ts',
            'tests/unit/electron/**/*.test.ts',
        ],
    ),
    createUnitTestProject(
        vitestProjectNames.unitScripts,
        ['tests/unit/scripts/**/*.test.ts'],
        { exclude: [...unitPolicyTestFiles] },
    ),
    createUnitTestProject(
        vitestProjectNames.unitPolicy,
        unitPolicyTestFiles,
    ),
    createBundleIntegrityTestProject(),
    ...[
        ...listRequiredElectronE2ELanes(),
        ...listNightlyElectronE2ELanes(),
    ].map(createElectronE2ETestProject),
] satisfies TestProjectConfiguration[];
