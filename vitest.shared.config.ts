import type { TestProjectConfiguration } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import AutoImport from 'unplugin-auto-import/vite';
import Vue from '@vitejs/plugin-vue';
import { vitestResolveAlias } from './scripts/vitestResolveAlias';

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
    unitTooling: 'unit-tooling',
    unitPolicy: 'unit-policy',
    unitStaticArchitecture: 'unit-static-architecture',
    unitLanding: 'unit-landing',
    browserIntegration: 'browser-integration',
    nativeIntegration: 'native-integration',
    electronBundleStaticIntegrity: 'electron-bundle-static-integrity',
    electronE2ESmoke: 'e2e-smoke',
    electronE2EViewer: 'e2e-viewer',
    electronE2EAnnotations: 'e2e-annotations',
    electronE2ESavePipeline: 'e2e-save-pipeline',
    electronE2EDocuments: 'e2e-documents',
    electronE2EDrawShapes: 'e2e-draw-shapes',
    electronE2ECore: 'e2e-core',
    electronE2ELargePdf: 'e2e-large-pdf',
    electronE2EVisibleWindow: 'e2e-visible-window',
    electronE2EQuarantine: 'e2e-quarantine',
    electronE2ESearchMatchScroll: 'e2e-search-match-scroll',
    electronE2ECalibration: 'e2e-calibration',
} as const;

const electronBundleStaticIntegrityTestFiles = ['tests/unit/electron/bundleIntegrity.test.ts'];
const browserIntegrationTestFiles = ['tests/integration/browser/**/*.test.ts'];
const landingUnitTestFiles = ['tests/unit/landing/**/*.test.ts'];
const unitPolicyTestFiles = ['tests/unit/scripts/*Policy.test.ts'];
const unitToolingTestFiles = ['tests/unit/scripts/stress/**/*.test.ts'];
export const staticArchitectureTestFiles = [
    'tests/unit/architecture/**/*.test.ts',
    'tests/unit/app/modules/pdf-viewer/runtime/sessions/pdfAnnotationSessionBehavior.test.ts',
];

// Electron E2E lanes. Every lane but the manual ones runs as one shard of
// the required CI verdict (.github/workflows/ci.yml), so a file belongs to
// exactly one lane and lanes are sized to finish in about ten minutes on a
// hosted Linux runner. e2e-core takes every Electron E2E file no other lane
// names, so a new test file runs in CI without a config edit.
const electronE2EFile = (name: string) => `tests/e2e/electron/${name}.e2e.test.ts`;
export const electronE2ELanes = {
    [vitestProjectNames.electronE2ESmoke]: [
        'annotationTextInteraction',
        'annotationControls',
        'blockingPdfSaveSmoke',
        'scanCleanupToolbarContract',
    ].map(electronE2EFile),
    [vitestProjectNames.electronE2EViewer]: ['viewerSmoke'].map(electronE2EFile),
    [vitestProjectNames.electronE2EAnnotations]: [
        'annotationLifecycle',
        'squigglyMarkup',
        'stampPicker',
        'legacyNote350',
        'interopVpsAcceptance',
    ].map(electronE2EFile),
    [vitestProjectNames.electronE2ESavePipeline]: [
        'project8RecoveryCloseAcceptance',
        'savePipeline',
        'savePipelineBenchmark',
        'issue124LifecycleAcceptance',
        'compactPageLabelsStructuralOperations',
    ].map(electronE2EFile),
    [vitestProjectNames.electronE2EDocuments]: [
        'nativeSaveReopen',
        'prBlockingSmoke',
        'recentFiles',
    ].map(electronE2EFile),
    [vitestProjectNames.electronE2EDrawShapes]: [
        'drawShapeLifecycle',
        'annotationStrokeParity',
    ].map(electronE2EFile),
} as const;

// Manual and nightly lanes: large local fixtures, a visible window, the
// quarantine, the native search build, and calibration runs driven by hand
// on a reverted revision and on the current one.
const electronE2ELargePdfTestFiles = [
    'largePdfAnnotationSave',
    'largePdfNativeAnnotationMatrix',
    'largePdfNativePreview',
    'nativePdfSplitPaneLifecycle',
    'xlargeDocumentAcceptance',
].map(electronE2EFile);
const electronE2EVisibleWindowTestFiles = [
    'visibleWindowLifecycle',
    'macOsPrintAcceptance',
].map(electronE2EFile);
const electronE2EQuarantineTestFiles = ['tests/e2e/electron/quarantine/**/*.e2e.test.ts'];
const electronE2ESearchMatchScrollTestFiles = [electronE2EFile('searchMatchScrolling')];
const electronE2ECalibrationTestFiles = ['tests/e2e/electron/calibration/*Calibration.e2e.test.ts'];
const electronE2ECoreExclude = [
    ...Object.values(electronE2ELanes).flat(),
    ...electronE2ELargePdfTestFiles,
    ...electronE2EVisibleWindowTestFiles,
    ...electronE2ESearchMatchScrollTestFiles,
];

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
        excludeLanding = true,
        setupFiles,
    }: {
        autoImport?: boolean;
        vueComponents?: boolean;
        processCss?: boolean;
        exclude?: string[];
        excludeLanding?: boolean;
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
                ...(excludeLanding ? landingUnitTestFiles : []),
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

function createElectronE2ETestProject(
    name: string,
    include: string[],
    {exclude = []}: {exclude?: string[]} = {},
) {
    return {
        resolve: vitestResolveConfig,
        test: {
            name,
            include,
            ...(exclude.length > 0 ? {exclude} : {}),
            globalSetup: ['tests/e2e/electron/globalSetup.ts'],
            globals: false,
            fileParallelism: false,
            maxWorkers: 1,
            // Retry only session/fixture infrastructure failures. Assertion
            // and user-flow failures must remain visible to the quarantine
            // lane and to its manual-run review history.
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
            exclude: staticArchitectureTestFiles,
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
        { exclude: [
            ...unitPolicyTestFiles,
            ...unitToolingTestFiles,
        ] },
    ),
    createUnitTestProject(
        vitestProjectNames.unitTooling,
        unitToolingTestFiles,
    ),
    createUnitTestProject(
        vitestProjectNames.unitPolicy,
        unitPolicyTestFiles,
    ),
    createUnitTestProject(
        vitestProjectNames.unitLanding,
        landingUnitTestFiles,
        {
            excludeLanding: false,
            setupFiles: appUnitTestSetupFiles,
        },
    ),
    createUnitTestProject(
        vitestProjectNames.unitStaticArchitecture,
        staticArchitectureTestFiles,
    ),
    createBundleIntegrityTestProject(),
    ...Object.entries(electronE2ELanes).map(([
        name,
        files,
    ]) => createElectronE2ETestProject(name, [...files])),
    createElectronE2ETestProject(
        vitestProjectNames.electronE2ECore,
        ['tests/e2e/electron/*.e2e.test.ts'],
        {exclude: electronE2ECoreExclude},
    ),
    createElectronE2ETestProject(vitestProjectNames.electronE2ELargePdf, electronE2ELargePdfTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EVisibleWindow, electronE2EVisibleWindowTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EQuarantine, electronE2EQuarantineTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ESearchMatchScroll, electronE2ESearchMatchScrollTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ECalibration, electronE2ECalibrationTestFiles),
] satisfies TestProjectConfiguration[];
