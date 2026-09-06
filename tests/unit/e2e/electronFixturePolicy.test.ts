import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRef,
} from 'pdf-lib';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfNativePreviewRouting';
import { EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeImportLimit';
import { resolveE2EGlobalSetupSessionName } from '@tests/e2e/electron/resolveE2EGlobalSetupSessionName';
import {
    electronUserDataPath,
    sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    E2E_SESSION_START_TIMEOUT_MS,
    resolveDetachedSessionLaunch,
    resolveDetachedSessionReadyTimeoutMs,
} from '@scripts/electron-run/startSessionDetached';
import {
    E2E_RUN_ID_ENV,
    createE2ERunScopedSessionName,
} from '@scripts/electron-run/electronRunRunId';
import {
    assertE2ESessionName,
    isE2ESessionName,
    selectStaleE2ESessionDirs,
} from '@scripts/electron-run/electronRunE2ESessionPrune';
import {
    prunePreservedSessionArtifacts,
    shouldPreserveE2EArtifacts,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    cleanupRunFixtures,
    cleanupSessionFixtures,
    createLargeScannedFixturePdf,
    createMultiPageTextFixturePdf,
    type IFixtureDescribeSelector,
    resolveExactNativeLargePdfFixtureAvailability,
    resolveScannedFixturePageMarkerRgb,
    resolveDjvuFixturePath,
    resolveLargePdfFixtureAvailability,
    resolveNativeLargePdfFixtureAvailability,
    resolvePathFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    assertOcrPdfSemanticOutput,
    assertOcrResultApplied,
} from '@tests/e2e/electron/helpers/electronApiHelpers';

const ELECTRON_FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/electron');
const MAX_TRACKED_ELECTRON_BINARY_FIXTURE_BYTES = 2 * 1024 * 1024;

async function collectFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectFiles(path);
        }
        return entry.isFile() ? [path] : [];
    }));
    return files.flat();
}

function restoreEnvVar(name: string, previousValue: string | undefined) {
    if (previousValue === undefined) {
        Reflect.deleteProperty(process.env, name);
    } else {
        process.env[name] = previousValue;
    }
}

function createDescribeSelectorDouble() {
    const skipSelector = ((_name: string, _fn: () => void) => undefined) as IFixtureDescribeSelector;
    skipSelector.skip = skipSelector;

    const selector = ((_name: string, _fn: () => void) => undefined) as IFixtureDescribeSelector;
    selector.skip = skipSelector;
    return selector;
}

describe('Electron E2E fixture policy', () => {
    it('rejects an OCR consume result when the working-copy revision did not change', () => {
        expect(() => assertOcrResultApplied({token: 'revision-before'}, 'revision-before'))
            .toThrow('OCR result was not applied to the active working copy');
        expect(() => assertOcrResultApplied({token: 'revision-after'}, 'revision-before'))
            .not.toThrow();
    });

    it('opens an actionable Recent row from a sole empty tab without a close control', async () => {
        const source = await readFile(
            join(process.cwd(), 'tests/e2e/electron/recentFiles.e2e.test.ts'),
            'utf8',
        );

        expect(source).toContain('const startWhenPrewarmed = () =>');
        expect(source).not.toContain('if (prewarmAtMs === null) {\n            finish(null)');
        expect(source).not.toContain('if (!currentTabCloseButton || prewarmAtMs === null)');
    });

    it('keeps the inactive-DjVu pressure override ahead of the live sampler', async () => {
        const source = await readFile(
            join(process.cwd(), 'tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts'),
            'utf8',
        );

        expect(source).toContain('const pressureTimer = window.setInterval(applyPressure, 200)');
        expect(source).toContain('window.clearInterval(pressureTimer)');
        expect(source).toContain('tabs[1]?.getAttribute(\'aria-selected\') !== \'true\'');
        expect(source).toContain('const tabActivated =');
    });

    it('re-finds and centers a virtual thumbnail until the current item is ready', async () => {
        const source = await readFile(
            join(process.cwd(), 'tests/e2e/electron/helpers/splitPaneCloseContinuity.ts'),
            'utf8',
        );

        expect(source).toContain('const centerDelta =');
        expect(source).toContain('if (Math.abs(centerDelta) > 1)');
        expect(source).toContain('root.scrollTop += centerDelta');
    });

    it('serializes a complete settings payload for configured performance sessions', async () => {
        const source = await readFile(
            join(process.cwd(), 'tests/e2e/electron/helpers/startConfiguredElectronE2ESession.ts'),
            'utf8',
        );

        expect(source).toContain('serializeBrowserSettingsPayload({');
        expect(source).toContain('...DEFAULT_SETTINGS');
        expect(source).not.toContain('JSON.stringify({performanceMode: payload.performanceMode})');
    });

    it('dismisses Viewer Smoke scan guidance through the shared helper', async () => {
        const source = await readFile(
            join(process.cwd(), 'tests/e2e/electron/viewerSmoke.e2e.test.ts'),
            'utf8',
        );

        expect(source.match(/dismissScanCleanupFirstRunGuidance\(session\.page\)/gu)).toHaveLength(2);
        expect(source).not.toContain('=== \'Got it\'');
    });

    it('scopes the native image-combine override to the PNG-open restart', async () => {
        const source = await readFile(
            join(process.cwd(), 'tests/e2e/electron/viewerSmoke.e2e.test.ts'),
            'utf8',
        );
        const fixtureSource = await readFile(
            join(process.cwd(), 'tests/e2e/electron/helpers/createElectronE2ESessionFixture.ts'),
            'utf8',
        );

        expect(source.match(/EVB_PDF_IMAGE_COMBINE_ENABLE/gu)).toHaveLength(1);
        expect(source).toContain('EVB_PDF_IMAGE_COMBINE_ENABLE: \'1\'');
        expect(source).toContain('EVB_PDF_NATIVE_ASSEMBLER_ENABLE: \'1\'');
        expect(fixtureSource).toContain('if (clean && !hard && !restartOptions.extraEnv)');
        expect(fixtureSource).toContain('extraEnv: restartOptions.extraEnv');
    });

    it('labels thumbnail observations and reports the first bad frame', async () => {
        const source = await readFile(
            join(process.cwd(), 'tests/e2e/electron/viewerSmoke.e2e.test.ts'),
            'utf8',
        );

        expect(source).toContain('documentKind: \'PDF\'');
        expect(source).toContain('documentKind: \'DjVu\'');
        expect(source).toContain('firstBadFrame');
        expect(source).toContain('.every(page => page === 18)');
    });

    it('awaits the deferred highlight command before clearing selection', async () => {
        const source = await readFile(
            join(process.cwd(), 'tests/e2e/electron/helpers/viewerAnnotations.ts'),
            'utf8',
        );
        const start = source.indexOf('export async function createHighlightWithPdfjsManager');
        const end = source.indexOf('export async function waitForNoOpenNoteWindows', start);
        const helper = source.slice(start, end);

        expect(helper).toContain('await clickAnnotationTool(page, \'Highlight\')');
        expect(helper).toContain('await callWorkspaceCommand<boolean>(page, \'highlightSelection\')');
        expect(helper.indexOf('await callWorkspaceCommand<boolean>(page, \'highlightSelection\')'))
            .toBeLessThan(helper.lastIndexOf('document.getSelection()?.removeAllRanges()'));
    });

    it('rejects OCR completion artifacts that do not contain the expected semantic text', async () => {
        const outputPath = await createMultiPageTextFixturePdf('unit-ocr-semantic-output.pdf', 1);

        try {
            await expect(assertOcrPdfSemanticOutput(
                outputPath,
                'E2E Multi Page Fixture 1/1',
            )).resolves.toContain('E2E Multi Page Fixture 1/1');
            await expect(assertOcrPdfSemanticOutput(
                outputPath,
                'text that is not present',
            )).rejects.toThrow('OCR output did not contain expected semantic text');
        } finally {
            await rm(outputPath, {force: true});
        }
    });

    it('retains bounded failure evidence without keeping Electron profile or app copies', async () => {
        const sessionName = `e2e-unit-retained-artifacts-${process.pid}`;
        const root = sessionDir(sessionName);
        const screenshotPath = join(root, 'screenshots', 'failure.png');
        const logPath = join(root, 'session.log');

        try {
            await mkdir(join(root, 'electron-user-data'), {recursive: true});
            await mkdir(join(root, 'automation-electron-app'), {recursive: true});
            await mkdir(join(root, 'automation-electron-app-entry'), {recursive: true});
            await mkdir(join(root, 'screenshots'), {recursive: true});
            await writeFile(join(root, 'electron-user-data', 'Preferences'), 'profile');
            await writeFile(join(root, 'automation-electron-app', 'Electron'), 'app');
            await writeFile(join(root, 'automation-electron-app-entry', 'main.js'), 'entry');
            await writeFile(screenshotPath, 'screenshot');
            await writeFile(logPath, 'diagnostics');

            prunePreservedSessionArtifacts(sessionName);

            await expect(stat(screenshotPath)).resolves.toBeDefined();
            await expect(stat(logPath)).resolves.toBeDefined();
            await expect(stat(join(root, 'electron-user-data'))).rejects.toMatchObject({code: 'ENOENT'});
            await expect(stat(join(root, 'automation-electron-app'))).rejects.toMatchObject({code: 'ENOENT'});
            await expect(stat(join(root, 'automation-electron-app-entry'))).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('recognizes the documented CI artifact-retention values', () => {
        expect(shouldPreserveE2EArtifacts({EVB_E2E_PRESERVE_ARTIFACTS: '1'})).toBe(true);
        expect(shouldPreserveE2EArtifacts({EVB_E2E_PRESERVE_ARTIFACTS: 'yes'})).toBe(true);
        expect(shouldPreserveE2EArtifacts({EVB_E2E_PRESERVE_ARTIFACTS: '0'})).toBe(false);
        expect(shouldPreserveE2EArtifacts({})).toBe(false);
    });

    it('generates a scanned large-PDF fixture without constructing dense text layers', async () => {
        const outputPath = await createLargeScannedFixturePdf(
            'unit-large-scanned-policy.pdf',
            7,
            1024 * 1024,
        );

        try {
            expect((await stat(outputPath)).size).toBeGreaterThan(1024 * 1024);
            const parsed = await PDFDocument.load(await readFile(outputPath), { updateMetadata: false });
            expect(parsed.getPageCount()).toBe(7);
            expect(resolveScannedFixturePageMarkerRgb(1)).not.toEqual(
                resolveScannedFixturePageMarkerRgb(7),
            );
        } finally {
            await rm(outputPath, { force: true });
        }
    });

    it('keeps run-owned generated PDFs across session cleanup until their owner releases them', async () => {
        const owner = `unit-large-pdf-${process.pid}-${Date.now()}`;
        const outputPath = await createLargeScannedFixturePdf(
            'run-owned-large-scanned-policy.pdf',
            2,
            0,
            1,
            {runOwner: owner},
        );

        try {
            cleanupSessionFixtures(`e2e-unrelated-session-${process.pid}`);
            await expect(stat(outputPath)).resolves.toBeDefined();
            cleanupRunFixtures(owner);
            await expect(stat(outputPath)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            cleanupRunFixtures(owner);
        }
    });

    it('generates a valid sparse deterministic PDF at an exact requested size', async () => {
        const outputPath = join(process.cwd(), '.devkit/tmp/generated-large-pdf-policy.pdf');
        const { generateLargePdfE2eFixture } = await import('@scripts/generate-large-pdf-e2e-fixture.mjs');
        await mkdir(join(process.cwd(), '.devkit/tmp'), { recursive: true });

        try {
            await generateLargePdfE2eFixture({
                outputPath,
                pageCount: 7,
                targetBytes: 2 * 1024 * 1024,
            });

            expect((await stat(outputPath)).size).toBe(2 * 1024 * 1024);
            const parsed = await PDFDocument.load(await readFile(outputPath), { updateMetadata: false });
            expect(parsed.getPageCount()).toBe(7);
            const annotations = parsed.getPage(0).node.Annots();
            expect(annotations).toBeInstanceOf(PDFArray);
            const annotationRef = annotations?.get(0);
            expect(annotationRef).toBeInstanceOf(PDFRef);
            if (!(annotationRef instanceof PDFRef)) {
                throw new Error('Generated large-PDF fixture omitted its existing annotation');
            }
            const annotation = parsed.context.lookupMaybe(annotationRef, PDFDict);
            expect(annotation?.get(PDFName.of('Subtype'))?.toString()).toBe('/FreeText');
        } finally {
            await rm(outputPath, { force: true });
        }
    });

    it('reports an optional missing fixture once and returns the skipped suite selector', () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const describeLike = createDescribeSelectorDouble();

        try {
            const fixture = resolvePathFixtureAvailability({
                path: '.devkit/definitely-missing-fixture.pdf',
                label: 'missing unit-test',
                requiredEnvVar: 'EVB_UNIT_REQUIRE_MISSING_FIXTURE',
            });

            const firstSelector = selectFixtureDescribe(describeLike, fixture);
            const secondSelector = selectFixtureDescribe(describeLike, fixture);

            expect(firstSelector).toBe(describeLike.skip);
            expect(secondSelector).toBe(describeLike.skip);
            expect(infoSpy).toHaveBeenCalledTimes(1);
            expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('SKIPPED (fixture missing): missing unit-test fixture does not exist:'));
        } finally {
            infoSpy.mockRestore();
        }
    });

    it('fails during suite selection when the selected lane requires a missing fixture', () => {
        const previousValue = process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE;
        process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE = '1';
        const describeLike = createDescribeSelectorDouble();

        try {
            const fixture = resolvePathFixtureAvailability({
                path: '.devkit/definitely-missing-required-fixture.pdf',
                label: 'required unit-test',
                requiredEnvVar: 'EVB_UNIT_REQUIRE_MISSING_FIXTURE',
            });

            expect(() => selectFixtureDescribe(describeLike, fixture)).toThrow(
                /Required fixture missing: required unit-test fixture does not exist:/,
            );
        } finally {
            restoreEnvVar('EVB_UNIT_REQUIRE_MISSING_FIXTURE', previousValue);
        }
    });

    it('resolves DjVu smoke through explicit, tracked, or generated deterministic fixtures only', async () => {
        const generatedFixtureFactory = vi.fn(() => {
            throw new Error('the checked-in fixture must make host generators unnecessary');
        });
        const checkedInFixture = resolveDjvuFixturePath({
            env: {},
            generatedFixtureFactory,
        });
        expect(checkedInFixture).toMatchObject({
            path: join(
                process.cwd(),
                'tests',
                'fixtures',
                'djvu',
                'sources',
                'browser-boundary-501-pages.djvu',
            ),
            required: true,
        });
        expect((await stat(checkedInFixture.path!)).size).toBeGreaterThan(0);
        expect(generatedFixtureFactory).not.toHaveBeenCalled();

        const fixture = resolveDjvuFixturePath({
            corpusFixturePath: null,
            devkitFixtureDir: '.devkit/tmp/unit-missing-djvu/devkit',
            env: {},
            generate: false,
            trackedFixtureDir: '.devkit/tmp/unit-missing-djvu/tracked',
        });

        expect(fixture).toMatchObject({
            path: null,
            required: true,
        });
        expect(fixture.reason).toContain('EVB_E2E_DJVU_FIXTURE');
        expect(fixture.reason).toContain('djvu-fixtures/viewer-smoke.djvu');
        expect(fixture.reason).not.toContain('.devkit/pdfs');
        expect(() => selectFixtureDescribe(createDescribeSelectorDouble(), fixture)).toThrow(
            /Required fixture missing: DjVu fixture is not available/u,
        );

        const generatedFixturePath = join(process.cwd(), '.devkit/tmp/unit-missing-djvu/generated.djvu');
        await mkdir(join(process.cwd(), '.devkit/tmp/unit-missing-djvu'), { recursive: true });
        await writeFile(generatedFixturePath, 'generated fixture placeholder');
        try {
            const generated = resolveDjvuFixturePath({
                corpusFixturePath: null,
                devkitFixtureDir: '.devkit/tmp/unit-missing-djvu/devkit',
                env: {},
                generatedFixtureFactory: () => generatedFixturePath,
                trackedFixtureDir: '.devkit/tmp/unit-missing-djvu/tracked',
            });
            expect(generated).toMatchObject({
                path: generatedFixturePath,
                reason: `Using generated DjVu fixture: ${generatedFixturePath}`,
                required: true,
            });
        } finally {
            await rm(join(process.cwd(), '.devkit/tmp/unit-missing-djvu'), {
                force: true,
                recursive: true,
            });
        }
    });

    it('keeps native-preview and DjVu fixture binaries out of tracked oversized fixtures', async () => {
        const files = await collectFiles(ELECTRON_FIXTURE_ROOT);
        const offenders: string[] = [];

        for (const file of files) {
            const relativePath = file.replace(`${ELECTRON_FIXTURE_ROOT}/`, '');
            const size = (await stat(file)).size;
            if (
                /\.(?:pdf|djvu|djv)$/i.test(relativePath)
                && size > MAX_TRACKED_ELECTRON_BINARY_FIXTURE_BYTES
            ) {
                offenders.push(`${relativePath} (${size} bytes)`);
            }
            if (
                /\.(?:djvu|djv)$/i.test(relativePath)
                && !relativePath.startsWith('djvu-fixtures/')
            ) {
                offenders.push(`${relativePath} (DjVu fixtures must live under djvu-fixtures/)`);
            }
            if (
                relativePath.startsWith('large-pdf-fixtures/')
                && !relativePath.endsWith('.md')
            ) {
                offenders.push(`${relativePath} (large native-preview PDFs must stay local-only)`);
            }
        }

        expect(offenders).toEqual([]);
    });

    it('provisions its own oversized native-preview fixture instead of borrowing the annotation-save one', async () => {
        const undersizedPath = await createMultiPageTextFixturePdf('unit-native-preview-undersized.pdf', 1);
        const previousFixture = process.env.EVB_E2E_LARGE_PDF_FIXTURE;
        process.env.EVB_E2E_LARGE_PDF_FIXTURE = undersizedPath;

        try {
            const fixture = resolveNativeLargePdfFixtureAvailability();

            expect(fixture.path).not.toBeNull();
            expect(fixture.path).not.toBe(undersizedPath);
            expect(statSync(fixture.path!).size).toBeGreaterThanOrEqual(PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES);
            const describeLike = createDescribeSelectorDouble();
            expect(selectFixtureDescribe(describeLike, fixture)).toBe(describeLike);
        } finally {
            restoreEnvVar('EVB_E2E_LARGE_PDF_FIXTURE', previousFixture);
            await rm(undersizedPath, {force: true});
        }
    });

    it('resolves an annotation-save fixture inside its band without a manually supplied binary', () => {
        const previousFixture = process.env.EVB_E2E_LARGE_PDF_FIXTURE;
        delete process.env.EVB_E2E_LARGE_PDF_FIXTURE;

        try {
            const fixture = resolveLargePdfFixtureAvailability();

            expect(fixture.path).not.toBeNull();
            const size = statSync(fixture.path!).size;
            // Above the shape-scan cap the lane covers saving an unscannable shape layer.
            expect(size).toBeGreaterThan(EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES);
        } finally {
            restoreEnvVar('EVB_E2E_LARGE_PDF_FIXTURE', previousFixture);
        }
    });

    it('accepts an oversized annotation-save fixture because PDF.js remains the final viewer', async () => {
        const previousFixture = process.env.EVB_E2E_LARGE_PDF_FIXTURE;
        const previousRequire = process.env.EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE;
        const oversizedPath = resolveNativeLargePdfFixtureAvailability().path;
        expect(oversizedPath).not.toBeNull();
        process.env.EVB_E2E_LARGE_PDF_FIXTURE = oversizedPath!;

        try {
            process.env.EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE = '1';
            const fixture = resolveLargePdfFixtureAvailability();

            expect(fixture.path).toBe(oversizedPath);
            expect(selectFixtureDescribe(createDescribeSelectorDouble(), fixture)).toBeDefined();
        } finally {
            restoreEnvVar('EVB_E2E_LARGE_PDF_FIXTURE', previousFixture);
            restoreEnvVar('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE', previousRequire);
        }
    });

    it('routes exact native-preview acceptance to the configured large fixture', () => {
        const fixture = resolveExactNativeLargePdfFixtureAvailability({
            EVB_EXACT_FIXTURE_PROFILE: 'localZaliznyak882',
            EVB_E2E_LARGE_PDF_FIXTURE: 'tests/fixtures/electron/freetext-lifecycle-test.pdf',
        });

        expect(fixture).toEqual({
            path: join(process.cwd(), 'tests/fixtures/electron/freetext-lifecycle-test.pdf'),
            reason: `Using exact native-preview fixture: ${join(
                process.cwd(),
                'tests/fixtures/electron/freetext-lifecycle-test.pdf',
            )}`,
            required: true,
        });
    });

    it('fails closed when an exact native-preview fixture is not configured', () => {
        const fixture = resolveExactNativeLargePdfFixtureAvailability({EVB_EXACT_FIXTURE_PROFILE: 'localZaliznyak882'});

        expect(fixture.path).toBeNull();
        expect(fixture.required).toBe(true);
        expect(fixture.reason).toContain('EVB_E2E_LARGE_PDF_FIXTURE');
    });

});

describe('Electron E2E deterministic isolation policy', () => {
    it('keeps detached E2E readiness inside the caller startup deadline', () => {
        const innerTimeoutMs = resolveDetachedSessionReadyTimeoutMs('e2e');

        expect(innerTimeoutMs).toBeLessThan(E2E_SESSION_START_TIMEOUT_MS);
        expect(E2E_SESSION_START_TIMEOUT_MS - innerTimeoutMs).toBeGreaterThanOrEqual(10_000);
        expect(resolveDetachedSessionReadyTimeoutMs('dev')).toBe(120_000);
    });

    it('dispatches detached ownership through distinct executable commands', () => {
        const e2eLaunch = resolveDetachedSessionLaunch(
            'e2e',
            'e2e-unit-viewer',
            '/runtime/node',
            '/runtime/pnpm',
        );
        const devLaunch = resolveDetachedSessionLaunch(
            'dev',
            'developer-unit',
            '/runtime/node',
            '/runtime/pnpm',
        );

        expect(e2eLaunch).toEqual({
            args: [
                '--import',
                'tsx',
                'scripts/electron-run/ephemeralSessionEntry.ts',
                'e2e-unit-viewer',
            ],
            command: '/runtime/node',
        });
        expect(JSON.stringify(e2eLaunch)).not.toMatch(/devSupervisor|default|electron:run/u);
        expect(devLaunch).toEqual({
            args: [
                'electron:run',
                '--session=developer-unit',
                'start',
            ],
            command: '/runtime/pnpm',
        });
    });

    it('keeps shared renderer and requested default sessions run-scoped with separate profiles', () => {
        const env = {[E2E_RUN_ID_ENV]: 'coexistence'};
        const sharedRendererSession = resolveE2EGlobalSetupSessionName(env);
        const testSession = createE2ERunScopedSessionName('default', env);

        expect(sharedRendererSession).toBe('e2e-coexistence-shared-renderer');
        expect(testSession).toBe('e2e-coexistence-default');
        expect(isE2ESessionName(sharedRendererSession)).toBe(true);
        expect(isE2ESessionName(testSession)).toBe(true);
        expect(sessionDir(sharedRendererSession)).not.toBe(sessionDir('default'));
        expect(electronUserDataPath(testSession)).not.toBe(electronUserDataPath('default'));
    });

    it('never selects default developer artifacts for stale E2E pruning', () => {
        const selected = selectStaleE2ESessionDirs([
            {
                name: 'default',
                path: sessionDir('default'),
                mtimeMs: 0,
            },
            {
                name: 'e2e-old-run-viewer-smoke',
                path: sessionDir('e2e-old-run-viewer-smoke'),
                mtimeMs: 0,
            },
        ], {
            maxAgeMs: 1,
            nowMs: 10,
        });

        expect(selected.map(candidate => candidate.name)).toEqual(['e2e-old-run-viewer-smoke']);
    });

    it('refuses cleanup against the default developer session', () => {
        expect(() => assertE2ESessionName('default')).toThrow(/refused non-isolated session/u);
        expect(() => prunePreservedSessionArtifacts('default')).toThrow(/refused non-isolated session/u);
        expect(isE2ESessionName('e2e-')).toBe(false);
    });
});
