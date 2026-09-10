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
    electronE2ERegression: 'e2e-regression',
    electronE2EBlockingSmoke: 'e2e-blocking-smoke',
    electronE2EDrawShapes: 'e2e-draw-shapes',
    electronE2ELargePdf: 'e2e-large-pdf',
    electronE2ERapidNavigation: 'e2e-rapid-navigation',
    electronE2EVisibleWindow: 'e2e-visible-window',
    electronE2EQuarantine: 'e2e-quarantine',
    electronE2ESavePipeline: 'e2e-save-pipeline',
    electronE2ENativeSaveReopen: 'e2e-native-save-reopen',
    electronE2EXlargePdf: 'e2e-xlarge-pdf',
    electronE2ESearchMatchScroll: 'e2e-search-match-scroll',
} as const;

const electronBundleStaticIntegrityTestFiles = ['tests/unit/electron/bundleIntegrity.test.ts'];
const browserIntegrationTestFiles = ['tests/integration/browser/**/*.test.ts'];
const landingUnitTestFiles = ['tests/unit/landing/**/*.test.ts'];
const unitPolicyTestFiles = ['tests/unit/scripts/*Policy.test.ts'];
const unitToolingTestFiles = [
    'tests/unit/scripts/windows-test/**/*.test.ts',
    'tests/unit/scripts/stress/**/*.test.ts',
];
export const staticArchitectureTestFiles = [
    'tests/unit/architecture/**/*.test.ts',
    'tests/unit/app/modules/pdf-viewer/runtime/sessions/pdfAnnotationSessionBehavior.test.ts',
    'tests/unit/app/platform/browserDocumentRecordOwnership.test.ts',
];

const electronE2ESmokeTestFiles = [
    'tests/e2e/electron/prBlockingSmoke.e2e.test.ts',
    'tests/e2e/electron/performanceProfileVisuals.e2e.test.ts',
    'tests/e2e/electron/startupHydration.e2e.test.ts',
    'tests/e2e/electron/recentFiles.e2e.test.ts',
    'tests/e2e/electron/viewerSmoke.e2e.test.ts',
    'tests/e2e/electron/djvuPrintHandoff.e2e.test.ts',
    'tests/e2e/electron/inactivePdfTabs.e2e.test.ts',
    'tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts',
    'tests/e2e/electron/annotationLifecycle.e2e.test.ts',
    'tests/e2e/electron/annotationControls.e2e.test.ts',
    'tests/e2e/electron/legacyNote350.e2e.test.ts',
    'tests/e2e/electron/interopVpsAcceptance.e2e.test.ts',
    'tests/e2e/electron/stampPicker.e2e.test.ts',
    'tests/e2e/electron/squigglyMarkup.e2e.test.ts',
];

// project8RecoveryCloseAcceptance is deliberately absent. It belongs to the
// save pipeline, which the electronE2ESavePipeline project already runs as a
// blocking push job, so listing it here made one save regression redden two
// blocking lanes and read as two independent failures.
const electronE2EBlockingSmokeTestFiles = [
    'tests/e2e/electron/annotationTextInteraction.e2e.test.ts',
    'tests/e2e/electron/annotationControls.e2e.test.ts',
    'tests/e2e/electron/blockingPdfSaveSmoke.e2e.test.ts',
    'tests/e2e/electron/prBlockingSmoke.e2e.test.ts',
    'tests/e2e/electron/scanCleanupToolbarContract.e2e.test.ts',
];
const electronE2ENativeSaveReopenTestFiles = [
    'tests/e2e/electron/nativeSaveReopen.e2e.test.ts',
    'tests/e2e/electron/compactPageLabelsStructuralOperations.e2e.test.ts',
];
const electronE2EDrawShapeTestFiles = [
    'tests/e2e/electron/annotationStrokeParity.e2e.test.ts',
    'tests/e2e/electron/drawShapeLifecycle.e2e.test.ts',
];
const electronE2ELargePdfTestFiles = [
    'tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts',
    'tests/e2e/electron/largePdfNativeAnnotationMatrix.e2e.test.ts',
    'tests/e2e/electron/largePdfNativePreview.e2e.test.ts',
    'tests/e2e/electron/nativePdfSplitPaneLifecycle.e2e.test.ts',
    'tests/e2e/electron/xlargeDocumentAcceptance.e2e.test.ts',
];
const electronE2ERapidNavigationTestFiles = [
    'tests/e2e/electron/rapidPdfNavigation.e2e.test.ts',
    'tests/e2e/electron/standardPdfFitModeContinuity.e2e.test.ts',
];
const electronE2EVisibleWindowTestFiles = [
    'tests/e2e/electron/visibleWindowLifecycle.e2e.test.ts',
    'tests/e2e/electron/macOsPrintAcceptance.e2e.test.ts',
];
const electronE2EQuarantineTestFiles = ['tests/e2e/electron/quarantine/**/*.e2e.test.ts'];
const electronE2EQuarantineOperatorDiagnosticFiles = [
    'tests/e2e/electron/quarantine/scanCleanupAppTruthProbe.e2e.test.ts',
    'tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts',
    'tests/e2e/electron/quarantine/scanCleanupUniformity.e2e.test.ts',
];
const electronE2ESavePipelineTestFiles = [
    'tests/e2e/electron/project8RecoveryCloseAcceptance.e2e.test.ts',
    'tests/e2e/electron/savePipeline.e2e.test.ts',
    'tests/e2e/electron/savePipelineBenchmark.e2e.test.ts',
    'tests/e2e/electron/issue124LifecycleAcceptance.e2e.test.ts',
];
const electronE2EXlargePdfTestFiles = [
    'tests/e2e/electron/xlargeDocumentAcceptance.e2e.test.ts',
    'tests/e2e/electron/scanCleanupXlargeAcceptance.e2e.test.ts',
];
const electronE2ESearchMatchScrollTestFiles = ['tests/e2e/electron/searchMatchScrolling.e2e.test.ts'];

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
            ...(name === vitestProjectNames.electronE2EBlockingSmoke
                ? {env: {EVB_PR_SMOKE_SCOPE: 'blocking'}}
                : {}),
            ...(name === vitestProjectNames.electronE2ERegression
                ? {env: {EVB_PR_SMOKE_SCOPE: 'pressure'}}
                : {}),
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
    createElectronE2ETestProject(vitestProjectNames.electronE2ERegression, electronE2ESmokeTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EBlockingSmoke, electronE2EBlockingSmokeTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EDrawShapes, electronE2EDrawShapeTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ELargePdf, electronE2ELargePdfTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ERapidNavigation, electronE2ERapidNavigationTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EVisibleWindow, electronE2EVisibleWindowTestFiles),
    createElectronE2ETestProject(
        vitestProjectNames.electronE2EQuarantine,
        electronE2EQuarantineTestFiles,
        {exclude: electronE2EQuarantineOperatorDiagnosticFiles},
    ),
    createElectronE2ETestProject(vitestProjectNames.electronE2ESavePipeline, electronE2ESavePipelineTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ENativeSaveReopen, electronE2ENativeSaveReopenTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EXlargePdf, electronE2EXlargePdfTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ESearchMatchScroll, electronE2ESearchMatchScrollTestFiles),
] satisfies TestProjectConfiguration[];
