import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    createReadStream,
    existsSync,
} from 'node:fs';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {
    PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES,
    type IPdfAnnotationIndexEntry,
    type IPdfAnnotationIndexSession,
} from '@contracts/electronApiDocuments';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {
    EXACT_PDF_FIXTURE_MANIFEST,
    stageExactPdfFixture,
    type TExactPdfFixtureCopyMode,
} from '@scripts/ci/stageExactPdfFixture';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {runElectronE2ETeardown} from '@tests/e2e/electron/helpers/electronE2ESessionFailure';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    openAnnotationsTab,
    saveViaVisibleToolbarWithDeadline,
    scrollViewerToPage,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';

/**
 * Opt in explicitly with:
 *
 * EVB_E2E_XLARGE_PDF_FIXTURE=.devkit/fixtures/zaliznyak-three-distinct-copy-2646-pages.pdf \
 *   bash scripts/test-electron-e2e-headless.sh --no-build e2e-xlarge-pdf tests/e2e/electron/xlargeDocumentAcceptance.e2e.test.ts --reporter verbose
 *
 * The fixture gate below uses filesystem metadata, SHA-256, and qpdf page
 * counting/checking. Keep this lane path-backed. Do not add a whole-document
 * JavaScript parser or a byte aggregation helper here.
 */

const execFileAsync = promisify(execFile);

const XLARGE_FIXTURE_ENV = 'EVB_E2E_XLARGE_PDF_FIXTURE';
const XLARGE_ARTIFACT_ENV = 'EVB_E2E_XLARGE_PDF_ARTIFACT';
const XLARGE_MIN_BYTES = 2_147_483_648;
const XLARGE_FIXTURE_EXPECTATION = EXACT_PDF_FIXTURE_MANIFEST.xlargeZaliznyak2646;
const XLARGE_KNOWN_FIXTURE_BYTES = XLARGE_FIXTURE_EXPECTATION.bytes;
const XLARGE_PAGE_COUNT = XLARGE_FIXTURE_EXPECTATION.pages;
const XLARGE_FIRST_PAGE = 1;
const XLARGE_MIDDLE_PAGE = 1_323;
const XLARGE_LAST_PAGE = 2_646;
const XLARGE_RENDER_PAGES = [
    XLARGE_FIRST_PAGE,
    XLARGE_MIDDLE_PAGE,
    XLARGE_LAST_PAGE,
] as const;
const XLARGE_HEARTBEAT_INTERVAL_MS = 100;
// CI telemetry recorded a 9,231.1 ms maximum heartbeat gap in this lane.
// Keep the blocking limit at 14 seconds, at least 1.5x that observed maximum.
const XLARGE_HEARTBEAT_MAX_GAP_MS = 14_000;
const XLARGE_INDEX_CHUNK_BYTES = 512 * 1_024;
const XLARGE_IPC_PAYLOAD_MAX_BYTES = 8 * 1_024 * 1_024;
// This is a renderer heap budget, not a machine-specific RSS ceiling. A
// 512 MiB growth limit is one quarter of the minimum admitted input size and
// catches accidental whole-document retention while leaving normal PDF.js
// page rendering room.
const XLARGE_RENDERER_JS_HEAP_MAX_DELTA_BYTES = 512 * 1_024 * 1_024;
// The invariant remains one quarter of the minimum admitted input size. This
// tolerance covers runner measurement noise without changing that invariant.
const XLARGE_RENDERER_JS_HEAP_RUNNER_TOLERANCE = 0.1;
const XLARGE_TEST_TIMEOUT_MS = 45 * 60 * 1_000;
const XLARGE_SAVE_TIMEOUT_MS = 120 * 1_000;
const XLARGE_RSS_SAMPLE_INTERVAL_MS = 250;

const configuredFixture = process.env[XLARGE_FIXTURE_ENV]?.trim() ?? '';
const xlargeDescribe = configuredFixture ? describe : describe.skip;

const defaultArtifactPath = resolve(
    process.cwd(),
    '.devkit',
    'test',
    'electron-e2e-artifacts',
    'xlarge-document-acceptance.json',
);
const artifactPath = resolve(
    process.env[XLARGE_ARTIFACT_ENV]?.trim() || defaultArtifactPath,
);
const acceptanceSourcePath = fileURLToPath(import.meta.url);

const BASELINE_NOTE_NAME = 'evb-note:uid:0:pdfjs_internal_editor_0:created:1787771262040';

interface IAnnotationObjectRef {
    objectNumber: number;
    generationNumber: number;
}

interface IExpectedAnnotationIndexEntry {
    pageIndex: number;
    objectNumber: number;
    generationNumber: number;
    subtype: string;
    name: string | null;
    popupRef: IAnnotationObjectRef | null;
    parentRef: IAnnotationObjectRef | null;
}

const EXPECTED_BASELINE_ENTRIES: IExpectedAnnotationIndexEntry[] = [
    {
        pageIndex: 0,
        objectNumber: 2_649,
        generationNumber: 0,
        subtype: 'FreeText',
        name: BASELINE_NOTE_NAME,
        popupRef: {
            objectNumber: 10_594,
            generationNumber: 0,
        },
        parentRef: null,
    },
    {
        pageIndex: 0,
        objectNumber: 2_650,
        generationNumber: 0,
        subtype: 'Popup',
        name: null,
        popupRef: null,
        parentRef: {
            objectNumber: 10_595,
            generationNumber: 0,
        },
    },
    {
        pageIndex: 882,
        objectNumber: 5_297,
        generationNumber: 0,
        subtype: 'FreeText',
        name: BASELINE_NOTE_NAME,
        popupRef: {
            objectNumber: 12_361,
            generationNumber: 0,
        },
        parentRef: null,
    },
    {
        pageIndex: 882,
        objectNumber: 5_298,
        generationNumber: 0,
        subtype: 'Popup',
        name: null,
        popupRef: null,
        parentRef: {
            objectNumber: 12_362,
            generationNumber: 0,
        },
    },
    {
        pageIndex: 1_764,
        objectNumber: 7_945,
        generationNumber: 0,
        subtype: 'FreeText',
        name: BASELINE_NOTE_NAME,
        popupRef: {
            objectNumber: 14_128,
            generationNumber: 0,
        },
        parentRef: null,
    },
    {
        pageIndex: 1_764,
        objectNumber: 7_946,
        generationNumber: 0,
        subtype: 'Popup',
        name: null,
        popupRef: null,
        parentRef: {
            objectNumber: 14_129,
            generationNumber: 0,
        },
    },
];

interface IStagedFixture {
    copyMode: TExactPdfFixtureCopyMode;
    sourcePath: string;
    stagedPath: string;
    stagingDirectory: string;
    sourceBytes: number;
    stagedBytes: number;
}

interface IPdfSourceStateSnapshot {
    hasInMemoryData: boolean;
    reloadKind: 'blob' | 'none' | 'path';
    reloadPath: string | null;
}

interface ISaveReceiptProbe {
    barrierFinished: boolean;
    nativeProjectionEngaged: boolean;
    stagedArtifact: ITypedStagedArtifact | null;
}

interface ISaveReceiptProbeWindow extends Window {
    __stagedPdfNativeMutationCommitBarrierForAutomation?: (
        stagedArtifact: ITypedStagedArtifact,
    ) => Promise<void> | void;
    __resumeSaveReceiptCommit?: () => void;
    __saveReceiptProbe?: ISaveReceiptProbe;
}

interface IAgentActionResult extends Record<string, unknown> {
    created?: boolean;
    markerRect?: unknown;
    tabId?: string;
    updated?: boolean;
}

interface IHeartbeatSnapshot {
    maxGapMs: number;
    sampleCount: number;
    startedAt: number;
    stoppedAt: number;
    maxGapStartEpochMs: number | null;
    maxGapEndEpochMs: number | null;
    visibilityAtStart: IRendererVisibilitySnapshot;
    visibilityAtStop: IRendererVisibilitySnapshot;
    messageChannelMaxGapMs: number;
    messageChannelMaxGapStartEpochMs: number | null;
    messageChannelMaxGapEndEpochMs: number | null;
    workerMaxGapMs: number | null;
    workerMaxGapStartEpochMs: number | null;
    workerMaxGapEndEpochMs: number | null;
    workerSampleCount: number;
    workerAvailable: boolean;
}

interface IRendererVisibilitySnapshot {
    documentHidden: boolean;
    visibilityState: DocumentVisibilityState;
    epochMs: number;
}

interface IHeartbeatProbe extends IHeartbeatSnapshot {
    lastTickAt: number;
    lastTickEpochMs: number;
    running: boolean;
    timerId: number | null;
    messageChannel: MessageChannel | null;
    messageChannelTimerId: number | null;
    lastMessageChannelAt: number;
    lastMessageChannelEpochMs: number;
    worker: Worker | null;
    lastWorkerAt: number | null;
    lastWorkerEpochMs: number | null;
}

interface IRendererLongTask {
    durationMs: number;
    name: string;
    startTime: number;
    startEpochMs: number;
}

interface IRendererLongTaskProbeWindow extends Window {
    __evbXlargeLongTasks?: IRendererLongTask[];
    __evbXlargeLongTaskObserver?: PerformanceObserver;
}

interface IRendererPlacementSampling {
    annotationEditorLayerCount: number;
    annotationLayerCount: number;
    animationFrameSampleCount: number;
    domMutationCount: number;
    maxAnimationFrameGapMs: number;
}

interface IRendererPlacementSamplingState {
    animationFrameId: number;
    lastAnimationFrameAt: number;
    maxAnimationFrameGapMs: number;
    animationFrameSampleCount: number;
    domMutationCount: number;
    mutationObserver: MutationObserver | null;
}

interface IRendererPlacementSamplingWindow extends Window {__evbXlargePlacementSampling?: IRendererPlacementSamplingState;}

interface IRendererRssSample {
    atMs: number;
    electronBytes: number | null;
    rendererJsHeapUsedBytes: number | null;
    rendererJsHeapTotalBytes: number | null;
    runnerBytes: number;
}

interface IRendererRssTelemetry {
    electronPid: number | null;
    baselineElectronBytes: number | null;
    peakElectronBytes: number | null;
    lastElectronBytes: number | null;
    baselineRunnerBytes: number | null;
    peakRunnerBytes: number | null;
    lastRunnerBytes: number | null;
    baselineRendererJsHeapUsedBytes: number | null;
    peakRendererJsHeapUsedBytes: number | null;
    lastRendererJsHeapUsedBytes: number | null;
    rendererJsHeapDeltaBytes: number | null;
    samples: IRendererRssSample[];
}

interface IRssSampler {stop: () => Promise<IRendererRssTelemetry>;}

interface IAnnotationIndexRead {
    session: IPdfAnnotationIndexSession;
    entries: IPdfAnnotationIndexEntry[];
    chunkByteLengths: number[];
    transportPayloadByteLengths: number[];
}

interface IPhaseTiming {
    durationMs: number;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    phase: string;
}

interface IRendererIpcPayloadProbe {
    name: string;
    maxPayloadBytes: number | null;
    sampleCount: number | null;
}

interface IRendererIpcPayloadProbeWindow extends Window {
    __evbIpcPayloadProbe?: unknown;
    __evbIpcPayloads?: unknown;
    __evbRendererIpcPayloadProbe?: unknown;
}

type TXlargeIpcPayloadOperation = 'annotation-index-chunk' | 'save-receipt' | 'renderer-probe';

interface IXlargeIpcPayloadMeasurement {
    bytes: number;
    operation: TXlargeIpcPayloadOperation;
    session: 'A' | 'B';
}

interface IXlargeAcceptanceTelemetry {
    fixture: {
        configuredPath: string;
        sourcePath: string | null;
        stagedPath: string | null;
        sourceBytes: number | null;
        stagedBytes: number | null;
        knownFixtureBytes: number;
        requiredMinimumBytes: number;
        requiredPageCount: number;
        pageCount: number | null;
        cloneMode: TExactPdfFixtureCopyMode | null;
    };
    phases: IPhaseTiming[];
    heartbeats: Array<IHeartbeatSnapshot & {
        session: 'A' | 'B';
        stage: string
    }>;
    rendererLongTasks: IRendererLongTask[];
    rendererPlacementSampling: IRendererPlacementSampling | null;
    windowHosting: {
        automationHideWindow: string | null;
        automationNoFocus: string | null;
        browserWindowVisible: boolean;
        browserWindowOccluded: boolean | null;
        occlusionProbeAvailable: boolean;
    };
    rss: Array<IRendererRssTelemetry & {session: 'A' | 'B'}>;
    rendererJsHeapBudgetBytes: number;
    ipcPayloadMeasurements: IXlargeIpcPayloadMeasurement[];
    rendererIpcPayloadProbe: IRendererIpcPayloadProbe | null;
    heartbeatPolicy: {
        maxGapMs: number;
        rationale: string;
    };
    structuralComparison: {
        baselineEntries: number;
        finalEntries: number;
        unchangedObjectRefs: string[];
        addedObjectRefs: string[];
    } | null;
    failure: {
        message: string;
        stack: string | null
    } | null;
}

function createTelemetry(): IXlargeAcceptanceTelemetry {
    return {
        fixture: {
            configuredPath: configuredFixture,
            sourcePath: null,
            stagedPath: null,
            sourceBytes: null,
            stagedBytes: null,
            knownFixtureBytes: XLARGE_KNOWN_FIXTURE_BYTES,
            requiredMinimumBytes: XLARGE_MIN_BYTES,
            requiredPageCount: XLARGE_PAGE_COUNT,
            pageCount: null,
            cloneMode: null,
        },
        phases: [],
        heartbeats: [],
        rendererLongTasks: [],
        rendererPlacementSampling: null,
        windowHosting: {
            automationHideWindow: process.env.EVB_AUTOMATION_HIDE_WINDOW ?? null,
            automationNoFocus: process.env.EVB_AUTOMATION_NO_FOCUS ?? null,
            browserWindowVisible: process.env.EVB_AUTOMATION_HIDE_WINDOW !== '1',
            browserWindowOccluded: null,
            occlusionProbeAvailable: false,
        },
        rss: [],
        rendererJsHeapBudgetBytes: XLARGE_RENDERER_JS_HEAP_MAX_DELTA_BYTES,
        ipcPayloadMeasurements: [],
        rendererIpcPayloadProbe: null,
        heartbeatPolicy: {
            maxGapMs: XLARGE_HEARTBEAT_MAX_GAP_MS,
            rationale: 'The interval heartbeat is the hard renderer pause budget. MessageChannel gaps remain diagnostic because Chromium can deliver them from a different task source after the timer queue resumes.',
        },
        structuralComparison: null,
        failure: null,
    };
}

function rendererJsHeapBudgetBytes(sourceBytes: number) {
    const invariantBudgetBytes = Math.min(
        XLARGE_RENDERER_JS_HEAP_MAX_DELTA_BYTES,
        Math.floor(sourceBytes / 4),
    );
    return Math.ceil(invariantBudgetBytes * (1 + XLARGE_RENDERER_JS_HEAP_RUNNER_TOLERANCE));
}

describe('Electron E2E - xlarge document acceptance source contract', () => {
    it('keeps the fixture lane path-backed and free of whole-file helpers', async () => {
        // This reads the small test source, never the admitted PDF fixture.
        const source = await readFile(acceptanceSourcePath, 'utf8');
        expect(source).toContain('stageExactPdfFixture');
        expect(source).toContain('copyMode');
        const forcedCloneToken = [
            'COPYFILE',
            'FICLONE_FORCE',
        ].join('_');
        expect(source).not.toContain(forcedCloneToken);
        expect(source).toContain('getPdfPageCount');
        expect(source).toContain('XLARGE_MIN_BYTES');
        expect(source).toContain('XLARGE_PAGE_COUNT');
        const forbiddenExpressions = [
            [
                'readFile',
                'Sync',
            ].join(''),
            [
                'PDFDocument',
                '.load',
            ].join(''),
            [
                'getData',
                '(',
            ].join(''),
            [
                'arrayBuffer',
                '(',
            ].join(''),
            [
                'copyPages',
                '(',
            ].join(''),
            [
                'merge',
                'Pdf',
                '(',
            ].join(''),
        ];
        for (const expression of forbiddenExpressions) {
            expect(source).not.toContain(expression);
        }
    });
});

async function timed<T>(
    telemetry: IXlargeAcceptanceTelemetry,
    phase: string,
    operation: () => Promise<T>,
) {
    const startedAt = performance.now();
    const startedAtEpochMs = Date.now();
    try {
        return await operation();
    } finally {
        const endedAtEpochMs = Date.now();
        telemetry.phases.push({
            phase,
            durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
            startedAtEpochMs,
            endedAtEpochMs,
        });
    }
}

async function readResidentBytes(pid: number | null) {
    if (!pid || process.platform === 'win32') {
        return null;
    }
    try {
        const {stdout} = await execFileAsync('ps', [
            '-o',
            'rss=',
            '-p',
            String(pid),
        ], {encoding: 'utf8'});
        const kib = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(kib) ? kib * 1_024 : null;
    } catch {
        return null;
    }
}

interface IRendererJsHeapSample {
    usedBytes: number | null;
    totalBytes: number | null;
}

async function readRendererJsHeap(page: Page): Promise<IRendererJsHeapSample> {
    try {
        const metrics = await page.metrics();
        const usedBytes = typeof metrics.JSHeapUsedSize === 'number'
            && Number.isFinite(metrics.JSHeapUsedSize)
            ? metrics.JSHeapUsedSize
            : null;
        const totalBytes = typeof metrics.JSHeapTotalSize === 'number'
            && Number.isFinite(metrics.JSHeapTotalSize)
            ? metrics.JSHeapTotalSize
            : null;
        if (usedBytes !== null || totalBytes !== null) {
            return {
                totalBytes,
                usedBytes,
            };
        }
    } catch {
        // Fall through to performance.memory for browsers without CDP metrics.
    }

    try {
        return await page.evaluate(() => {
            const memory = (performance as Performance & {memory?: {
                totalJSHeapSize?: unknown;
                usedJSHeapSize?: unknown;
            };}).memory;
            const usedBytes = typeof memory?.usedJSHeapSize === 'number'
                && Number.isFinite(memory.usedJSHeapSize)
                ? memory.usedJSHeapSize
                : null;
            const totalBytes = typeof memory?.totalJSHeapSize === 'number'
                && Number.isFinite(memory.totalJSHeapSize)
                ? memory.totalJSHeapSize
                : null;
            return {
                totalBytes,
                usedBytes,
            };
        });
    } catch {
        return {
            totalBytes: null,
            usedBytes: null,
        };
    }
}

function createRssSampler(page: Page, electronPid: number | null): IRssSampler {
    const startedAt = performance.now();
    const samples: IRendererRssSample[] = [];
    let running = true;
    let result: IRendererRssTelemetry | null = null;

    const sample = async () => {
        const [
            electronBytes,
            rendererJsHeap,
        ] = await Promise.all([
            readResidentBytes(electronPid),
            readRendererJsHeap(page),
        ]);
        if (running) {
            samples.push({
                atMs: Math.round((performance.now() - startedAt) * 10) / 10,
                electronBytes,
                rendererJsHeapTotalBytes: rendererJsHeap.totalBytes,
                rendererJsHeapUsedBytes: rendererJsHeap.usedBytes,
                runnerBytes: process.memoryUsage().rss,
            });
        }
    };

    const loop = (async () => {
        while (running) {
            await sample();
            if (running) {
                await new Promise<void>(resolvePromise => {
                    setTimeout(resolvePromise, XLARGE_RSS_SAMPLE_INTERVAL_MS);
                });
            }
        }
    })();

    return {stop: async () => {
        if (result) {
            return result;
        }
        running = false;
        await loop;
        const electronValues = samples
            .map(sampleValue => sampleValue.electronBytes)
            .filter((value): value is number => value !== null);
        const rendererJsHeapValues = samples
            .map(sampleValue => sampleValue.rendererJsHeapUsedBytes)
            .filter((value): value is number => value !== null);
        const runnerValues = samples.map(sampleValue => sampleValue.runnerBytes);
        const baselineRendererJsHeapUsedBytes = rendererJsHeapValues[0] ?? null;
        const peakRendererJsHeapUsedBytes = rendererJsHeapValues.length > 0
            ? Math.max(...rendererJsHeapValues)
            : null;
        result = {
            electronPid,
            baselineElectronBytes: electronValues[0] ?? null,
            peakElectronBytes: electronValues.length > 0 ? Math.max(...electronValues) : null,
            lastElectronBytes: electronValues.at(-1) ?? null,
            baselineRunnerBytes: runnerValues[0] ?? null,
            peakRunnerBytes: runnerValues.length > 0 ? Math.max(...runnerValues) : null,
            lastRunnerBytes: runnerValues.at(-1) ?? null,
            baselineRendererJsHeapUsedBytes,
            peakRendererJsHeapUsedBytes,
            lastRendererJsHeapUsedBytes: rendererJsHeapValues.at(-1) ?? null,
            rendererJsHeapDeltaBytes: baselineRendererJsHeapUsedBytes !== null
                && peakRendererJsHeapUsedBytes !== null
                ? Math.max(0, peakRendererJsHeapUsedBytes - baselineRendererJsHeapUsedBytes)
                : null,
            samples,
        };
        return result;
    }};
}

async function stageFixture(sourcePath: string): Promise<IStagedFixture> {
    const stagingRoot = resolve(process.cwd(), '.devkit', 'tmp');
    await mkdir(stagingRoot, {recursive: true});
    const stagingDirectory = await mkdtemp(join(stagingRoot, 'xlarge-document-acceptance-'));
    const stagedPath = join(stagingDirectory, 'acceptance.pdf');
    try {
        const staged = await stageExactPdfFixture({
            expectedIdentity: XLARGE_FIXTURE_EXPECTATION,
            maxBytes: XLARGE_KNOWN_FIXTURE_BYTES,
            outputPath: stagedPath,
            sourcePath,
            timeoutMs: 15 * 60_000,
        });
        return {
            copyMode: staged.copyMode,
            sourcePath: staged.sourcePath,
            stagedPath: staged.stagedPath,
            stagingDirectory,
            sourceBytes: staged.sourceIdentity.bytes,
            stagedBytes: staged.stagedIdentity.bytes,
        };
    } catch (error) {
        await rm(stagingDirectory, {
            force: true,
            recursive: true,
        });
        throw new Error(
            `Could not stage the xlarge fixture with the clone-or-stream fixture copier: ${stagedPath}`,
            {cause: error},
        );
    }
}

async function assertQpdfCheck(pdfPath: string) {
    await execFileAsync('qpdf', [
        '--check',
        pdfPath,
    ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    });
}

async function startRendererHeartbeat(page: Page) {
    await page.evaluate((intervalMs: number) => {
        const target = window as Window & {__evbXlargeHeartbeat?: IHeartbeatProbe};
        const startedAt = performance.now();
        const startedEpochMs = Date.now();
        const visibility = (): IRendererVisibilitySnapshot => ({
            documentHidden: document.hidden,
            epochMs: Date.now(),
            visibilityState: document.visibilityState,
        });
        const initialVisibility = visibility();
        const recordGap = (
            now: number,
            nowEpochMs: number,
            last: number,
            lastEpochMs: number,
            onGap: (gapMs: number, gapStartEpochMs: number, gapEndEpochMs: number) => void,
        ) => {
            const gapMs = now - last;
            onGap(gapMs, lastEpochMs, nowEpochMs);
        };
        const state: IHeartbeatProbe = {
            maxGapMs: 0,
            sampleCount: 0,
            startedAt,
            stoppedAt: 0,
            maxGapStartEpochMs: null,
            maxGapEndEpochMs: null,
            visibilityAtStart: initialVisibility,
            visibilityAtStop: initialVisibility,
            messageChannelMaxGapMs: 0,
            messageChannelMaxGapStartEpochMs: null,
            messageChannelMaxGapEndEpochMs: null,
            workerMaxGapMs: null,
            workerMaxGapStartEpochMs: null,
            workerMaxGapEndEpochMs: null,
            workerSampleCount: 0,
            workerAvailable: typeof Worker === 'function',
            lastTickAt: startedAt,
            lastTickEpochMs: startedEpochMs,
            running: true,
            timerId: null,
            messageChannel: null,
            messageChannelTimerId: null,
            lastMessageChannelAt: startedAt,
            lastMessageChannelEpochMs: startedEpochMs,
            worker: null,
            lastWorkerAt: null,
            lastWorkerEpochMs: null,
        };
        const tick = () => {
            if (!state.running) {
                return;
            }
            const now = performance.now();
            const nowEpochMs = Date.now();
            recordGap(now, nowEpochMs, state.lastTickAt, state.lastTickEpochMs, (gapMs, gapStartEpochMs, gapEndEpochMs) => {
                if (gapMs <= state.maxGapMs) {
                    return;
                }
                state.maxGapMs = gapMs;
                state.maxGapStartEpochMs = gapStartEpochMs;
                state.maxGapEndEpochMs = gapEndEpochMs;
            });
            state.lastTickAt = now;
            state.lastTickEpochMs = nowEpochMs;
            state.sampleCount += 1;
        };
        state.timerId = window.setInterval(tick, intervalMs);

        if (typeof MessageChannel === 'function') {
            const channel = new MessageChannel();
            state.messageChannel = channel;
            channel.port1.onmessage = () => {
                if (!state.running) {
                    return;
                }
                const now = performance.now();
                const nowEpochMs = Date.now();
                recordGap(now, nowEpochMs, state.lastMessageChannelAt, state.lastMessageChannelEpochMs, (gapMs, gapStartEpochMs, gapEndEpochMs) => {
                    if (gapMs <= state.messageChannelMaxGapMs) {
                        return;
                    }
                    state.messageChannelMaxGapMs = gapMs;
                    state.messageChannelMaxGapStartEpochMs = gapStartEpochMs;
                    state.messageChannelMaxGapEndEpochMs = gapEndEpochMs;
                });
                state.lastMessageChannelAt = now;
                state.lastMessageChannelEpochMs = nowEpochMs;
                state.messageChannelTimerId = window.setTimeout(() => channel.port2.postMessage(null), intervalMs);
            };
            state.messageChannelTimerId = window.setTimeout(() => channel.port2.postMessage(null), intervalMs);
        }

        if (typeof Worker === 'function' && typeof Blob === 'function' && typeof URL.createObjectURL === 'function') {
            const workerSource = `
                setInterval(() => postMessage({at: performance.now(), epochMs: Date.now()}), ${intervalMs});
            `;
            const workerUrl = URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'}));
            const worker = new Worker(workerUrl);
            state.worker = worker;
            worker.onmessage = (event: MessageEvent<{
                at: number;
                epochMs: number;
            }>) => {
                if (!state.running) {
                    return;
                }
                const now = event.data.at;
                const nowEpochMs = event.data.epochMs;
                if (state.lastWorkerAt !== null && state.lastWorkerEpochMs !== null) {
                    recordGap(now, nowEpochMs, state.lastWorkerAt, state.lastWorkerEpochMs, (gapMs, gapStartEpochMs, gapEndEpochMs) => {
                        if (state.workerMaxGapMs !== null && gapMs <= state.workerMaxGapMs) {
                            return;
                        }
                        state.workerMaxGapMs = gapMs;
                        state.workerMaxGapStartEpochMs = gapStartEpochMs;
                        state.workerMaxGapEndEpochMs = gapEndEpochMs;
                    });
                }
                state.lastWorkerAt = now;
                state.lastWorkerEpochMs = nowEpochMs;
                state.workerSampleCount += 1;
            };
            URL.revokeObjectURL(workerUrl);
        }
        target.__evbXlargeHeartbeat = state;
    }, XLARGE_HEARTBEAT_INTERVAL_MS);

    return async () => {
        await new Promise<void>(resolvePromise => {
            setTimeout(resolvePromise, XLARGE_HEARTBEAT_INTERVAL_MS * 2);
        });
        return page.evaluate(() => {
            const target = window as Window & {__evbXlargeHeartbeat?: IHeartbeatProbe};
            const state = target.__evbXlargeHeartbeat;
            if (!state) {
                throw new Error('Xlarge renderer heartbeat probe is unavailable');
            }
            state.running = false;
            if (state.timerId !== null) {
                window.clearInterval(state.timerId);
            }
            if (state.messageChannelTimerId !== null) {
                window.clearTimeout(state.messageChannelTimerId);
            }
            state.messageChannel?.port1.close();
            state.messageChannel?.port2.close();
            state.worker?.terminate();
            state.visibilityAtStop = {
                documentHidden: document.hidden,
                epochMs: Date.now(),
                visibilityState: document.visibilityState,
            };
            state.stoppedAt = performance.now();
            return {
                maxGapMs: Math.round(state.maxGapMs * 10) / 10,
                sampleCount: state.sampleCount,
                startedAt: Math.round(state.startedAt * 10) / 10,
                stoppedAt: Math.round(state.stoppedAt * 10) / 10,
                maxGapStartEpochMs: state.maxGapStartEpochMs,
                maxGapEndEpochMs: state.maxGapEndEpochMs,
                visibilityAtStart: state.visibilityAtStart,
                visibilityAtStop: state.visibilityAtStop,
                messageChannelMaxGapMs: Math.round(state.messageChannelMaxGapMs * 10) / 10,
                messageChannelMaxGapStartEpochMs: state.messageChannelMaxGapStartEpochMs,
                messageChannelMaxGapEndEpochMs: state.messageChannelMaxGapEndEpochMs,
                workerMaxGapMs: state.workerMaxGapMs === null ? null : Math.round(state.workerMaxGapMs * 10) / 10,
                workerMaxGapStartEpochMs: state.workerMaxGapStartEpochMs,
                workerMaxGapEndEpochMs: state.workerMaxGapEndEpochMs,
                workerSampleCount: state.workerSampleCount,
                workerAvailable: state.workerAvailable,
            };
        });
    };
}

async function startRendererLongTaskProbe(page: Page) {
    await page.evaluate(() => {
        const target = window as IRendererLongTaskProbeWindow;
        const longTasks: IRendererLongTask[] = [];
        target.__evbXlargeLongTasks = longTasks;
        if (typeof PerformanceObserver !== 'function') {
            return;
        }
        const observer = new PerformanceObserver(list => {
            list.getEntries().forEach(entry => {
                longTasks.push({
                    durationMs: Math.round(entry.duration * 10) / 10,
                    name: entry.name,
                    startTime: Math.round(entry.startTime * 10) / 10,
                    startEpochMs: Math.round((performance.timeOrigin + entry.startTime) * 10) / 10,
                });
            });
        });
        observer.observe({
            type: 'longtask',
            buffered: true,
        });
        target.__evbXlargeLongTaskObserver = observer;
    });
}

async function readRendererLongTaskProbe(page: Page) {
    return page.evaluate(() => {
        const target = window as IRendererLongTaskProbeWindow;
        target.__evbXlargeLongTaskObserver?.disconnect();
        return target.__evbXlargeLongTasks ?? [];
    });
}

async function startRendererPlacementSampling(page: Page) {
    await page.evaluate(() => {
        const target = window as IRendererPlacementSamplingWindow;
        const startedAt = performance.now();
        const state = {
            animationFrameId: 0,
            lastAnimationFrameAt: startedAt,
            maxAnimationFrameGapMs: 0,
            animationFrameSampleCount: 0,
            domMutationCount: 0,
            mutationObserver: typeof MutationObserver === 'function' ? new MutationObserver((records) => {
                state.domMutationCount += records.length;
            }) : null,
        };
        state.mutationObserver?.observe(document.body, {
            attributes: true,
            childList: true,
            subtree: true,
        });
        const sampleAnimationFrame = (at: number) => {
            state.maxAnimationFrameGapMs = Math.max(
                state.maxAnimationFrameGapMs,
                at - state.lastAnimationFrameAt,
            );
            state.lastAnimationFrameAt = at;
            state.animationFrameSampleCount += 1;
            state.animationFrameId = window.requestAnimationFrame(sampleAnimationFrame);
        };
        state.animationFrameId = window.requestAnimationFrame(sampleAnimationFrame);
        target.__evbXlargePlacementSampling = state;
    });
}

async function readRendererPlacementSampling(page: Page) {
    return page.evaluate(() => {
        const target = window as IRendererPlacementSamplingWindow;
        const state = target.__evbXlargePlacementSampling;
        if (!state) {
            throw new Error('Xlarge renderer placement sampling probe is unavailable');
        }
        window.cancelAnimationFrame(state.animationFrameId);
        state.mutationObserver?.disconnect();
        return {
            animationFrameSampleCount: state.animationFrameSampleCount,
            annotationEditorLayerCount: document.querySelectorAll('.annotation-editor-layer, .annotationEditorLayer').length,
            annotationLayerCount: document.querySelectorAll('.annotation-layer, .annotationLayer').length,
            domMutationCount: state.domMutationCount,
            maxAnimationFrameGapMs: Math.round(state.maxAnimationFrameGapMs * 10) / 10,
        } satisfies IRendererPlacementSampling;
    });
}

async function waitForRenderedPage(page: Page, pageNumber: number, timeoutMs: number) {
    await scrollViewerToPage(page, pageNumber);
    await page.waitForFunction((targetPageNumber: number) => {
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost ?? document.querySelector<HTMLElement>('.workspace-host');
        const pageElement = host?.querySelector<HTMLElement>(
            `.page_container[data-page="${targetPageNumber}"]`,
        );
        if (!pageElement || !pageElement.classList.contains('page_container--rendered')) {
            return false;
        }
        const canvas = pageElement.querySelector<HTMLCanvasElement>(
            '.page_canvas__render-layer canvas, .page_canvas canvas, canvas',
        );
        if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
            return false;
        }
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (!context) {
            return false;
        }
        const samplePoints = [
            0.15,
            0.35,
            0.5,
            0.65,
            0.85,
        ];
        // A rendered PDF page must contain a current pixel sample. Dimensions
        // and the rendered CSS class alone also match blank and stale canvases.
        let hasInk = false;
        for (const xRatio of samplePoints) {
            for (const yRatio of samplePoints) {
                const sample = context.getImageData(
                    Math.min(canvas.width - 1, Math.floor(canvas.width * xRatio)),
                    Math.min(canvas.height - 1, Math.floor(canvas.height * yRatio)),
                    1,
                    1,
                ).data;
                if (sample[3] !== 0 && (
                    sample[0] !== 255 || sample[1] !== 255 || sample[2] !== 255
                )) {
                    hasInk = true;
                    break;
                }
            }
            if (hasInk) {
                break;
            }
        }
        if (!hasInk) {
            return false;
        }
        const viewer = host?.querySelector<HTMLElement>('.pdfViewer');
        if (!viewer) {
            return false;
        }
        const pageRect = pageElement.getBoundingClientRect();
        const viewerRect = viewer.getBoundingClientRect();
        return Math.min(pageRect.bottom, viewerRect.bottom)
            - Math.max(pageRect.top, viewerRect.top) > 8;
    }, {timeout: timeoutMs}, pageNumber);
}

interface IStructuralObjectSummary {
    appearanceHash: string;
    generationNumber: number;
    objectNumber: number;
    subtype: string;
}

async function readStructuralObjectSummary(
    pdfPath: string,
    index: IAnnotationIndexRead,
): Promise<IStructuralObjectSummary[]> {
    const summaries = await Promise.all(index.entries.map(async entry => {
        const object = await readAnnotationObjectContents(pdfPath, entry);
        return {
            appearanceHash: createHash('sha256').update(object.stdout).digest('hex'),
            generationNumber: entry.generationNumber,
            objectNumber: entry.objectNumber,
            subtype: entry.subtype,
        };
    }));
    return summaries.sort((left, right) => (
        left.objectNumber - right.objectNumber
        || left.generationNumber - right.generationNumber
    ));
}

function assertBoundedStructuralChange(
    telemetry: IXlargeAcceptanceTelemetry,
    baseline: IStructuralObjectSummary[],
    final: IStructuralObjectSummary[],
) {
    const finalByRef = new Map(final.map(entry => [
        `${entry.objectNumber}:${entry.generationNumber}`,
        entry,
    ]));
    const unchangedObjectRefs: string[] = [];
    const changedObjectRefs: string[] = [];
    for (const baselineEntry of baseline) {
        const ref = `${baselineEntry.objectNumber}:${baselineEntry.generationNumber}`;
        const finalEntry = finalByRef.get(ref);
        expect(finalEntry, `baseline object ${ref} disappeared after save`).toBeDefined();
        if (finalEntry?.appearanceHash === baselineEntry.appearanceHash) {
            unchangedObjectRefs.push(ref);
        } else {
            changedObjectRefs.push(ref);
        }
    }
    const baselineRefs = new Set(baseline.map(entry => `${entry.objectNumber}:${entry.generationNumber}`));
    const addedObjectRefs = final
        .map(entry => `${entry.objectNumber}:${entry.generationNumber}`)
        .filter(ref => !baselineRefs.has(ref));
    expect(changedObjectRefs).toEqual([]);
    expect(addedObjectRefs.length).toBeGreaterThan(0);
    telemetry.structuralComparison = {
        baselineEntries: baseline.length,
        finalEntries: final.length,
        unchangedObjectRefs,
        addedObjectRefs,
    };
}

async function installSaveReceiptProbe(page: Page) {
    await page.evaluate(() => {
        const probeWindow = window as ISaveReceiptProbeWindow;
        const probe: ISaveReceiptProbe = {
            barrierFinished: false,
            nativeProjectionEngaged: false,
            stagedArtifact: null,
        };
        probeWindow.__saveReceiptProbe = probe;
        const barrier = async (stagedArtifact: ITypedStagedArtifact) => {
            probe.nativeProjectionEngaged = true;
            probe.stagedArtifact = stagedArtifact;
            probe.barrierFinished = true;
        };
        probeWindow.__stagedPdfNativeMutationCommitBarrierForAutomation = barrier;
    });
}

async function readPdfAnnotationIndex(page: Page, documentPath: string): Promise<IAnnotationIndexRead> {
    const result = await page.evaluate(async (input: {
        documentPath: string;
        chunkBytes: number;
        payloadBudget: number;
    }) => {
        const documentFiles = window.electronAPI?.documentFiles;
        if (
            !documentFiles
            || typeof documentFiles.beginPdfAnnotationIndex !== 'function'
            || typeof documentFiles.readPdfAnnotationIndexChunk !== 'function'
            || typeof documentFiles.releasePdfAnnotationIndex !== 'function'
        ) {
            throw new Error('PDF annotation index capability is unavailable in the renderer');
        }

        const revision = await documentFiles.getDocumentRevision(input.documentPath);
        const session = await documentFiles.beginPdfAnnotationIndex(input.documentPath, {expectedDocumentRevisionToken: revision.token});
        const entries: IPdfAnnotationIndexEntry[] = [];
        const chunkByteLengths: number[] = [];
        const transportPayloadByteLengths: number[] = [];
        let offset = 0;
        let released = false;
        try {
            while (true) {
                const chunk = await documentFiles.readPdfAnnotationIndexChunk(
                    session.sessionId,
                    offset,
                    {chunkBytes: input.chunkBytes},
                );
                if (chunk.offset !== offset) {
                    throw new Error(`PDF annotation index offset mismatch: ${chunk.offset} !== ${offset}`);
                }
                if (
                    !Number.isSafeInteger(chunk.byteLength)
                    || chunk.byteLength < 0
                    || chunk.byteLength > input.payloadBudget
                ) {
                    throw new Error(`PDF annotation index chunk exceeded ${input.payloadBudget} bytes`);
                }
                chunkByteLengths.push(chunk.byteLength);
                const transportPayloadByteLength = new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
                if (transportPayloadByteLength > input.payloadBudget) {
                    throw new Error(`PDF annotation index transport payload exceeded ${input.payloadBudget} bytes`);
                }
                transportPayloadByteLengths.push(transportPayloadByteLength);
                entries.push(...chunk.entries);
                if (chunk.done) {
                    if (chunk.nextOffset !== null) {
                        throw new Error('PDF annotation index marked a chunk done with a next offset');
                    }
                    break;
                }
                if (chunk.nextOffset === null || chunk.nextOffset <= offset) {
                    throw new Error('PDF annotation index chunk offset did not advance');
                }
                offset = chunk.nextOffset;
            }
        } finally {
            released = await documentFiles.releasePdfAnnotationIndex(session.sessionId);
        }
        if (!released) {
            throw new Error('PDF annotation index session was not released');
        }
        return {
            session,
            entries,
            chunkByteLengths,
            transportPayloadByteLengths,
        };
    }, {
        documentPath,
        chunkBytes: XLARGE_INDEX_CHUNK_BYTES,
        payloadBudget: XLARGE_IPC_PAYLOAD_MAX_BYTES,
    });
    return result as IAnnotationIndexRead;
}

function assertBaselineAnnotationIndex(index: IAnnotationIndexRead) {
    expect(index.session.pageCount).toBe(XLARGE_PAGE_COUNT);
    expect(index.session.entryCount).toBe(EXPECTED_BASELINE_ENTRIES.length);
    expect(index.entries).toHaveLength(EXPECTED_BASELINE_ENTRIES.length);
    expect(index.session.totalBytes).toBeGreaterThan(0);
    expect(XLARGE_INDEX_CHUNK_BYTES).toBeLessThanOrEqual(PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES);
    expect(index.chunkByteLengths).not.toHaveLength(0);
    expect(index.transportPayloadByteLengths).not.toHaveLength(0);
    expect(index.chunkByteLengths.every(length => length <= XLARGE_IPC_PAYLOAD_MAX_BYTES)).toBe(true);
    expect(index.transportPayloadByteLengths.every(length => length > 0 && length <= XLARGE_IPC_PAYLOAD_MAX_BYTES)).toBe(true);
    expect(index.entries).toEqual(expect.arrayContaining(EXPECTED_BASELINE_ENTRIES));
}

function annotationRefEquals(
    left: IAnnotationObjectRef | null,
    right: IAnnotationObjectRef | null,
) {
    return left?.objectNumber === right?.objectNumber
        && left?.generationNumber === right?.generationNumber;
}

function annotationRefKey(ref: IAnnotationObjectRef) {
    return `${ref.objectNumber}:${ref.generationNumber}`;
}

async function waitForDetachedEditorLayers(
    page: Page,
    timeout = XLARGE_SAVE_TIMEOUT_MS,
) {
    await page.waitForFunction(() => (
        document.querySelectorAll(
            '.editor-pane.is-active .annotationEditorLayer, '
            + '.editor-pane.is-active .annotation-editor-layer',
        ).length === 0
    ), {timeout});
}

function assertFinalAnnotationIndex(index: IAnnotationIndexRead) {
    expect(index.session.pageCount).toBe(XLARGE_PAGE_COUNT);
    expect(index.session.entryCount).toBe(10);
    expect(index.entries).toHaveLength(10);
    expect(index.entries).toEqual(expect.arrayContaining(EXPECTED_BASELINE_ENTRIES));
    expect(XLARGE_INDEX_CHUNK_BYTES).toBeLessThanOrEqual(PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES);
    expect(index.chunkByteLengths).not.toHaveLength(0);
    expect(index.transportPayloadByteLengths).not.toHaveLength(0);
    expect(index.chunkByteLengths.every(length => length <= XLARGE_IPC_PAYLOAD_MAX_BYTES)).toBe(true);
    expect(index.transportPayloadByteLengths.every(length => length > 0 && length <= XLARGE_IPC_PAYLOAD_MAX_BYTES)).toBe(true);

    const canonicalNotes = index.entries.filter(entry => (
        entry.pageIndex === XLARGE_MIDDLE_PAGE - 1
        && entry.subtype === 'Text'
        && entry.name !== BASELINE_NOTE_NAME
        && entry.popupRef !== null
        && entry.parentRef === null
    ));
    expect(canonicalNotes).toHaveLength(2);
    expect(new Set(canonicalNotes.map(entry => entry.name)).size).toBe(2);
    expect(new Set(canonicalNotes.map(entry => (
        `${entry.objectNumber}:${entry.generationNumber}`
    ))).size).toBe(2);

    const toolbarPopups = index.entries.filter(entry => (
        entry.pageIndex === XLARGE_MIDDLE_PAGE - 1
        && entry.subtype === 'Popup'
    ));
    expect(toolbarPopups).toHaveLength(2);
    const canonicalPopupKeys = new Set(
        canonicalNotes.map(entry => annotationRefKey(entry.popupRef!)),
    );
    const toolbarPopupKeys = new Set(
        toolbarPopups.map(entry => annotationRefKey({
            objectNumber: entry.objectNumber,
            generationNumber: entry.generationNumber,
        })),
    );
    expect(canonicalPopupKeys.size).toBe(canonicalNotes.length);
    expect(toolbarPopupKeys).toEqual(canonicalPopupKeys);
    for (const canonicalNote of canonicalNotes) {
        expect(toolbarPopups.some(entry => annotationRefEquals(canonicalNote.popupRef, {
            objectNumber: entry.objectNumber,
            generationNumber: entry.generationNumber,
        }))).toBe(true);
    }
    expect(toolbarPopups.every(entry => entry.parentRef !== null)).toBe(true);

    return {canonicalNotes};
}

function toPdfUtf16BeHex(value: string) {
    return `feff${Array.from(value)
        .map(character => character.charCodeAt(0).toString(16).padStart(4, '0'))
        .join('')}`;
}

async function readAnnotationObjectContents(
    pdfPath: string,
    annotation: Pick<IPdfAnnotationIndexEntry, 'generationNumber' | 'objectNumber'>,
) {
    const {stdout} = await execFileAsync('qpdf', [
        `--show-object=${annotation.objectNumber},${annotation.generationNumber}`,
        '--raw-stream-data',
        pdfPath,
    ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    });
    return {
        stdout,
        normalized: stdout.toLowerCase().replace(/\s+/gu, ''),
    };
}

async function assertAnnotationObjectsContainTexts(
    pdfPath: string,
    annotations: Array<Pick<IPdfAnnotationIndexEntry, 'generationNumber' | 'objectNumber'>>,
    expectedTexts: string[],
) {
    const objectContents = await Promise.all(
        annotations.map(annotation => readAnnotationObjectContents(pdfPath, annotation)),
    );
    const matchedObjectIndexes = new Set<number>();
    for (const expectedText of expectedTexts) {
        const matchingObjectIndexes = objectContents.flatMap(({
            stdout,
            normalized,
        }, index) => (
            stdout.includes(expectedText)
            || normalized.includes(toPdfUtf16BeHex(expectedText))
        ) ? [index] : []);
        expect(matchingObjectIndexes).toHaveLength(1);
        const matchingObjectIndex = matchingObjectIndexes[0];
        expect(matchingObjectIndex).toBeDefined();
        if (matchingObjectIndex === undefined) {
            continue;
        }
        expect(matchedObjectIndexes.has(matchingObjectIndex)).toBe(false);
        matchedObjectIndexes.add(matchingObjectIndex);
    }
}

function recordAnnotationIndexPayloads(
    telemetry: IXlargeAcceptanceTelemetry,
    session: 'A' | 'B',
    index: IAnnotationIndexRead,
) {
    for (const bytes of index.transportPayloadByteLengths) {
        telemetry.ipcPayloadMeasurements.push({
            bytes,
            operation: 'annotation-index-chunk',
            session,
        });
    }
}

function assertMeasuredIpcPayloadBudget(telemetry: IXlargeAcceptanceTelemetry) {
    expect(telemetry.ipcPayloadMeasurements).not.toHaveLength(0);
    expect(telemetry.ipcPayloadMeasurements.every(measurement => (
        measurement.bytes > 0 && measurement.bytes <= XLARGE_IPC_PAYLOAD_MAX_BYTES
    ))).toBe(true);
}

async function waitForWorkspaceComment(
    page: Page,
    text: string,
    pageNumber: number,
    source: 'editor' | 'pdf' = 'editor',
) {
    await page.waitForFunction((input: {
        pageNumber: number;
        text: string
        source: 'editor' | 'pdf';
    }) => {
        const values = window.__evbTestApi?.readActiveWorkspaceStateValues?.(['annotationComments']) as {annotationComments?: unknown;} | undefined;
        const comments = Array.isArray(values?.annotationComments)
            ? values.annotationComments
            : [];
        return comments.some(comment => {
            if (!comment || typeof comment !== 'object') {
                return false;
            }
            const record = comment as Record<string, unknown>;
            return record.text === input.text
                && record.source === input.source
                && record.subtype === 'Text'
                && typeof record.appAnnotationId === 'string'
                && record.appAnnotationId.length > 0
                && (record.pageNumber === input.pageNumber || record.pageIndex === input.pageNumber - 1);
        });
    }, {timeout: 20_000}, {
        pageNumber,
        text,
        source,
    });
}

async function createCanonicalNoteViaAgentAction(
    page: Page,
    text: string,
    pageNumber: number,
    pageX: number,
    pageY: number,
) {
    const tabIdBeforeCreate = await page.evaluate(() => (
        document.querySelector<HTMLElement>(
            '.editor-pane.is-active .tab-list .tab.is-active[data-tab-id]',
        )?.dataset.tabId ?? null
    ));
    if (!tabIdBeforeCreate) {
        throw new Error('Could not identify the active document before canonical note creation');
    }
    const notesUri = `evb://document/${encodeURIComponent(tabIdBeforeCreate)}/notes`;
    const readNotes = async () => {
        const resourceResult = await callWorkspaceCommand<Record<string, unknown>>(
            page,
            'readAgentResource',
            [notesUri],
            {requiredMethods: ['readAgentResource']},
        );
        return Array.isArray(resourceResult.value?.notes) ? resourceResult.value.notes : [];
    };
    const existingStableKeys = new Set(
        (await readNotes()).flatMap(note => (
            note && typeof note === 'object' && typeof (note as Record<string, unknown>).stableKey === 'string'
                ? [(note as Record<string, unknown>).stableKey as string]
                : []
        )),
    );
    const createdResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', [
        'annotation.create_note_at_point',
        {
            page: pageNumber,
            pageX,
            pageY,
            preferTextAnchor: false,
        },
    ], {requiredMethods: ['runAgentAction']});
    const created = createdResult.value;
    expect(createdResult.called).toBe(true);
    expect(created?.created).toBe(true);
    if (!createdResult.called || created?.created !== true) {
        throw new Error('Canonical note creation action did not create a note');
    }
    const tabId = created.tabId;
    if (!tabId || tabId !== tabIdBeforeCreate || created.markerRect === undefined) {
        throw new Error('Canonical note creation action did not return its document identity');
    }

    let stableKey: string | null = null;
    const stableKeyDeadline = Date.now() + XLARGE_SAVE_TIMEOUT_MS;
    while (!stableKey && Date.now() < stableKeyDeadline) {
        const notes = await readNotes();
        const newPageStableKeys = new Set<string>();
        for (const note of notes) {
            if (!note || typeof note !== 'object') {
                continue;
            }
            const candidate = note as Record<string, unknown>;
            const candidatePage = typeof candidate.pageNumber === 'number'
                ? candidate.pageNumber
                : Number(candidate.pageIndex) + 1;
            if (
                candidatePage === pageNumber
                && typeof candidate.stableKey === 'string'
                && !existingStableKeys.has(candidate.stableKey)
            ) {
                newPageStableKeys.add(candidate.stableKey);
            }
        }
        if (newPageStableKeys.size > 1) {
            throw new Error(`Expected one new page ${pageNumber} note, found ${newPageStableKeys.size}`);
        }
        stableKey = [...newPageStableKeys][0] ?? null;
        if (!stableKey) {
            const remainingMs = stableKeyDeadline - Date.now();
            if (remainingMs > 0) {
                await new Promise(resolve => setTimeout(resolve, Math.min(100, remainingMs)));
            }
        }
    }
    if (!stableKey) {
        throw new Error(`Canonical note ${text} did not publish a stable key`);
    }

    const updatedResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', [
        'annotation.update_note',
        {
            markerRect: created.markerRect,
            stableKey,
            text,
        },
    ], {requiredMethods: ['runAgentAction']});
    expect(updatedResult.called).toBe(true);
    expect(updatedResult.value?.updated).toBe(true);
    await waitForWorkspaceComment(page, text, pageNumber);
}

async function readOptionalRendererIpcPayloadProbe(page: Page): Promise<IRendererIpcPayloadProbe | null> {
    return page.evaluate(() => {
        const target = window as IRendererIpcPayloadProbeWindow;
        const candidates: Array<readonly [string, unknown]> = [
            [
                '__evbIpcPayloadProbe',
                target.__evbIpcPayloadProbe,
            ],
            [
                '__evbRendererIpcPayloadProbe',
                target.__evbRendererIpcPayloadProbe,
            ],
            [
                '__evbIpcPayloads',
                target.__evbIpcPayloads,
            ],
        ];
        for (const [
            name,
            value,
        ] of candidates) {
            if (!value || typeof value !== 'object') {
                continue;
            }
            const record = value as Record<string, unknown>;
            const directMax = [
                record.maxPayloadBytes,
                record.maxPayloadSizeBytes,
                record.maxBytes,
            ].find(candidate => typeof candidate === 'number' && Number.isFinite(candidate));
            const samples = [
                record.payloadBytes,
                record.payloadSizes,
                record.payloads,
                record.samples,
            ].find(Array.isArray) ?? (Array.isArray(value) ? value : null);
            const sampleNumbers = Array.isArray(samples)
                ? samples.flatMap(sample => {
                    if (typeof sample === 'number' && Number.isFinite(sample)) {
                        return [sample];
                    }
                    if (sample && typeof sample === 'object') {
                        const sampleRecord = sample as Record<string, unknown>;
                        const sampleValue = [
                            sampleRecord.payloadBytes,
                            sampleRecord.payloadSizeBytes,
                            sampleRecord.bytes,
                            sampleRecord.size,
                        ].find(candidate => typeof candidate === 'number' && Number.isFinite(candidate));
                        if (typeof sampleValue === 'number') {
                            return [sampleValue];
                        }
                        try {
                            const serialized = JSON.stringify(sample);
                            return serialized === undefined
                                ? []
                                : [new TextEncoder().encode(serialized).byteLength];
                        } catch {
                            return [];
                        }
                    }
                    return [];
                })
                : [];
            const maxPayloadBytes = typeof directMax === 'number'
                ? directMax
                : sampleNumbers.length > 0
                    ? Math.max(...sampleNumbers)
                    : null;
            const sampleCount = typeof record.sampleCount === 'number'
                ? record.sampleCount
                : Array.isArray(samples)
                    ? samples.length
                    : null;
            return {
                name,
                maxPayloadBytes,
                sampleCount,
            };
        }
        return null;
    });
}

function recordRendererIpcPayloadProbe(
    telemetry: IXlargeAcceptanceTelemetry,
    session: 'A' | 'B',
    probe: IRendererIpcPayloadProbe | null,
) {
    if (!probe) {
        return;
    }
    expect(probe.maxPayloadBytes).not.toBeNull();
    if (probe.maxPayloadBytes !== null) {
        telemetry.ipcPayloadMeasurements.push({
            bytes: probe.maxPayloadBytes,
            operation: 'renderer-probe',
            session,
        });
        expect(probe.maxPayloadBytes).toBeLessThanOrEqual(XLARGE_IPC_PAYLOAD_MAX_BYTES);
    }
}

async function writeTelemetry(telemetry: IXlargeAcceptanceTelemetry) {
    await mkdir(dirname(artifactPath), {recursive: true});
    await writeFile(
        artifactPath,
        `${JSON.stringify({
            ...telemetry,
            generatedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        'utf8',
    );
}

async function hashPath(path: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

xlargeDescribe('Electron E2E - xlarge document acceptance', () => {
    it('keeps embedded annotations across two sessions and a fresh renderer save/reopen', async () => {
        const telemetry = createTelemetry();
        const sourcePath = resolve(configuredFixture);
        let stagedFixture: IStagedFixture | null = null;
        let sessionA: IElectronE2ESession | null = null;
        let sessionB: IElectronE2ESession | null = null;
        let activeHeartbeat: (() => Promise<IHeartbeatSnapshot>) | null = null;
        let activeRssSampler: IRssSampler | null = null;
        let bodyFailure: unknown = null;

        try {
            stagedFixture = await timed(telemetry, 'fixture-stage-bounded', () => stageFixture(sourcePath));
            telemetry.fixture.sourcePath = stagedFixture.sourcePath;
            telemetry.fixture.stagedPath = stagedFixture.stagedPath;
            telemetry.fixture.sourceBytes = stagedFixture.sourceBytes;
            telemetry.fixture.stagedBytes = stagedFixture.stagedBytes;
            telemetry.fixture.cloneMode = stagedFixture.copyMode;
            telemetry.rendererJsHeapBudgetBytes = rendererJsHeapBudgetBytes(stagedFixture.sourceBytes);

            const pageCount = await timed(
                telemetry,
                'fixture-admission-qpdf-page-count',
                () => getPdfPageCount(stagedFixture!.stagedPath),
            );
            telemetry.fixture.pageCount = pageCount;
            expect(pageCount).toBe(XLARGE_PAGE_COUNT);

            // Session A is a normal open/render/index confirmation. It closes
            // cleanly before session B starts, so this does not claim crash
            // checkpoint recovery.
            sessionA = await timed(
                telemetry,
                'session-a-start',
                () => startElectronE2ESession(`e2e-xlarge-document-a-${Date.now()}`, {
                    clean: true,
                    initialOpenPaths: [stagedFixture!.stagedPath],
                    extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                }),
            );
            activeRssSampler = createRssSampler(
                sessionA.page,
                getSessionInfo(sessionA.name)?.electronPid ?? null,
            );
            activeHeartbeat = await startRendererHeartbeat(sessionA.page);
            await timed(telemetry, 'session-a-open', async () => {
                await waitForPdfLoaded(sessionA!.page, XLARGE_SAVE_TIMEOUT_MS);
                await waitForViewerInteractive(sessionA!.page, XLARGE_SAVE_TIMEOUT_MS);
            });
            for (const pageNumber of XLARGE_RENDER_PAGES) {
                await timed(
                    telemetry,
                    `session-a-render-page-${pageNumber}`,
                    () => waitForRenderedPage(sessionA!.page, pageNumber, XLARGE_SAVE_TIMEOUT_MS),
                );
            }

            const sessionAState = await readWorkspaceStateValues<{
                pdfSourceState?: IPdfSourceStateSnapshot;
                workingCopyPath?: string | null;
            }>(sessionA.page, [
                'pdfSourceState',
                'workingCopyPath',
            ]);
            expect(sessionAState.pdfSourceState).toEqual({
                hasInMemoryData: false,
                reloadKind: 'path',
                reloadPath: sessionAState.workingCopyPath,
            });
            const sessionAPath = sessionAState.pdfSourceState?.reloadPath
                ?? sessionAState.workingCopyPath
                ?? stagedFixture.stagedPath;
            const baselineIndex = await timed(
                telemetry,
                'session-a-read-baseline-annotation-index',
                () => readPdfAnnotationIndex(sessionA!.page, sessionAPath),
            );
            assertBaselineAnnotationIndex(baselineIndex);
            const baselineStructuralSummary = await timed(
                telemetry,
                'session-a-read-baseline-structural-summary',
                () => readStructuralObjectSummary(stagedFixture!.stagedPath, baselineIndex),
            );
            recordAnnotationIndexPayloads(telemetry, 'A', baselineIndex);

            const closedA = await callWorkspaceCommand<boolean>(sessionA.page, 'handleCloseFileFromUi', [{persist: false}]);
            expect(closedA).toEqual({
                called: true,
                value: true,
            });
            const heartbeatA = await activeHeartbeat();
            telemetry.heartbeats.push({
                session: 'A',
                stage: 'open-render-confirm-close',
                ...heartbeatA,
            });
            activeHeartbeat = null;
            const rssA = await activeRssSampler.stop();
            telemetry.rss.push({
                session: 'A',
                ...rssA,
            });
            activeRssSampler = null;
            await sessionA.stop();
            sessionA = null;

            // Session B is a fresh Electron process opening the same staged
            // path, then creating two notes through the EVB-owned surface.
            sessionB = await timed(
                telemetry,
                'session-b-start',
                () => startElectronE2ESession(`e2e-xlarge-document-b-${Date.now()}`, {
                    clean: true,
                    initialOpenPaths: [stagedFixture!.stagedPath],
                    extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                }),
            );
            activeRssSampler = createRssSampler(
                sessionB.page,
                getSessionInfo(sessionB.name)?.electronPid ?? null,
            );
            activeHeartbeat = await startRendererHeartbeat(sessionB.page);
            await timed(telemetry, 'session-b-open', async () => {
                await waitForPdfLoaded(sessionB!.page, XLARGE_SAVE_TIMEOUT_MS);
                await waitForViewerInteractive(sessionB!.page, XLARGE_SAVE_TIMEOUT_MS);
            });
            const sessionBOpenState = await readWorkspaceStateValues<{
                originalPath?: string | null;
                pdfSourceState?: IPdfSourceStateSnapshot;
                workingCopyPath?: string | null;
            }>(sessionB.page, [
                'originalPath',
                'pdfSourceState',
                'workingCopyPath',
            ]);
            expect(sessionBOpenState.pdfSourceState).toEqual({
                hasInMemoryData: false,
                reloadKind: 'path',
                reloadPath: sessionBOpenState.workingCopyPath,
            });
            await waitForRenderedPage(sessionB.page, XLARGE_MIDDLE_PAGE, XLARGE_SAVE_TIMEOUT_MS);
            await openAnnotationsTab(sessionB.page, XLARGE_SAVE_TIMEOUT_MS);
            await startRendererPlacementSampling(sessionB.page);
            await startRendererLongTaskProbe(sessionB.page);
            await waitForDetachedEditorLayers(sessionB.page);
            const canonicalNoteOne = `xlarge canonical note one ${Date.now()}`;
            await timed(
                telemetry,
                'session-b-canonical-note-one',
                () => createCanonicalNoteViaAgentAction(
                    sessionB!.page,
                    canonicalNoteOne,
                    XLARGE_MIDDLE_PAGE,
                    0.28,
                    0.31,
                ),
            );
            const canonicalNoteTwo = `xlarge canonical note two ${Date.now()}`;
            await timed(
                telemetry,
                'session-b-canonical-note-two',
                () => createCanonicalNoteViaAgentAction(
                    sessionB!.page,
                    canonicalNoteTwo,
                    XLARGE_MIDDLE_PAGE,
                    0.57,
                    0.42,
                ),
            );
            telemetry.rendererPlacementSampling = await readRendererPlacementSampling(sessionB.page);
            const dirtyState = await readWorkspaceStateValues<{
                annotationDirty?: boolean;
                dirtyState?: {annotationDirtyEntityCount?: number;};
            }>(sessionB.page, [
                'annotationDirty',
                'dirtyState',
            ]);
            expect(dirtyState.annotationDirty).toBe(true);
            expect(dirtyState.dirtyState?.annotationDirtyEntityCount ?? 0).toBeGreaterThan(0);
            await waitForDetachedEditorLayers(sessionB.page);

            if (activeHeartbeat) {
                const heartbeatBeforeSave = await activeHeartbeat();
                telemetry.heartbeats.push({
                    session: 'B',
                    stage: 'session-b-before-save',
                    ...heartbeatBeforeSave,
                });
            }
            activeHeartbeat = await startRendererHeartbeat(sessionB.page);
            await installSaveReceiptProbe(sessionB.page);
            const saveTargetPath = sessionBOpenState.pdfSourceState?.reloadPath
                ?? sessionBOpenState.workingCopyPath
                ?? stagedFixture.stagedPath;
            const saveEventPath = sessionBOpenState.originalPath
                ?? saveTargetPath;
            const saveEvent = await timed(
                telemetry,
                'session-b-save-window-handle',
                () => saveViaVisibleToolbarWithDeadline(
                    sessionB!.page,
                    XLARGE_SAVE_TIMEOUT_MS,
                    saveEventPath,
                    {
                        label: 'xlarge PDF session B visible toolbar save',
                        onTimeout: () => sessionB!.stop(),
                        diagnostics: () => 'phase=session-b-save-window-handle',
                    },
                ),
            );
            expect(saveEvent.detail.path).toBe(saveEventPath);
            expect(saveEvent.detail.documentRevisionToken).toEqual(expect.any(String));
            await waitForViewerInteractive(sessionB.page, XLARGE_SAVE_TIMEOUT_MS);

            const saveReceipt = await sessionB.page.evaluate(
                () => (window as ISaveReceiptProbeWindow).__saveReceiptProbe ?? null,
            );
            expect(saveReceipt?.nativeProjectionEngaged).toBe(true);
            expect(saveReceipt?.barrierFinished).toBe(true);
            expect(saveReceipt?.stagedArtifact).toMatchObject({
                artifactKind: 'pdf',
                receiptVersion: 2,
            });
            const saveReceiptPayloadBytes = await sessionB.page.evaluate(() => {
                const receipt = (window as ISaveReceiptProbeWindow).__saveReceiptProbe;
                if (!receipt) {
                    throw new Error('Save receipt probe did not produce a payload');
                }
                const serialized = JSON.stringify(receipt);
                if (serialized === undefined) {
                    throw new Error('Save receipt probe payload was not serializable');
                }
                return new TextEncoder().encode(serialized).byteLength;
            });
            expect(saveReceiptPayloadBytes).toBeGreaterThan(0);
            expect(saveReceiptPayloadBytes).toBeLessThanOrEqual(XLARGE_IPC_PAYLOAD_MAX_BYTES);
            telemetry.ipcPayloadMeasurements.push({
                bytes: saveReceiptPayloadBytes,
                operation: 'save-receipt',
                session: 'B',
            });
            const rendererIpcPayloadProbeBeforeReload = await readOptionalRendererIpcPayloadProbe(sessionB.page);
            telemetry.rendererIpcPayloadProbe = rendererIpcPayloadProbeBeforeReload;
            recordRendererIpcPayloadProbe(telemetry, 'B', rendererIpcPayloadProbeBeforeReload);
            const savedState = await readWorkspaceStateValues<{
                documentRevisionToken?: string | null;
                pdfSourceState?: IPdfSourceStateSnapshot;
                workingCopyPath?: string | null;
            }>(sessionB.page, [
                'documentRevisionToken',
                'pdfSourceState',
                'workingCopyPath',
            ]);
            expect(savedState.pdfSourceState).toEqual({
                hasInMemoryData: false,
                reloadKind: 'path',
                reloadPath: savedState.workingCopyPath,
            });
            const savedPath = savedState.pdfSourceState?.reloadPath
                ?? savedState.workingCopyPath
                ?? stagedFixture.stagedPath;
            expect(savedPath).toBe(saveTargetPath);
            const heartbeatBeforeReload = await activeHeartbeat();
            telemetry.rendererLongTasks = await readRendererLongTaskProbe(sessionB.page);
            telemetry.heartbeats.push({
                session: 'B',
                stage: 'save-before-fresh-renderer-reopen',
                ...heartbeatBeforeReload,
            });
            activeHeartbeat = null;
            await timed(telemetry, 'saved-output-qpdf-check', () => assertQpdfCheck(savedPath));
            const savedContentHash = await hashPath(savedPath);
            await timed(telemetry, 'fresh-renderer-reload', async () => {
                await sessionB!.page.reload({waitUntil: 'domcontentloaded'});
                activeHeartbeat = await startRendererHeartbeat(sessionB!.page);
                await waitForPdfLoaded(sessionB!.page, XLARGE_SAVE_TIMEOUT_MS);
                await waitForViewerInteractive(sessionB!.page, XLARGE_SAVE_TIMEOUT_MS);
            });

            await expect.poll(
                async () => {
                    const state = await readWorkspaceStateValues<{
                        documentRevisionToken?: string | null;
                        pdfSourceState?: IPdfSourceStateSnapshot;
                        workingCopyPath?: string | null;
                    }>(sessionB!.page, [
                        'documentRevisionToken',
                        'pdfSourceState',
                        'workingCopyPath',
                    ]);
                    const reopenedPath = state.pdfSourceState?.reloadPath
                        ?? state.workingCopyPath
                        ?? null;
                    return typeof reopenedPath === 'string' && existsSync(reopenedPath);
                },
                {timeout: XLARGE_SAVE_TIMEOUT_MS},
            ).toBe(true);
            const reopenedState = await readWorkspaceStateValues<{
                documentRevisionToken?: string | null;
                pdfSourceState?: IPdfSourceStateSnapshot;
                workingCopyPath?: string | null;
            }>(sessionB.page, [
                'documentRevisionToken',
                'pdfSourceState',
                'workingCopyPath',
            ]);
            expect(reopenedState.documentRevisionToken).toBe(savedState.documentRevisionToken);
            expect(reopenedState.pdfSourceState).toEqual({
                hasInMemoryData: false,
                reloadKind: 'path',
                reloadPath: reopenedState.workingCopyPath,
            });
            const reopenedPath = reopenedState.pdfSourceState?.reloadPath
                ?? reopenedState.workingCopyPath
                ?? null;
            expect(reopenedPath).toEqual(expect.any(String));
            if (!reopenedPath) {
                throw new Error('Reopened workspace state did not expose a working-copy path');
            }
            expect(existsSync(reopenedPath)).toBe(true);
            // A fresh renderer reload may rematerialize the disposable working
            // copy, so its path is not a durable identity. The saved bytes and
            // revision remain the real save/reopen contract.
            expect(await hashPath(reopenedPath)).toBe(savedContentHash);
            await waitForDetachedEditorLayers(sessionB.page);
            const finalIndex = await timed(
                telemetry,
                'fresh-renderer-read-final-annotation-index',
                () => readPdfAnnotationIndex(sessionB!.page, reopenedPath),
            );
            const finalStructuralSummary = await timed(
                telemetry,
                'fresh-renderer-read-final-structural-summary',
                () => readStructuralObjectSummary(reopenedPath, finalIndex),
            );
            assertBoundedStructuralChange(
                telemetry,
                baselineStructuralSummary,
                finalStructuralSummary,
            );
            const {canonicalNotes} = assertFinalAnnotationIndex(finalIndex);
            recordAnnotationIndexPayloads(telemetry, 'B', finalIndex);
            await waitForRenderedPage(sessionB.page, XLARGE_MIDDLE_PAGE, XLARGE_SAVE_TIMEOUT_MS);
            await timed(telemetry, 'fresh-renderer-read-annotation-objects', () => (
                assertAnnotationObjectsContainTexts(
                    reopenedPath,
                    canonicalNotes,
                    [
                        canonicalNoteOne,
                        canonicalNoteTwo,
                    ],
                )
            ));
            await waitForWorkspaceComment(sessionB.page, canonicalNoteOne, XLARGE_MIDDLE_PAGE, 'pdf');
            await waitForWorkspaceComment(sessionB.page, canonicalNoteTwo, XLARGE_MIDDLE_PAGE, 'pdf');

            const rendererIpcPayloadProbeAfterReload = await readOptionalRendererIpcPayloadProbe(sessionB.page);
            recordRendererIpcPayloadProbe(telemetry, 'B', rendererIpcPayloadProbeAfterReload);
            if (rendererIpcPayloadProbeAfterReload) {
                telemetry.rendererIpcPayloadProbe = rendererIpcPayloadProbeAfterReload;
            }

            const heartbeatB = await activeHeartbeat!();
            telemetry.heartbeats.push({
                session: 'B',
                stage: 'fresh-renderer-reopen-final-index',
                ...heartbeatB,
            });
            activeHeartbeat = null;
            const rssB = await activeRssSampler.stop();
            telemetry.rss.push({
                session: 'B',
                ...rssB,
            });
            activeRssSampler = null;
            for (const heartbeat of telemetry.heartbeats) {
                expect(heartbeat.sampleCount).toBeGreaterThan(0);
                expect(heartbeat.maxGapMs).toBeLessThan(XLARGE_HEARTBEAT_MAX_GAP_MS);
                expect(heartbeat.messageChannelMaxGapStartEpochMs).not.toBeNull();
                expect(heartbeat.messageChannelMaxGapEndEpochMs).not.toBeNull();
            }
            for (const rss of telemetry.rss) {
                expect(rss.rendererJsHeapDeltaBytes).not.toBeNull();
                expect(rss.rendererJsHeapDeltaBytes).toBeLessThanOrEqual(telemetry.rendererJsHeapBudgetBytes);
            }
            assertMeasuredIpcPayloadBudget(telemetry);
        } catch (error) {
            telemetry.failure = {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack ?? null : null,
            };
            bodyFailure = error;
        }
        await runElectronE2ETeardown(bodyFailure, [
            {
                label: 'session B heartbeat',
                run: async () => {
                    if (!activeHeartbeat || !sessionB) {
                        return;
                    }
                    const heartbeat = await activeHeartbeat();
                    telemetry.heartbeats.push({
                        session: 'B',
                        stage: 'failure-cleanup',
                        ...heartbeat,
                    });
                },
            },
            {
                label: 'RSS sampler',
                run: async () => {
                    if (!activeRssSampler) {
                        return;
                    }
                    const rss = await activeRssSampler.stop();
                    telemetry.rss.push({
                        session: sessionB ? 'B' : 'A',
                        ...rss,
                    });
                },
            },
            {
                label: 'session B stop',
                run: async () => {
                    await sessionB?.stop();
                },
            },
            {
                label: 'session A stop',
                run: async () => {
                    await sessionA?.stop();
                },
            },
            {
                label: 'staged fixture removal',
                run: async () => {
                    if (!stagedFixture) {
                        return;
                    }
                    await rm(stagedFixture.stagingDirectory, {
                        force: true,
                        recursive: true,
                    });
                },
            },
            {
                label: 'telemetry write',
                run: () => writeTelemetry(telemetry),
            },
        ]);
    }, XLARGE_TEST_TIMEOUT_MS);
});
