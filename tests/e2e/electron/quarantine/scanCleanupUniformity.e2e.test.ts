import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {promisify} from 'node:util';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireRequestId} from '@contracts/shared';
import type {
    IScanCleanupOptions,
    TScanCleanupLayoutByPage,
} from '@contracts/electronApiScanCleanup';
import {
    decodeNativeScanCleanupOutputMetadataJson,
    decodeNativeScanCleanupPageMetadataJson,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type {TScanCleanupWarningEvent} from '@contracts/scan-cleanup/nativeProtocolV3';
import type * as TScanCleanupWarningEventsModule from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';
import {
    SCAN_CLEANUP_SETTINGS_FILE_NAME,
    createDefaultScanCleanupSettingsFile,
} from '@contracts/scanCleanupSettings';
import {scanCleanupPreviewLifecycle} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import {defaultDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults';
import type {IScanCleanupDetectionSubscriber} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    forgetWorkingCopyOriginalPath,
    setWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';
import {readPdfPageSizes} from '@evb/scan-cleanup/core/pdfPageSizes';
import type {IPdfPageSize} from '@evb/scan-cleanup/core/types';
import {SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {
    resolveCliNativeToolPath,
    runCliNativeToolCommand,
} from '@scripts/scanCleanupCliAdapters';
import {createE2ERunScopedSessionName} from '@scripts/electron-run/electronRunRunId';
import {
    electronUserDataPath,
    sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createMixedOrientationScannedFixturePdf,
    createRotatedScannedFixturePdf,
    createSmallCanvasScannedFixturePdf,
    createSpreadScannedFixturePdf,
    createUnequalSpreadScannedFixturePdf,
    createVariedContentScannedFixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {evaluateInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import type {IWorkspaceExposeProbeWindow} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    SCAN_CLEANUP_PARITY_CANVAS_DPI,
    SCAN_CLEANUP_PARITY_CASES,
    SCAN_CLEANUP_PARITY_EXACT_BOUNDARY_PAGE_POINTS,
    SCAN_CLEANUP_PARITY_OVER_CONSTRAINED_PAGE_POINTS,
    assertScanCleanupParityIdentities,
    assertScanCleanupParityReport,
    attributeScanCleanupParityWarningEvents,
    buildScanCleanupParityIdentities,
    buildScanCleanupParityReport,
    mapScanCleanupParityAnalysisRectToPdfPoints,
    normalizeScanCleanupParityCanvasPixelObservation,
    normalizeScanCleanupParityPointsObservation,
    presentScanCleanupParityPageSpaceRect,
    resolveScanCleanupParityCoverageGaps,
    type IScanCleanupParityCapturedWarningEvent,
    type IScanCleanupParityCase,
    type IScanCleanupParityEngineIdentity,
    type IScanCleanupParityFixtureIdentity,
    type IScanCleanupParityObservation,
    type IScanCleanupParityPathSubstitution,
    type TScanCleanupParityHalf,
    type TScanCleanupParityFixture,
} from '@tests/helpers/scanCleanupParityCorpus';

interface IWordLossReport {
    pages?: Array<{
        lostCount?: number;
        page?: number;
    }>;
    stampVerification?: {
        payload?: {effectiveOptions?: unknown;};
        status?: string;
    };
}

interface ILevel3StreamHash {
    bytes: number;
    sha256: string;
}

const execFileAsync = promisify(execFile);
const sourcePath = process.env.EVB_SCAN_CLEANUP_UNIFORMITY_SOURCE_PDF ?? '';
const pageCount = Number(process.env.EVB_SCAN_CLEANUP_UNIFORMITY_PAGE_COUNT ?? '0');
const uniformityEnabled = sourcePath !== '' && pageCount > 0;
const sessionName = createE2ERunScopedSessionName('scan-cleanup-uniformity');
const artifactRoot = resolve(
    process.env.EVB_SCAN_CLEANUP_UNIFORMITY_ARTIFACT_DIR
        ?? join(process.cwd(), '.devkit', 'test', 'scan-cleanup-uniformity'),
);
const cliOutputPath = join(artifactRoot, 'cli-cleaned.pdf');
const auditScript = resolve(process.cwd(), 'scripts/diagnostics/scan-cleanup-word-loss-audit.mjs');

const sessionFixture = uniformityEnabled
    ? (() => {
        rmSync(sessionDir(sessionName), {
            force: true,
            recursive: true,
        });
        mkdirSync(electronUserDataPath(sessionName), {recursive: true});
        const settings = createDefaultScanCleanupSettingsFile();
        settings.settings.binarization = 'sauvola';
        settings.settings.firstRunGuidanceDismissed = true;
        writeFileSync(
            join(electronUserDataPath(sessionName), SCAN_CLEANUP_SETTINGS_FILE_NAME),
            `${JSON.stringify(settings, null, 2)}\n`,
            'utf8',
        );
        return createElectronE2ESessionFixture({
            clean: false,
            sessionName,
            timeoutMs: 4_500_000,
        });
    })()
    : null;

async function runWordLossAudit(name: string, cleanedPath: string) {
    const reportPath = join(artifactRoot, `${name}-word-loss.json`);
    // Only the CLI writes a sibling summary; the app publishes no mapping
    // file, and the audit realigns locally without one.
    const mappingPath = `${cleanedPath}.summary.json`;
    await execFileAsync(process.execPath, [
        auditScript,
        '--source',
        sourcePath,
        '--cleaned',
        cleanedPath,
        ...(existsSync(mappingPath) ? [
            '--mapping',
            mappingPath,
        ] : []),
        '--out',
        reportPath,
        // This probe asserts app/CLI UNIFORMITY (stamp + streams), not word
        // preservation: acceptance2 carries known pre-existing crop-on header
        // losses that would fail --fail-on any identically on both sides.
        '--fail-on',
        'none',
        '--verify-stamp',
        '--workers',
        '1',
    ], {
        cwd: process.cwd(),
        maxBuffer: 4 * 1024 * 1024,
    });
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as IWordLossReport;
    expect(report.stampVerification?.status, `${name} provenance stamp`).toBe('valid');
    return report;
}

async function collectLevel3StreamHashes(name: string, pdfPath: string) {
    const directory = join(artifactRoot, 'level-3-streams', name);
    mkdirSync(directory, {recursive: true});
    const prefix = join(directory, 'stream');
    await execFileAsync(process.env.EVB_PDFIMAGES_PATH ?? 'pdfimages', [
        '-all',
        pdfPath,
        prefix,
    ], {cwd: process.cwd()});
    const names = readdirSync(directory)
        .filter(fileName => fileName.startsWith('stream-'))
        .sort();
    const hashes = names.map(fileName => {
        const bytes = readFileSync(join(directory, fileName));
        return {
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        } satisfies ILevel3StreamHash;
    });
    return hashes.sort((left, right) => (
        `${left.sha256}:${String(left.bytes)}`.localeCompare(`${right.sha256}:${String(right.bytes)}`)
    ));
}

// The automation renderer freezes for minutes at a stretch during document
// open and scan-cleanup classification (no GPU, software raster). A single
// puppeteer waitForFunction rides one CDP call and dies on protocolTimeout,
// so long waits poll with short independent evaluations that tolerate
// protocol errors and outlast the freeze.
async function pollPageUntil(
    label: string,
    timeoutMs: number,
    check: () => Promise<unknown>,
) {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    for (;;) {
        try {
            if (await check()) {
                return;
            }
            lastError = null;
        } catch (error) {
            lastError = error;
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${label}${lastError === null ? '' : `: ${String(lastError)}`}`);
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000));
    }
}

describe('scan cleanup app/CLI uniformity', () => {
    it.skipIf(!uniformityEnabled)(
        'keeps stamped effective options and Level-3 streams identical',
        async () => {
            expect(sessionFixture).not.toBeNull();
            if (!sessionFixture) {
                return;
            }
            expect(existsSync(sourcePath)).toBe(true);
            expect(statSync(sourcePath).size).toBeGreaterThan(0);
            mkdirSync(artifactRoot, {recursive: true});

            const session = sessionFixture.getSession();
            expect(session).toBeTruthy();
            if (!session) {
                return;
            }
            await openPdfInApp(session.page, sourcePath, 120_000);
            await waitForPdfLoaded(session.page, 120_000);
            await waitForViewerInteractive(session.page, 120_000);
            await pollPageUntil('interactive toolbar with the expected page count', 600_000, () => (
                evaluateInPage(session.page, (expectedPageCount: number) => {
                    const toolbar = (window as IWorkspaceExposeProbeWindow)
                        .__evbTestApi
                        ?.getActiveToolbarSnapshot?.();
                    return toolbar?.initialVisualReady === true
                        && toolbar.viewerCapabilities.pdfMutationActions === true
                        && toolbar.isOpeningDocument === false
                        && toolbar.totalPages === expectedPageCount;
                }, pageCount)
            ));

            await clickVisibleToolbarButton(session.page, 'Scan cleanup');
            await session.page.waitForSelector('.scan-cleanup-surface', {
                timeout: 10_000,
                visible: true,
            });
            // The thumbnail rail is virtualized: it renders only the visible
            // thumbnails, so the classified-overlay count never reaches the
            // document's page count without scrolling. One classified overlay
            // proves classification is live; the enabled primary action is the
            // detection-complete signal (runs wait for terminal detection).
            await pollPageUntil('a classified thumbnail and an enabled run action', 1_800_000, () => (
                evaluateInPage(session.page, () => {
                    const classified = document.querySelectorAll(
                        '.scan-thumbnail-overlay[data-classification]',
                    ).length;
                    const action = document.querySelector<HTMLButtonElement>(
                        '.scan-cleanup-toolbar-primary-action',
                    );
                    return classified >= 1 && Boolean(action) && !action!.disabled;
                })
            ));
            await session.page.click('.scan-cleanup-toolbar-primary-action');
            await pollPageUntil('the cleaned document to replace the source', 2_400_000, () => (
                evaluateInPage(session.page, (source: string) => {
                    const active = (window as IWorkspaceExposeProbeWindow)
                        .__evbTestApi
                        ?.readActiveWorkspaceStateValues?.(['originalPath']);
                    return typeof active?.originalPath === 'string'
                        && active.originalPath !== source
                        && active.originalPath.endsWith('— cleaned.pdf');
                }, sourcePath)
            ));

            const appOutputPath = await session.page.evaluate(() => (
                (window as IWorkspaceExposeProbeWindow)
                    .__evbTestApi
                    ?.readActiveWorkspaceStateValues?.(['originalPath'])?.originalPath
            )) as string;
            expect(existsSync(appOutputPath)).toBe(true);
            expect(statSync(appOutputPath).size).toBeGreaterThan(0);

            await execFileAsync(process.execPath, [
                '--import',
                'tsx',
                'scripts/scan-cleanup-convert.ts',
                '--source',
                sourcePath,
                '--out',
                cliOutputPath,
                '--binarization',
                'sauvola',
                '--parity',
            ], {
                cwd: process.cwd(),
                maxBuffer: 4 * 1024 * 1024,
            });
            expect(existsSync(cliOutputPath)).toBe(true);
            expect(statSync(cliOutputPath).size).toBeGreaterThan(0);

            const [
                appReport,
                cliReport,
            ] = await Promise.all([
                runWordLossAudit('app', appOutputPath),
                runWordLossAudit('cli', cliOutputPath),
            ]);
            expect(appReport.stampVerification?.payload?.effectiveOptions)
                .toEqual(cliReport.stampVerification?.payload?.effectiveOptions);

            const [
                appHashes,
                cliHashes,
            ] = await Promise.all([
                collectLevel3StreamHashes('app', appOutputPath),
                collectLevel3StreamHashes('cli', cliOutputPath),
            ]);
            expect(appHashes.length).toBeGreaterThan(0);
            expect(appHashes).toEqual(cliHashes);
            writeFileSync(
                join(artifactRoot, 'uniformity-report.json'),
                `${JSON.stringify({
                    app: {
                        outputPath: appOutputPath,
                        effectiveOptions: appReport.stampVerification?.payload?.effectiveOptions,
                        level3StreamHashes: appHashes,
                    },
                    cli: {
                        outputPath: cliOutputPath,
                        effectiveOptions: cliReport.stampVerification?.payload?.effectiveOptions,
                        level3StreamHashes: cliHashes,
                    },
                }, null, 2)}\n`,
                'utf8',
            );
        },
        4_500_000,
    );
});

type TScanCleanupWarningEventFormatter
    = typeof TScanCleanupWarningEventsModule.formatScanCleanupWarningEvent;

/**
 * SC-IMP-003 events are typed records inside the process that raises them and
 * sentences everywhere else. Preview runs in this process, so wrapping the one
 * formatter every preview condition passes through — the shared policy the
 * renderer's text already comes from — reads the code and its parameters
 * without decoding a sentence back into a condition. The wrapper delegates to
 * the real formatter, so what preview publishes is unchanged, and each
 * published sentence is matched back to the event that produced it by
 * `attributeScanCleanupParityWarningEvents`.
 */
const {
    previewWarningEventCapture,
    warningEventFormatter,
} = vi.hoisted(() => ({
    previewWarningEventCapture: [] as IScanCleanupParityCapturedWarningEvent[],
    // The corpus reconstructs sentences the engine already published instead of
    // reading them, so it needs the same formatter without its own calls
    // landing in the preview capture. The mock factory is the only place that
    // holds the unwrapped function, so it hands it back here.
    warningEventFormatter: {current: null as TScanCleanupWarningEventFormatter | null},
}));

vi.mock('@evb/scan-cleanup/core/policy/scanCleanupWarningEvents', async importOriginal => {
    const actual = await importOriginal<typeof TScanCleanupWarningEventsModule>();
    warningEventFormatter.current = actual.formatScanCleanupWarningEvent;
    return {
        ...actual,
        formatScanCleanupWarningEvent: (event: TScanCleanupWarningEvent, pageNumber?: number) => {
            const formatted = actual.formatScanCleanupWarningEvent(event, pageNumber);
            previewWarningEventCapture.push({
                event,
                formatted,
            });
            return formatted;
        },
    };
});

/**
 * The native output artifact as written to the evidence directory: the decoded
 * protocol record plus the applied margins the engine reports beside it.
 */
type TNativeOutputArtifact = ReturnType<typeof decodeNativeScanCleanupOutputMetadataJson> & {
    sourceDpi?: number | null;
    appliedMargins?: {
        leftPx: number;
        topPx: number;
        rightPx: number;
        bottomPx: number;
    };
};

interface ISplitInstructionOutput {
    cropRect: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    contentTransform?: {
        scale: number;
        translateX: number;
        translateY: number;
    };
}

interface ISplitInstructionsPage {
    sourcePageIndex: number;
    outputs: ISplitInstructionOutput[];
}

interface ISplitInstructionsFile {pages: ISplitInstructionsPage[];}

interface ICorpusCliSummary {
    conversionSummary: {
        warnings: string[];
        warningEvents?: Array<{
            event: TScanCleanupWarningEvent;
            pageNumber?: number;
            half?: TScanCleanupParityHalf;
        }>;
    };
    perPageStreamSizes: Array<{
        sourcePageNumber: number;
        outputOrdinal: number;
        sourceDpi: number | null;
    }>;
}

const corpusEnabled = process.env.EVB_SCAN_CLEANUP_PARITY_CORPUS === '1';
const corpusRoot = join(artifactRoot, 'parity-corpus');
const convertScript = resolve(process.cwd(), 'scripts/scan-cleanup-convert.ts');

const CORPUS_FIXTURE_PAGE_COUNTS: Record<TScanCleanupParityFixture, number> = {
    'varied-content': 2,
    rotated: 4,
    spread: 1,
    'unequal-spread': 1,
    'mixed-orientation': 2,
    'small-canvas-exact': 2,
    'small-canvas-over': 2,
};

const corpusFixtureFiles: Record<TScanCleanupParityFixture, string> = {
    'varied-content': 'parity-varied-content.pdf',
    rotated: 'parity-rotated.pdf',
    spread: 'parity-spread.pdf',
    'unequal-spread': 'parity-unequal-spread.pdf',
    'mixed-orientation': 'parity-mixed-orientation.pdf',
    'small-canvas-exact': 'parity-small-canvas-exact.pdf',
    'small-canvas-over': 'parity-small-canvas-over.pdf',
};

/**
 * Every corpus fixture is scanned at the corpus canvas DPI so that detection,
 * the preview render and the final render share one pixel grid: a content box
 * measured on a different grid would move placement without any fitter
 * disagreeing.
 */
async function provisionCorpusFixture(fixture: TScanCleanupParityFixture) {
    const fileName = corpusFixtureFiles[fixture];
    const dpi = SCAN_CLEANUP_PARITY_CANVAS_DPI;
    switch (fixture) {
        case 'varied-content':
            return createVariedContentScannedFixturePdf(fileName, 2, dpi);
        case 'rotated':
            return createRotatedScannedFixturePdf(fileName, dpi);
        case 'spread':
            return createSpreadScannedFixturePdf(fileName, 1, dpi);
        case 'unequal-spread':
            return createUnequalSpreadScannedFixturePdf(fileName, 1, dpi);
        case 'mixed-orientation':
            return createMixedOrientationScannedFixturePdf(fileName, 2, dpi);
        case 'small-canvas-exact':
            return createSmallCanvasScannedFixturePdf(
                fileName,
                SCAN_CLEANUP_PARITY_EXACT_BOUNDARY_PAGE_POINTS.widthPoints,
                SCAN_CLEANUP_PARITY_EXACT_BOUNDARY_PAGE_POINTS.heightPoints,
                dpi,
            );
        case 'small-canvas-over':
            return createSmallCanvasScannedFixturePdf(
                fileName,
                SCAN_CLEANUP_PARITY_OVER_CONSTRAINED_PAGE_POINTS.widthPoints,
                SCAN_CLEANUP_PARITY_OVER_CONSTRAINED_PAGE_POINTS.heightPoints,
                dpi,
            );
    }
}

function fileIdentity(path: string) {
    const bytes = readFileSync(path);
    return {
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
}

/**
 * The override is stubbed rather than assigned so the opt-in run leaves the
 * process it borrowed exactly as it found it, including when an exceedance
 * ends the test early.
 */
function pinCorpusEngine(
    binaryName: string,
    crateName: string,
    envVar: string,
): IScanCleanupParityEngineIdentity {
    const override = process.env[envVar]?.trim() ?? '';
    const resolved = override === ''
        ? resolveCliNativeToolPath(binaryName, crateName, process.cwd())
        : override;
    expect(resolved, `${binaryName} binary`).not.toBeNull();
    vi.stubEnv(envVar, resolved!);
    return {
        binaryName,
        path: resolved!,
        ...fileIdentity(resolved!),
    };
}

function corpusLayoutByPage(parityCase: IScanCleanupParityCase, pageCount: number) {
    const classification = parityCase.layoutMode === 'force-two-page'
        ? 'two-page-spread'
        : 'single-uncut-page';
    return Object.fromEntries(Array.from({length: pageCount}, (_value, index) => [
        String(index + 1),
        classification,
    ])) as TScanCleanupLayoutByPage;
}

function corpusOptions(parityCase: IScanCleanupParityCase, preserveOriginalQuality: boolean): IScanCleanupOptions {
    return {
        preserveOriginalQuality,
        layoutMode: parityCase.layoutMode,
        outputMode: 'bw',
        readingOrder: 'ltr',
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: parityCase.pageAlignment,
        marginsMm: parityCase.marginsMm,
        despeckle: false,
        skipBlankPages: false,
        pageOverrides: {},
    };
}

async function runCorpusConversion(
    parityCase: IScanCleanupParityCase,
    fixturePath: string,
    quality: 'raster' | 'lossless',
) {
    const caseDir = join(corpusRoot, parityCase.id);
    const evidenceDir = join(caseDir, `${quality}-evidence`);
    const outputPath = join(caseDir, `${quality}.pdf`);
    rmSync(evidenceDir, {
        force: true,
        recursive: true,
    });
    mkdirSync(evidenceDir, {recursive: true});
    const {marginsMm} = parityCase;
    await execFileAsync(process.execPath, [
        '--import',
        'tsx',
        convertScript,
        '--source',
        fixturePath,
        '--out',
        outputPath,
        '--margins-mm',
        [
            marginsMm.leftMm,
            marginsMm.topMm,
            marginsMm.rightMm,
            marginsMm.bottomMm,
        ].map(value => String(value)).join(','),
        '--layout-mode',
        parityCase.layoutMode,
        // One representation for every page of every case: placement is what
        // this corpus measures, and the evidence channel the run publishes it
        // through needs a bilevel plane on the page it snapshots.
        '--output-mode',
        'bw',
        // Without parity the CLI assembles with its own fallback writers, and
        // the placement the oracle then reads is not the placement the product
        // ships.
        '--parity',
        ...(quality === 'lossless' ? ['--preserve-original-quality'] : []),
        // The evidence directory is how the run publishes the native output
        // metadata and the lossless split instructions this oracle reads; the
        // CLI only enables it together with a mask page.
        '--diagnostic-evidence-dir',
        evidenceDir,
        '--diagnostic-mask-pages',
        '1',
    ], {
        cwd: process.cwd(),
        maxBuffer: 8 * 1024 * 1024,
    });
    const summary = JSON.parse(
        readFileSync(`${outputPath}.summary.json`, 'utf8'),
    ) as ICorpusCliSummary;
    return {
        evidenceDir: join(evidenceDir, 'native'),
        outputPath,
        summary,
    };
}

async function readCorpusPageSizes(parityCase: IScanCleanupParityCase, fixturePath: string) {
    const pageOpsBinary = resolveCliNativeToolPath('evb-pdf-page-ops', 'pdf-page-ops', process.cwd());
    const pdfinfoBinary = resolveCliNativeToolPath('pdfinfo', 'poppler', process.cwd());
    expect(pageOpsBinary ?? pdfinfoBinary, 'a tool that can read page geometry').not.toBeNull();
    return readPdfPageSizes(fixturePath, {
        ...(pageOpsBinary === null ? {} : {pdfPageOpsBinary: pageOpsBinary}),
        ...(pdfinfoBinary === null ? {} : {pdfinfoBinary}),
        tempDir: join(corpusRoot, parityCase.id),
        log: () => undefined,
        runCommand: runCliNativeToolCommand,
    });
}

function readRasterObservations(
    parityCase: IScanCleanupParityCase,
    nativeEvidenceDir: string,
    summary: ICorpusCliSummary,
    pageSizes: readonly IPdfPageSize[],
) {
    const outputs = readdirSync(nativeEvidenceDir)
        .map(name => /^clean-(\d+)-(\d+)\.json$/u.exec(name))
        .filter((match): match is RegExpExecArray => match !== null)
        .map(match => ({
            fileName: match[0],
            sourcePageNumber: Number(match[1]),
            outputOrdinal: Number(match[2]),
        }))
        .sort((left, right) => left.sourcePageNumber - right.sourcePageNumber
            || left.outputOrdinal - right.outputOrdinal);
    expect(outputs.length, `${parityCase.id} raster outputs`).toBeGreaterThan(0);
    return outputs.map(output => {
        const metadata = decodeNativeScanCleanupOutputMetadataJson(
            readFileSync(join(nativeEvidenceDir, output.fileName), 'utf8'),
        ) as TNativeOutputArtifact;
        return normalizeScanCleanupParityCanvasPixelObservation({
            caseId: parityCase.id,
            path: 'raster-final',
            canvasGrid: 'raster-canvas',
            sourcePageNumber: output.sourcePageNumber,
            outputOrdinal: output.outputOrdinal,
            sourceRotationDegrees: pageSizes[output.sourcePageNumber - 1]?.rotation ?? 0,
            requestedMarginsMm: parityCase.marginsMm,
            requestedAlignment: parityCase.pageAlignment,
            metadata: {
                ...metadata,
                sourceDpi: metadata.sourceDpi ?? summary.perPageStreamSizes.find(
                    page => page.sourcePageNumber === output.sourcePageNumber,
                )?.sourceDpi ?? null,
            },
            publishesTypedWarningEvents: true,
        });
    });
}

/**
 * The sentence for a condition the run published, formatted from the run's own
 * typed event rather than searched for in its text. Every condition a scan
 * cleanup run raises now travels beside its sentence as an event, so the corpus
 * reads the code and lets the shared policy produce the words.
 */
function formatCorpusWarningEvent(entry: {
    event: TScanCleanupWarningEvent;
    pageNumber?: number;
}) {
    const format = warningEventFormatter.current;
    if (format === null) {
        throw new Error('The scan-cleanup warning policy mock did not publish its formatter');
    }
    return format(entry.event, entry.pageNumber);
}

/**
 * The conditions a run reported about one produced output.
 *
 * A condition the run attributed to a page and a half is a condition about that
 * output, which is exactly what the raster engine writes into that output's own
 * artifact. Document-wide conditions and conditions about a page as a whole are
 * recorded by the run but belong to no output, so neither path compares them
 * here and neither can invent a disagreement out of one.
 */
function readCorpusOutputWarningEvents(
    summary: ICorpusCliSummary,
    sourcePageNumber: number,
    half: TScanCleanupParityHalf,
) {
    const entries = (summary.conversionSummary.warningEvents ?? []).filter(
        entry => entry.pageNumber === sourcePageNumber && entry.half === half,
    );
    return {
        warningEvents: entries.map(entry => entry.event),
        warningMessages: entries.map(entry => formatCorpusWarningEvent(entry)),
    };
}

function readLosslessObservations(
    parityCase: IScanCleanupParityCase,
    nativeEvidenceDir: string,
    summary: ICorpusCliSummary,
    pageSizes: readonly IPdfPageSize[],
) {
    const instructionsPath = join(nativeEvidenceDir, 'split-pages.json');
    if (!existsSync(instructionsPath)) {
        // Why the assembler never ran is the run's own condition, read by code.
        const resampled = (summary.conversionSummary.warningEvents ?? []).find(
            entry => entry.event.code === 'matched-canvas-pages-resampled',
        );
        // Matched page size re-renders any page that cannot reach the shared
        // pixel grid losslessly, and such a run never reaches the lossless
        // assembler. The case keeps its other two paths and the report says
        // why the third is absent.
        return {
            observations: [],
            substitution: {
                caseId: parityCase.id,
                path: 'lossless-final' as const,
                reason: resampled === undefined
                    ? 'The lossless assembler did not run for this document'
                    : formatCorpusWarningEvent(resampled),
            },
        };
    }
    const instructions = JSON.parse(readFileSync(instructionsPath, 'utf8')) as ISplitInstructionsFile;
    const observations = instructions.pages.flatMap(page => {
        const sourcePageNumber = page.sourcePageIndex + 1;
        const analysis = decodeNativeScanCleanupPageMetadataJson(readFileSync(
            join(nativeEvidenceDir, `analysis-${String(sourcePageNumber)}.json`),
            'utf8',
        ));
        const pageSize = pageSizes[sourcePageNumber - 1];
        expect(pageSize, `${parityCase.id} page ${String(sourcePageNumber)} geometry`).toBeTruthy();
        return page.outputs.map((output, outputOrdinal) => {
            const analysisOutput = analysis.outputs?.[outputOrdinal];
            expect(
                analysisOutput,
                `${parityCase.id} page ${String(sourcePageNumber)} analysis output ${String(outputOrdinal)}`,
            ).toBeTruthy();
            // The assembler consumes the analysed crop in the page's own user
            // space. The oracle derives that projection itself, from the page
            // geometry the document declares, so an assembler that projects the
            // crop wrongly is a disagreement this corpus can report rather than
            // one it inherits.
            const contentPdf = mapScanCleanupParityAnalysisRectToPdfPoints(
                analysisOutput!.cropRect,
                analysisOutput!.inputWidthPx,
                analysisOutput!.inputHeightPx,
                analysis.rotationDegrees,
                pageSize!,
            );
            const transform = output.contentTransform;
            const pageSpaceContent = transform === undefined
                ? {
                    x: contentPdf.x - output.cropRect.x,
                    y: contentPdf.y - output.cropRect.y,
                    width: contentPdf.width,
                    height: contentPdf.height,
                }
                : {
                    x: (contentPdf.x * transform.scale) + transform.translateX,
                    y: (contentPdf.y * transform.scale) + transform.translateY,
                    width: contentPdf.width * transform.scale,
                    height: contentPdf.height * transform.scale,
                };
            const presented = presentScanCleanupParityPageSpaceRect(
                {
                    width: output.cropRect.width,
                    height: output.cropRect.height,
                },
                pageSpaceContent,
                pageSize!.rotation + analysis.rotationDegrees,
            );
            return normalizeScanCleanupParityPointsObservation({
                caseId: parityCase.id,
                sourcePageNumber,
                outputOrdinal,
                half: analysisOutput!.half,
                sourceRotationDegrees: pageSize!.rotation,
                rotationDegrees: analysis.rotationDegrees,
                sourceDpi: summary.perPageStreamSizes.find(
                    entry => entry.sourcePageNumber === sourcePageNumber,
                )?.sourceDpi ?? null,
                canvasDpi: SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                requestedMarginsMm: parityCase.marginsMm,
                requestedAlignment: parityCase.pageAlignment,
                ...presented,
                ...readCorpusOutputWarningEvents(
                    summary,
                    sourcePageNumber,
                    analysisOutput!.half,
                ),
            });
        });
    });
    return {
        observations,
        substitution: null,
    };
}

async function readPreviewObservations(
    parityCase: IScanCleanupParityCase,
    fixturePath: string,
    pageCount: number,
    pageSizes: readonly IPdfPageSize[],
    registeredWorkingCopies: Set<string>,
) {
    // Preview only renders documents the owner opened. The corpus registers the
    // fixture as its own working copy, which is what an opened document is
    // before any edit materializes a separate copy. The registration is
    // recorded so the run can retire it again.
    registeredWorkingCopies.add(fixturePath);
    await setWorkingCopyOriginalPath(fixturePath, fixturePath, 1, {backingState: 'eager'});
    const service = scanCleanupPreviewLifecycle(defaultDependencies);
    // The preview service only needs an identity, a destroyed check and the
    // listener hooks it unbinds on dispose: a corpus run awaits each preview
    // and consumes no streamed detection events.
    const subscriber: IScanCleanupDetectionSubscriber = {
        id: 1,
        isDestroyed: () => false,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
    };
    try {
        const observations: IScanCleanupParityObservation[] = [];
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
            previewWarningEventCapture.length = 0;
            const result = await service.preview(subscriber, {
                ownerId: `parity-${parityCase.id}`,
                documentRevision: `${parityCase.id}-revision`,
                requestId: requireRequestId(`${parityCase.id}-page-${String(pageNumber)}`),
                sourcePdfPath: fixturePath,
                pageNumber: requirePageNumber(pageNumber),
                options: corpusOptions(parityCase, true),
                layoutByPage: corpusLayoutByPage(parityCase, pageCount),
                layoutDetectionComplete: true,
            });
            expect(
                'outputs' in result,
                `${parityCase.id} preview page ${String(pageNumber)}`,
            ).toBe(true);
            const outputs = 'outputs' in result ? result.outputs : [];
            for (const [
                outputOrdinal,
                output,
            ] of outputs.entries()) {
                observations.push(normalizeScanCleanupParityCanvasPixelObservation({
                    caseId: parityCase.id,
                    path: 'preview',
                    canvasGrid: 'preview-raster',
                    sourcePageNumber: pageNumber,
                    outputOrdinal,
                    sourceRotationDegrees: pageSizes[pageNumber - 1]?.rotation ?? 0,
                    requestedMarginsMm: parityCase.marginsMm,
                    requestedAlignment: parityCase.pageAlignment,
                    metadata: {
                        ...output.metadata,
                        // Preview reaches the renderer as sentences, so the
                        // typed events come from the formatter capture. They
                        // supersede any events the metadata carried: the
                        // capture holds the engine's events and the ones
                        // Electron itself raised, each taken by the sentence it
                        // produced rather than by its place in the queue.
                        warningEvents: attributeScanCleanupParityWarningEvents(
                            previewWarningEventCapture,
                            output.metadata.warnings,
                        ),
                    },
                    publishesTypedWarningEvents: true,
                }));
            }
            expect(
                previewWarningEventCapture,
                `${parityCase.id} preview page ${String(pageNumber)} unattributed warning events`,
            ).toHaveLength(0);
        }
        return observations;
    } finally {
        await service.dispose();
    }
}

describe('scan cleanup matched-canvas parity corpus', () => {
    it.skipIf(!corpusEnabled)(
        'places every fixture case within one raster canvas pixel across the three fitters',
        async () => {
            mkdirSync(corpusRoot, {recursive: true});
            expect(resolveScanCleanupParityCoverageGaps()).toEqual([]);
            const registeredWorkingCopies = new Set<string>();
            try {
                // One build of each engine answers for all three paths: the CLI
                // children inherit these overrides and preview stops resolving a
                // candidate of its own. The CLI sidecar does not verify the
                // protocol version, so an unpinned run can compare two engine
                // builds without saying so. An EVB_*_PATH already in the
                // environment decides which build that is; otherwise the CLI
                // resolver's first existing candidate is pinned, a staged .tmp
                // build included, and the identities file records its digest.
                const engines = [
                    pinCorpusEngine('evb-scan-cleanup', 'scan-cleanup', 'EVB_SCAN_CLEANUP_PATH'),
                    pinCorpusEngine('evb-pdf-page-ops', 'pdf-page-ops', 'EVB_PDF_PAGE_OPS_PATH'),
                    pinCorpusEngine('evb-pdf-image-combine', 'pdf-image-combine', 'EVB_PDF_IMAGE_COMBINE_PATH'),
                ];
                const fixtures: IScanCleanupParityFixtureIdentity[] = [];
                const cases: Array<{
                    parityCase: IScanCleanupParityCase;
                    fixtureSha256: string;
                    observations: IScanCleanupParityObservation[];
                }> = [];
                const fixturePaths = new Map<TScanCleanupParityFixture, string>();
                const pathSubstitutions: IScanCleanupParityPathSubstitution[] = [];
                for (const parityCase of SCAN_CLEANUP_PARITY_CASES) {
                    const fixturePath = fixturePaths.get(parityCase.fixture)
                        ?? await provisionCorpusFixture(parityCase.fixture);
                    fixturePaths.set(parityCase.fixture, fixturePath);
                    const fixturePageCount = CORPUS_FIXTURE_PAGE_COUNTS[parityCase.fixture];
                    const identity = fileIdentity(fixturePath);
                    if (!fixtures.some(entry => entry.fixture === parityCase.fixture)) {
                        fixtures.push({
                            fixture: parityCase.fixture,
                            fileName: corpusFixtureFiles[parityCase.fixture],
                            pageCount: fixturePageCount,
                            ...identity,
                        });
                    }
                    const pageSizes = await readCorpusPageSizes(parityCase, fixturePath);
                    const raster = await runCorpusConversion(parityCase, fixturePath, 'raster');
                    const lossless = await runCorpusConversion(parityCase, fixturePath, 'lossless');
                    const losslessResult = readLosslessObservations(
                        parityCase,
                        lossless.evidenceDir,
                        lossless.summary,
                        pageSizes,
                    );
                    if (losslessResult.substitution) {
                        pathSubstitutions.push(losslessResult.substitution);
                    }
                    // A case that declares a substitution must produce it, and a
                    // case that declares none must produce none: a path that
                    // quietly stops answering is the failure this corpus exists
                    // to catch.
                    expect(
                        losslessResult.substitution === null ? [] : [losslessResult.substitution.path],
                        `${parityCase.id} path substitutions`,
                    ).toEqual([...parityCase.expectedPathSubstitutions ?? []]);
                    cases.push({
                        parityCase,
                        fixtureSha256: identity.sha256,
                        observations: [
                            ...readRasterObservations(
                                parityCase,
                                raster.evidenceDir,
                                raster.summary,
                                pageSizes,
                            ),
                            ...losslessResult.observations,
                            ...await readPreviewObservations(
                                parityCase,
                                fixturePath,
                                fixturePageCount,
                                pageSizes,
                                registeredWorkingCopies,
                            ),
                        ],
                    });
                }
                const report = buildScanCleanupParityReport({
                    cases,
                    fixtures,
                    pathSubstitutions,
                    typedWarningChannelLimitations: [],
                });
                const reportPath = join(corpusRoot, 'parity-corpus-report.json');
                writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
                assertScanCleanupParityReport(JSON.parse(readFileSync(reportPath, 'utf8')));
                // The identities file names the evidence by its bytes, so it is
                // written from the report as it landed on disk rather than from
                // the object that produced it.
                const reportIdentity = fileIdentity(reportPath);
                // Fixture identities name a file rather than a path, so the
                // directory holding them is stated once and proven to be the
                // only one: fixtures drawn from two places could not be
                // re-hashed by name.
                const fixtureDirs = [...new Set([...fixturePaths.values()].map(path => dirname(path)))];
                expect(fixtureDirs, 'corpus fixture directory').toHaveLength(1);
                const fixtureDir = fixtureDirs[0]!;
                const identities = buildScanCleanupParityIdentities({
                    engines,
                    report,
                    reportPath,
                    reportSha256: reportIdentity.sha256,
                    reportBytes: reportIdentity.bytes,
                    fixtureDir,
                });
                const identitiesPath = join(corpusRoot, 'parity-corpus-identities.json');
                writeFileSync(identitiesPath, `${JSON.stringify(identities, null, 2)}\n`, 'utf8');
                assertScanCleanupParityIdentities(
                    JSON.parse(readFileSync(identitiesPath, 'utf8')),
                    report,
                    {fixtureDir},
                );

                // Every case is measured on the one grid the tolerance is fixed
                // for; a run that lands on another grid invalidates the tolerance
                // rather than the placement.
                //
                // The DPI is divided back out of a pixel count the run derived
                // from a point measurement, so it is only exactly the selected
                // DPI where that arithmetic happens to be exact in binary. The
                // exact-boundary fixture is 142.08 pt across: 142.08 / 72 * 150
                // is 296.00000000000006, which the canvas rounds to 296 px, and
                // 296 / 142.08 * 72 is 149.99999999999997 — the value that case
                // reports on every run of this corpus. Six decimals is far
                // tighter than any grid the corpus would accept as another one
                // — the next candidate grid is 300 DPI — and it survives the
                // last bits of a division the run cannot avoid.
                for (const observation of report.cases.flatMap(entry => entry.observations)) {
                    if (observation.canvasGrid !== 'raster-canvas') continue;
                    expect(
                        observation.canvasDpi,
                        `${observation.caseId} raster canvas DPI`,
                    ).toBeCloseTo(SCAN_CLEANUP_PARITY_CANVAS_DPI, 6);
                }
                for (const comparison of report.comparisons) {
                    // A path may be absent only where the run recorded why.
                    expect(
                        comparison.missingPaths,
                        `${comparison.caseId} page ${String(comparison.sourcePageNumber)} ${comparison.half}`,
                    ).toEqual(report.pathSubstitutions
                        .filter(substitution => substitution.caseId === comparison.caseId)
                        .map(substitution => substitution.path));
                }
                expect(report.exceedances).toEqual([]);
            } finally {
                // The opt-in corpus borrows this process: the engine overrides,
                // the working copies it registered and the formatter capture are
                // retired even when an exceedance ends the run early, so no later
                // test inherits them.
                for (const workingPath of registeredWorkingCopies) {
                    forgetWorkingCopyOriginalPath(workingPath);
                }
                previewWarningEventCapture.length = 0;
                vi.unstubAllEnvs();
            }
        },
        4_500_000,
    );
});
