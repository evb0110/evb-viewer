import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    PackageJson,
    SetRequired,
    Simplify,
} from 'type-fest';

interface IVitestProjectTestConfig {
    env?: Record<string, string>;
    exclude?: string[];
    fileParallelism?: boolean;
    globalSetup?: string[];
    hookTimeout?: number;
    include?: string[];
    maxWorkers?: number;
    name?: string;
    retry?: number | {
        condition?: RegExp;
        count?: number;
    };
    sequence?: {concurrent?: boolean};
    setupFiles?: string[];
    testTimeout?: number;
}

interface IVitestProjectConfig {
    plugins?: unknown[];
    test?: IVitestProjectTestConfig;
}

interface IVitestSharedConfigModule { vitestProjects: IVitestProjectConfig[] }

type TPackageJsonWithScripts = Simplify<SetRequired<PackageJson, 'scripts'>>;

const vitestProjectNames = {
    unitCore: 'unit-core',
    unitApp: 'unit-app',
    unitElectron: 'unit-electron',
    unitScripts: 'unit-scripts',
    unitPolicy: 'unit-policy',
    unitStaticArchitecture: 'unit-static-architecture',
    browserIntegration: 'browser-integration',
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

const unitCoreTestFiles = [
    'tests/unit/contracts/**/*.test.ts',
    'tests/unit/helpers/**/*.test.ts',
    'tests/unit/i18n/**/*.test.ts',
    'tests/unit/packages/**/*.test.ts',
    'tests/unit/pdf/**/*.test.ts',
    'tests/unit/pdf-core/**/*.test.ts',
    'tests/unit/pdf-viewer/**/*.test.ts',
    'tests/unit/server/**/*.test.ts',
];
const unitAppTestFiles = ['tests/unit/app/**/*.test.ts'];
const unitElectronTestFiles = [
    'tests/unit/e2e/**/*.test.ts',
    'tests/unit/electron/**/*.test.ts',
];
const unitScriptTestFiles = ['tests/unit/scripts/**/*.test.ts'];
const unitPolicyTestFiles = [
    'tests/unit/scripts/*Policy.test.ts',
    'tests/unit/scripts/electronE2eSmokeConfig.test.ts',
    'tests/unit/scripts/packageScripts.test.ts',
];

const electronE2ERegressionTestFiles = [
    'tests/e2e/electron/prBlockingSmoke.e2e.test.ts',
    'tests/e2e/electron/performanceProfileVisuals.e2e.test.ts',
    'tests/e2e/electron/startupHydration.e2e.test.ts',
    'tests/e2e/electron/recentFiles.e2e.test.ts',
    'tests/e2e/electron/viewerSmoke.e2e.test.ts',
    'tests/e2e/electron/djvuPrintHandoff.e2e.test.ts',
    'tests/e2e/electron/inactivePdfTabs.e2e.test.ts',
    'tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts',
    'tests/e2e/electron/annotationLifecycle.e2e.test.ts',
    'tests/e2e/electron/stampPicker.e2e.test.ts',
    'tests/e2e/electron/squigglyMarkup.e2e.test.ts',
];

const electronE2EBlockingSmokeTestFiles = [
    'tests/e2e/electron/blockingPdfSaveSmoke.e2e.test.ts',
    'tests/e2e/electron/prBlockingSmoke.e2e.test.ts',
    // Pins the scan-cleanup toolbar contract the packaged release verifier
    // relies on, so UI drift fails the change that introduces it instead of
    // a later release campaign.
    'tests/e2e/electron/scanCleanupToolbarContract.e2e.test.ts',
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
    'tests/e2e/electron/savePipeline.e2e.test.ts',
    'tests/e2e/electron/savePipelineBenchmark.e2e.test.ts',
    'tests/e2e/electron/issue124LifecycleAcceptance.e2e.test.ts',
];
const electronE2ENativeSaveReopenTestFiles = [
    'tests/e2e/electron/nativeSaveReopen.e2e.test.ts',
    'tests/e2e/electron/compactPageLabelsStructuralOperations.e2e.test.ts',
];
const electronE2EXlargePdfTestFiles = [
    'tests/e2e/electron/xlargeDocumentAcceptance.e2e.test.ts',
    'tests/e2e/electron/scanCleanupXlargeAcceptance.e2e.test.ts',
];
const electronE2ESearchMatchScrollTestFiles = ['tests/e2e/electron/searchMatchScrolling.e2e.test.ts'];

let importNonce = 0;

async function loadVitestSharedConfig(ci: string | undefined) {
    const previousCi = process.env.CI;

    try {
        if (ci === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = ci;
        }

        vi.resetModules();
        importNonce += 1;
        const configUrl = pathToFileURL(resolve('vitest.shared.config.ts'));
        configUrl.searchParams.set('retry-policy', importNonce.toString());
        const configModule = await import(/* @vite-ignore */ configUrl.href) as IVitestSharedConfigModule;
        return configModule;
    } finally {
        if (previousCi === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = previousCi;
        }
    }
}

function projectByName(
    config: IVitestSharedConfigModule,
    projectName: string,
) {
    const project = config.vitestProjects.find(candidate => candidate.test?.name === projectName);

    if (!project) {
        throw new Error(`Missing Vitest project: ${projectName}`);
    }

    return project;
}

function e2eProjectNames() {
    return [
        vitestProjectNames.electronE2ERegression,
        vitestProjectNames.electronE2EBlockingSmoke,
        vitestProjectNames.electronE2EDrawShapes,
        vitestProjectNames.electronE2ELargePdf,
        vitestProjectNames.electronE2ERapidNavigation,
        vitestProjectNames.electronE2EVisibleWindow,
        vitestProjectNames.electronE2EQuarantine,
        vitestProjectNames.electronE2ESavePipeline,
        vitestProjectNames.electronE2ENativeSaveReopen,
        vitestProjectNames.electronE2EXlargePdf,
        vitestProjectNames.electronE2ESearchMatchScroll,
    ];
}

async function readPackageJsonWithScripts(): Promise<TPackageJsonWithScripts> {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as PackageJson;
    if (!packageJson.scripts) {
        throw new Error('Missing package scripts');
    }

    return packageJson as TPackageJsonWithScripts;
}

describe('unit Vitest project topology', () => {
    it('keeps unit tests split by owner and policy lane', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const projectNames = config.vitestProjects.map(project => project.test?.name);

        expect(projectNames).not.toContain('unit');
        expect(projectByName(config, vitestProjectNames.unitCore).test?.include)
            .toEqual(unitCoreTestFiles);
        expect(projectByName(config, vitestProjectNames.unitCore).plugins)
            .toHaveLength(1);
        expect(projectByName(config, vitestProjectNames.unitApp).test?.include)
            .toEqual(unitAppTestFiles);
        expect(projectByName(config, vitestProjectNames.unitApp).plugins)
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ name: 'vite:vue' }),
                expect.objectContaining({ name: 'unplugin-auto-import' }),
            ]));
        expect(projectByName(config, vitestProjectNames.unitApp).test?.setupFiles)
            .toEqual(['tests/setup.ts']);
        expect(projectByName(config, vitestProjectNames.unitElectron).test?.include)
            .toEqual(unitElectronTestFiles);
        expect(projectByName(config, vitestProjectNames.unitScripts).test?.include)
            .toEqual(unitScriptTestFiles);
        expect(projectByName(config, vitestProjectNames.unitScripts).test?.exclude)
            .toEqual(expect.arrayContaining(unitPolicyTestFiles));
        expect(projectByName(config, vitestProjectNames.unitPolicy).test?.include)
            .toEqual(unitPolicyTestFiles);
        expect(projectByName(config, vitestProjectNames.unitStaticArchitecture).test?.include)
            .toContain('tests/unit/architecture/**/*.test.ts');
        expect(projectByName(config, vitestProjectNames.unitApp).test?.exclude)
            .toEqual(expect.arrayContaining(
                projectByName(config, vitestProjectNames.unitStaticArchitecture).test?.include ?? [],
            ));
        expect(projectByName(config, vitestProjectNames.browserIntegration).test?.include)
            .toEqual(['tests/integration/browser/**/*.test.ts']);
    });
});

describe('electron e2e Vitest project topology', () => {
    it('gives every ordinary Electron E2E project a canonical headless package route', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const packageJson = await readPackageJsonWithScripts();
        const packageScripts = packageJson.scripts;
        const electronProjects = config.vitestProjects
            .map(project => project.test?.name)
            .filter((name): name is string => name?.startsWith('e2e-') === true);
        const ordinaryProjects = electronProjects.filter(name => name !== 'e2e-visible-window');

        for (const projectName of ordinaryProjects) {
            if (projectName === 'e2e-quarantine') {
                expect(packageScripts['test:e2e:electron:quarantine'])
                    .toContain('pnpm exec tsx scripts/ci/runElectronQuarantine.ts');
                continue;
            }
            const routes = Object.entries(packageScripts)
                .filter((entry): entry is [
                    string,
                    string,
                ] => (
                    typeof entry[1] === 'string'
                    && entry[1].includes(`--no-build ${projectName}`)
                ));

            expect(routes, `missing shared headless runner route for ${projectName}`).not.toEqual([]);
            expect(routes.every(entry => (
                entry[1].includes('bash scripts/test-electron-e2e-headless.sh')
            ))).toBe(true);
        }

        const visibleProject = projectByName(config, 'e2e-visible-window');
        expect(visibleProject.test?.include).toEqual(electronE2EVisibleWindowTestFiles);
        for (const projectName of ordinaryProjects) {
            for (const visibleFile of electronE2EVisibleWindowTestFiles) {
                expect(projectByName(config, projectName).test?.include).not.toContain(visibleFile);
            }
        }
        expect(packageScripts['test:e2e:electron:visible-window'])
            .not.toContain('scripts/test-electron-e2e-headless.sh');
    });

    it('keeps local iteration retry-free and retries only marked infrastructure failures in CI', async () => {
        const localConfig = await loadVitestSharedConfig(undefined);
        const ciConfig = await loadVitestSharedConfig('true');
        const ciRetry = {
            condition: /\[INFRA\]/u,
            count: 2,
        };

        expect(e2eProjectNames().map(projectName => projectByName(localConfig, projectName).test?.retry))
            .toEqual(Array.from({ length: e2eProjectNames().length }, () => 0));
        expect(e2eProjectNames().map(projectName => projectByName(ciConfig, projectName).test?.retry))
            .toEqual(Array.from({ length: e2eProjectNames().length }, () => ciRetry));
    });

    it('keeps comprehensive diagnostics in the nightly regression project', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const regressionProject = projectByName(config, vitestProjectNames.electronE2ERegression);

        expect(regressionProject.test?.include).toEqual(electronE2ERegressionTestFiles);
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/blockingPdfSaveSmoke.e2e.test.ts');
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/drawShapeLifecycle.e2e.test.ts');
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts');
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/rapidPdfNavigation.e2e.test.ts');
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/pdfSkeletonNavigationDiagnostics.e2e.test.ts');
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/arnoldPdfOpenDiagnostics.e2e.test.ts');
        expect(regressionProject.test?.globalSetup).toEqual(['tests/e2e/electron/globalSetup.ts']);
        expect(regressionProject.test?.fileParallelism).toBe(false);
        expect(regressionProject.test?.maxWorkers).toBe(1);
        expect(regressionProject.test?.sequence).toEqual({ concurrent: false });
        expect(regressionProject.test?.testTimeout).toBe(90_000);
        expect(regressionProject.test?.hookTimeout).toBe(150_000);
    });

    it('keeps the PR blocking smoke short and separate from broad regression', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const blockingSmokeProject = projectByName(config, vitestProjectNames.electronE2EBlockingSmoke);
        const regressionProject = projectByName(config, vitestProjectNames.electronE2ERegression);

        expect(blockingSmokeProject.test?.include).toEqual(electronE2EBlockingSmokeTestFiles);
        expect(blockingSmokeProject.test?.include).not.toContain('tests/e2e/electron/viewerSmoke.e2e.test.ts');
        expect(blockingSmokeProject.test?.env).toMatchObject({EVB_PR_SMOKE_SCOPE: 'blocking'});
        expect(regressionProject.test?.env).toMatchObject({EVB_PR_SMOKE_SCOPE: 'pressure'});
        const mixedSmokeSource = await readFile('tests/e2e/electron/prBlockingSmoke.e2e.test.ts', 'utf8');
        expect(mixedSmokeSource).toContain('blockingIt(');
        expect(mixedSmokeSource).toContain('pressureIt(');
    });

    it('exposes opt-in e2e subsets as named projects instead of env-mutated includes', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const sharedConfigSource = await readFile('vitest.shared.config.ts', 'utf8');
        const packageJson = await readPackageJsonWithScripts();
        const packageScripts = packageJson.scripts;
        const largePdfSource = await readFile('tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts', 'utf8');

        expect(projectByName(config, vitestProjectNames.electronE2EDrawShapes).test?.include)
            .toEqual(electronE2EDrawShapeTestFiles);
        expect(projectByName(config, vitestProjectNames.electronE2ELargePdf).test?.include)
            .toEqual(electronE2ELargePdfTestFiles);
        expect(projectByName(config, vitestProjectNames.electronE2ERapidNavigation).test?.include)
            .toEqual(electronE2ERapidNavigationTestFiles);
        expect(projectByName(config, vitestProjectNames.electronE2EVisibleWindow).test?.include)
            .toEqual(electronE2EVisibleWindowTestFiles);
        expect(projectByName(config, vitestProjectNames.electronE2ESavePipeline).test?.include)
            .toEqual(electronE2ESavePipelineTestFiles);
        expect(projectByName(config, vitestProjectNames.electronE2ENativeSaveReopen).test?.include)
            .toEqual(electronE2ENativeSaveReopenTestFiles);
        expect(projectByName(config, vitestProjectNames.electronE2EXlargePdf).test?.include)
            .toEqual(electronE2EXlargePdfTestFiles);
        expect(projectByName(config, vitestProjectNames.electronE2ESearchMatchScroll).test?.include)
            .toEqual(electronE2ESearchMatchScrollTestFiles);

        for (const obsoleteEnvFlag of [
            'EVB_E2E_DRAW_SHAPES_EXTENDED',
            'EVB_E2E_LARGE_PDF_ANNOTATION_SAVE',
            'EVB_E2E_RAPID_PDF_NAVIGATION',
        ]) {
            expect(sharedConfigSource).not.toContain(obsoleteEnvFlag);
            expect(JSON.stringify(packageScripts)).not.toContain(obsoleteEnvFlag);
            expect(largePdfSource).not.toContain(obsoleteEnvFlag);
        }
        expect(packageScripts['test:e2e:electron:draw-shapes'])
            .toBe('pnpm run build:pdf-page-ops && pnpm run build:electron && EVB_PDF_PAGE_OPS_ENABLE=1 bash scripts/test-electron-e2e-headless.sh --no-build e2e-draw-shapes --reporter verbose');
        expect(packageScripts['test:e2e:electron:large']).toContain('pnpm run build:pdf-page-ops');
        expect(packageScripts['test:e2e:electron:large'])
            .toContain('EVB_PDF_PAGE_OPS_ENABLE=1 EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1 bash scripts/test-electron-e2e-headless.sh --no-build e2e-large-pdf --reporter verbose');
        expect(packageScripts['test:e2e:electron:rapid-navigation'])
            .toBe('pnpm run build:electron && bash scripts/test-electron-e2e-headless.sh --no-build e2e-rapid-navigation --reporter verbose');
        expect(packageScripts['test:e2e:electron:visible-window'])
            .toBe('pnpm run build:electron && vitest run --project e2e-visible-window --reporter verbose');
        expect(packageScripts['test:e2e:electron'])
            .toContain('pnpm run build:native:e2e');
        expect(packageScripts['test:e2e:electron'])
            .toContain('EVB_PDF_PAGE_OPS_ENABLE=1 bash scripts/test-electron-e2e-headless.sh --no-build e2e-regression');
        expect(packageScripts['test:e2e:electron:regression'])
            .toContain('pnpm run build:native:e2e');
        expect(packageScripts['test:e2e:electron:regression'])
            .toContain('EVB_PDF_PAGE_OPS_ENABLE=1 bash scripts/test-electron-e2e-headless.sh --no-build e2e-regression');
        expect(packageScripts['test:e2e:electron:smoke:no-build']).toBeUndefined();
        expect(packageScripts['test:e2e:electron:watch'])
            .toBe('bash scripts/test-electron-e2e-headless.sh --no-build e2e-regression --watch --reporter verbose');
    });

    it('keeps the large-PDF acceptance interaction on the generic hidden fixture', async () => {
        const largePdfSource = await readFile('tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts', 'utf8');
        const viewerCoreSource = await readFile('tests/e2e/electron/helpers/viewerCore.ts', 'utf8');
        const activationStart = viewerCoreSource.indexOf('async function tryActivateAnnotationsTab');
        const activationEnd = viewerCoreSource.indexOf(
            'export async function openAnnotationsTab',
            activationStart,
        );
        expect(activationStart).toBeGreaterThanOrEqual(0);
        expect(activationEnd).toBeGreaterThan(activationStart);
        const activationSource = viewerCoreSource.slice(activationStart, activationEnd);

        expect(largePdfSource).not.toContain('EVB_E2E_LARGE_PDF_WINDOW_MODE');
        expect(largePdfSource).not.toContain('windowMode');
        expect(largePdfSource).toContain('createElectronE2ESessionFixture({');
        expect(largePdfSource).toContain('state.annotationDirtyEntityCount === 0');
        expect(largePdfSource).toContain('.pdf-annotation-editor-layer');
        expect(largePdfSource).toContain('qpdfDictionaryContainsText(annotationObject, \'Contents\', expectedText)');
        expect(largePdfSource).not.toContain('qpdfObjectContainsText');
        expect(activationSource).toContain('await (target.tab as ElementHandle<Element>).click();');
        expect(activationSource).not.toContain('page.evaluate');
        expect(activationSource).not.toContain('dispatchEvent');
    });
});

describe('electron e2e quarantine Vitest project', () => {
    it('runs only the quarantine include group and lets the script own empty-lane handling', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const packageJson = await readPackageJsonWithScripts();
        const packageScripts = packageJson.scripts;
        const quarantineProject = projectByName(config, vitestProjectNames.electronE2EQuarantine);

        expect(quarantineProject.test?.include).toEqual(electronE2EQuarantineTestFiles);
        expect(quarantineProject.test?.exclude)
            .toEqual(expect.arrayContaining(electronE2EQuarantineOperatorDiagnosticFiles));
        expect(quarantineProject.test?.exclude)
            .toHaveLength(electronE2EQuarantineOperatorDiagnosticFiles.length);
        expect(packageScripts['test:e2e:electron:quarantine'])
            .toContain('pnpm exec tsx scripts/ci/runElectronQuarantine.ts');
        expect(packageScripts['test:e2e:electron:quarantine'])
            .not.toContain('--passWithNoTests');
    });

});
