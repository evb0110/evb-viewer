// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {writeFileSync} from 'node:fs';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {Ref} from 'vue';
import {
    computed,
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
    ref,
} from 'vue';
import type {
    IScanCleanupCapability,
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupPreviewRequest,
    IScanCleanupRawPreviewEvent,
    TScanCleanupPreviewWireResult,
} from '@contracts/electronApiScanCleanup';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireRequestId} from '@contracts/shared';
import type * as scanCleanupPreviewCacheModule from '@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache';
import type {IScanCleanupPreviewCache} from '@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache';
import {useScanCleanupPreviewSession} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewSession';

// M2 (U21), page 200 of the reference document, cold: one cleaned preview costs
// 2412 ms. M1: its raw PNG is 1 056 837 B. The raster is modelled as free, the
// same simplification U21's m6-cache-behaviour.ts made, so the rows below stay
// comparable with the baseline it recorded.
const PREVIEW_MS = 2412;
const PAGE_BYTES = 1_056_837;
const TOTAL_PAGES = 392;

const capability = vi.hoisted(() => ({value: null as IScanCleanupCapability | null}));
const cacheProbe = vi.hoisted(() => ({instances: [] as IScanCleanupPreviewCache[]}));

vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));
vi.mock('@app/composables/useTypedI18n', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));
vi.mock('@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache', async importOriginal => {
    const actual = await importOriginal<typeof scanCleanupPreviewCacheModule>();
    return {
        ...actual,
        createScanCleanupPreviewCache: (options?: Parameters<typeof actual.createScanCleanupPreviewCache>[0]) => {
            const cache = actual.createScanCleanupPreviewCache(options);
            cacheProbe.instances.push(cache);
            return cache;
        },
    };
});

function scanCleanupOptions(): IScanCleanupOptions {
    return {
        preserveOriginalQuality: false,
        layoutMode: 'auto',
        outputMode: 'auto',
        binarization: 'auto',
        normalizeIllumination: true,
        readingOrder: 'ltr',
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center',
        marginsMm: {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        },
        despeckleLevel: 'normal',
        autoDewarp: false,
        skipBlankPages: false,
        pageOverrides: {},
    };
}

const pixelRect = {
    xPx: 0,
    yPx: 0,
    widthPx: 883,
    heightPx: 1335,
};

// A base preview answers without the raster: those bytes crossed once already,
// as the `onPreviewRaw` this backend pushes when the request starts.
function previewResult(pageNumber: number, requestId?: string): TScanCleanupPreviewWireResult {
    const bytes = new Uint8Array(new ArrayBuffer(PAGE_BYTES));
    return {
        ...(requestId === undefined ? {} : {requestId: requireRequestId(requestId)}),
        pageNumber: requirePageNumber(pageNumber),
        totalPages: TOTAL_PAGES,
        rawWidthPx: 883,
        rawHeightPx: 1335,
        pageMetadata: {
            canvasScope: 'page',
            layoutClassification: 'single-uncut-page',
            layoutConfidence: 0.9,
            cutterXPx: null,
            rotationDegrees: 0,
            excluded: false,
            blankOutputsSkipped: 0,
            tier1Verdict: 'single-uncut-page',
            reconciled: false,
            clusterAgreement: 0,
        },
        outputs: [{
            imageData: bytes,
            metadata: {
                canvasScope: 'page',
                half: 'full',
                warnings: [],
                forwardTransform: {matrix: [
                    [
                        1,
                        0,
                        0,
                    ],
                    [
                        0,
                        1,
                        0,
                    ],
                    [
                        0,
                        0,
                        1,
                    ],
                ]},
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
                sourceRegion: pixelRect,
                contentBox: pixelRect,
                appliedMargins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
                outputWidthPx: 883,
                outputHeightPx: 1335,
                canvasWidthPx: 883,
                canvasHeightPx: 1335,
                placementOffsetXPx: 0,
                placementOffsetYPx: 0,
                cutterXPx: null,
                inputWidthPx: 883,
                inputHeightPx: 1335,
                rotationDegrees: 0,
                resamplePasses: 1,
            },
        }],
    };
}

interface IPendingPreview {
    identity: string;
    pageNumber: number;
    promise: Promise<TScanCleanupPreviewWireResult>;
    readyAtMs: number;
    startedAtMs: number;
    resolve: () => void;
    reject: () => void;
}

/**
 * Stands in for createScanCleanupPreviewService over the IPC boundary: base
 * requests are identified by page and content, an identical request joins the
 * one already running instead of spawning again, a spawned request pushes its
 * page raster back before it renders anything, and a cancellation only aborts
 * the pages it was not told to retain.
 */
function previewBackend() {
    let pending: IPendingPreview[] = [];
    const rawListeners = new Set<(raw: IScanCleanupRawPreviewEvent) => void>();
    const counters = {
        spawns: 0,
        joins: 0,
        aborted: 0,
        completed: 0,
    };
    // Every full-page raster this backend puts on the wire, in order. A base
    // result carries none: the raster is the event above.
    const rasterPayloadPages: number[] = [];
    const identityOf = (request: IScanCleanupPreviewRequest) => JSON.stringify([
        request.pageNumber,
        request.options,
        request.documentPrior ?? null,
        request.outputModeRecommendation ?? null,
        request.detail ?? null,
    ]);
    const preview = (request: IScanCleanupPreviewRequest) => {
        const identity = identityOf(request);
        const joined = pending.find(entry => entry.identity === identity);
        if (joined) {
            counters.joins += 1;
            return joined.promise;
        }
        counters.spawns += 1;
        // The service materializes the page raster and pushes it a whole
        // sidecar run before the cleaned outputs it eventually answers with.
        rasterPayloadPages.push(request.pageNumber);
        for (const listener of rawListeners) {
            listener({
                ownerId: request.ownerId,
                documentRevision: request.documentRevision,
                requestId: request.requestId,
                pageNumber: request.pageNumber,
                totalPages: TOTAL_PAGES,
                rawImageData: new Uint8Array(new ArrayBuffer(PAGE_BYTES)),
                rawWidthPx: 883,
                rawHeightPx: 1335,
            });
        }
        const settled = Promise.withResolvers<TScanCleanupPreviewWireResult>();
        const entry: IPendingPreview = {
            identity,
            pageNumber: request.pageNumber,
            readyAtMs: Date.now() + PREVIEW_MS,
            startedAtMs: Date.now(),
            promise: settled.promise,
            resolve: () => {
                counters.completed += 1;
                settled.resolve(previewResult(request.pageNumber, request.requestId));
            },
            // Cancellation answers the request; the service reports it as a
            // result so a page turn is not logged as a handler failure.
            reject: () => {
                counters.aborted += 1;
                settled.resolve({canceled: true});
            },
        };
        pending.push(entry);
        return entry.promise;
    };
    const previewCalls = vi.fn(preview);
    const value: IScanCleanupCapability = {
        preview: previewCalls,
        cancelPreview: vi.fn(async (request: IScanCleanupPreviewCancelRequest) => {
            const retained = new Set(request.retainPages ?? []);
            const doomed = pending.filter(entry => !retained.has(entry.pageNumber));
            pending = pending.filter(entry => retained.has(entry.pageNumber));
            for (const entry of doomed) entry.reject();
            return doomed.length > 0;
        }),
        detectAll: vi.fn(),
        cancelDetection: vi.fn(),
        getDetectionJobState: vi.fn(),
        subscribeDetectionJob: vi.fn(),
        start: vi.fn(),
        cancel: vi.fn(),
        getJobState: vi.fn(),
        subscribeJob: vi.fn(),
        reconnectJob: vi.fn(),
        pruneGeneratedOutputs: vi.fn(),
        onPreviewRaw: vi.fn((listener: (raw: IScanCleanupRawPreviewEvent) => void) => {
            rawListeners.add(listener);
            return () => rawListeners.delete(listener);
        }),
        onJobState: vi.fn(),
        onDetectionJobState: vi.fn(),
    };
    return {
        capability: value,
        counters,
        previewCalls,
        rasterPayloadPages,
        get inFlightPages() {
            return pending.map(entry => entry.pageNumber);
        },
        startedAtMsFor: (pageNumber: number) => pending.find(entry => entry.pageNumber === pageNumber)?.startedAtMs,
        // Retires a run the way the main process does when its generation is
        // superseded or its prefetch lease is dropped: the invoke answers
        // `canceled` without the renderer having asked for anything.
        retire(pageNumber: number) {
            const doomed = pending.filter(entry => entry.pageNumber === pageNumber);
            pending = pending.filter(entry => entry.pageNumber !== pageNumber);
            for (const entry of doomed) entry.reject();
            return doomed.length;
        },
        // Advances the virtual clock, settling every preview whose modelled cost
        // has elapsed and letting the awaiting composable run between each.
        async advanceBy(durationMs: number) {
            const until = Date.now() + durationMs;
            while (Date.now() < until) {
                const next = pending
                    .filter(entry => entry.readyAtMs <= until)
                    .sort((left, right) => left.readyAtMs - right.readyAtMs)[0];
                const target = Math.min(next?.readyAtMs ?? until, Date.now() + 25, until);
                vi.advanceTimersByTime(Math.max(0, target - Date.now()));
                for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
                const due = pending.filter(entry => entry.readyAtMs <= Date.now());
                pending = pending.filter(entry => entry.readyAtMs > Date.now());
                for (const entry of due) {
                    entry.resolve();
                    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
                }
            }
        },
    };
}

function mountPreviewSession(
    previewPage: Ref<number>,
    documentPriorByPage: Map<number, IScanCleanupDocumentPrior>,
    initialViewMode?: 'original' | 'cleaned',
    lifecycleKey?: Ref<string>,
) {
    let session: ReturnType<typeof useScanCleanupPreviewSession> | null = null;
    const settings = reactive(scanCleanupOptions());
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup() {
        session = useScanCleanupPreviewSession({
            active: () => true,
            authoritativeLayoutByPage: computed(() => new Map()),
            documentCanvasSignature: computed(() => ''),
            documentRevision: computed(() => 'revision-1'),
            documentPriorByPage,
            ...(initialViewMode === undefined ? {} : {initialViewMode}),
            layoutDetectionComplete: computed(() => false),
            lifecycleDocumentKey: computed(() => requireDocumentRef(`/docs/${lifecycleKey?.value ?? 'reference.pdf'}`)),
            ownerId: 'owner-1',
            pagePlanEvidenceByPage: new Map(),
            placementAnchorsByPage: computed(() => new Map()),
            previewPage,
            recommendedOutputModeByPage: new Map(),
            softAlphaForegroundRecommendationByPage: new Map(),
            selectPage: page => { previewPage.value = page; },
            settings,
            sourcePath: computed(() => requireDocumentRef('/docs/reference.pdf')),
            totalPages: computed(() => TOTAL_PAGES),
        });
        return () => h('div');
    }}));
    app.mount(host);
    return {
        session: session!,
        settings,
        unmount() {
            app.unmount();
            host.remove();
        },
    };
}

interface IScenario {
    name: string;
    description: string;
    pages: number[];
    intervalMs: number;
    intervalsMs?: number[];
    detectionCompletesAfter?: number;
}

const SCENARIOS: IScenario[] = [
    {
        name: 'read-forward-slow',
        description: 'reading: one page every 4 s, forward',
        pages: Array.from({length: 20}, (_unused, index) => 100 + index),
        intervalMs: 4_000,
    },
    {
        name: 'read-forward-page-turn',
        description: 'page-turning at the speed a preview takes: one page every 2.4 s',
        pages: Array.from({length: 20}, (_unused, index) => 100 + index),
        intervalMs: PREVIEW_MS,
    },
    {
        name: 'flick-forward',
        description: 'flicking the rail: one page every 400 ms, forward',
        pages: Array.from({length: 20}, (_unused, index) => 100 + index),
        intervalMs: 400,
    },
    {
        name: 'flick-then-settle',
        description: 'flick 10 pages at 400 ms, then settle and step around at 4 s',
        pages: [
            ...Array.from({length: 10}, (_unused, index) => 100 + index),
            108,
            107,
            108,
            109,
            110,
        ],
        intervalMs: 400,
        intervalsMs: [
            ...Array.from({length: 9}, () => 400),
            10_000,
            4_000,
            4_000,
            4_000,
            4_000,
            4_000,
        ],
    },
    {
        name: 'compare-two-pages',
        description: 'A/B between two facing pages, 3 s apart',
        pages: [
            200,
            201,
            200,
            201,
            200,
            201,
            200,
            201,
        ],
        intervalMs: 3_000,
    },
    {
        name: 'window-of-five',
        description: 'wandering inside a 5-page window, 3 s apart',
        pages: [
            200,
            202,
            201,
            203,
            204,
            202,
            200,
            203,
            201,
            204,
            202,
            200,
        ],
        intervalMs: 3_000,
    },
    {
        name: 'window-of-ten',
        description: 'wandering inside a 10-page window, 3 s apart — wider than the 8-entry cache',
        pages: [
            200,
            205,
            202,
            208,
            201,
            209,
            203,
            206,
            200,
            207,
            204,
            205,
            202,
            208,
        ],
        intervalMs: 3_000,
    },
    {
        name: 'detection-lands-midway',
        description: 'read 6 pages, detection completes and rewrites documentPrior, revisit the same 6',
        pages: [
            200,
            201,
            202,
            203,
            204,
            205,
            205,
            204,
            203,
            202,
            201,
            200,
        ],
        intervalMs: 4_000,
        detectionCompletesAfter: 6,
    },
];

async function runScenario(scenario: IScenario) {
    cacheProbe.instances.length = 0;
    const backend = previewBackend();
    capability.value = backend.capability;
    const previewPage = ref(scenario.pages[0]!);
    const documentPriorByPage = reactive(new Map<number, IScanCleanupDocumentPrior>());
    const mounted = mountPreviewSession(previewPage, documentPriorByPage);
    const cache = cacheProbe.instances[0]!;
    const counters = {
        navigations: 0,
        visibleHits: 0,
        visibleMisses: 0,
        settledHits: 0,
        settledNavigations: 0,
        orphanedByPriorChange: 0,
    };
    const settledFrom = scenario.intervalsMs?.findIndex(interval => interval >= 4_000) ?? -1;

    for (const [
        index,
        pageNumber,
    ] of scenario.pages.entries()) {
        if (scenario.detectionCompletesAfter === index) {
            counters.orphanedByPriorChange += cache.size;
            for (let page = 1; page <= TOTAL_PAGES; page += 1) {
                documentPriorByPage.set(page, {
                    dominantLayout: 'single-uncut-page',
                    agreementStrength: 0.74,
                } as IScanCleanupDocumentPrior);
            }
            await nextTick();
        }
        previewPage.value = pageNumber;
        await nextTick();
        counters.navigations += 1;
        const hit = !mounted.session.loading.value && mounted.session.result.value?.pageNumber === pageNumber;
        if (hit) counters.visibleHits += 1;
        else counters.visibleMisses += 1;
        if (settledFrom >= 0 && index > settledFrom) {
            counters.settledNavigations += 1;
            if (hit) counters.settledHits += 1;
        }
        await backend.advanceBy(scenario.intervalsMs?.[index] ?? scenario.intervalMs);
    }

    const row = {
        name: scenario.name,
        description: scenario.description,
        navigations: counters.navigations,
        visibleHits: counters.visibleHits,
        visibleMisses: counters.visibleMisses,
        hitRate: Number((counters.visibleHits / counters.navigations).toFixed(3)),
        settledHitRate: counters.settledNavigations === 0
            ? null
            : Number((counters.settledHits / counters.settledNavigations).toFixed(3)),
        previewCalls: backend.previewCalls.mock.calls.length,
        previewSpawns: backend.counters.spawns,
        previewJoins: backend.counters.joins,
        previewCompleted: backend.counters.completed,
        previewAborted: backend.counters.aborted,
        wasteRate: backend.counters.spawns === 0
            ? 0
            : Number((backend.counters.aborted / backend.counters.spawns).toFixed(3)),
        orphanedByPriorChange: counters.orphanedByPriorChange,
        finalCacheEntries: cache.size,
        finalCacheBytes: cache.byteLength,
    };
    mounted.unmount();
    capability.value = null;
    return row;
}

describe('scan cleanup preview navigation', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });

    afterEach(() => {
        vi.useRealTimers();
        capability.value = null;
        cacheProbe.instances.length = 0;
    });

    it('uses opaque fixed-size preview request IDs instead of embedding cache identity', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const mounted = mountPreviewSession(ref(100), reactive(new Map()));

        await backend.advanceBy(1);

        const requestId = backend.previewCalls.mock.calls[0]![0].requestId;
        expect(requestId).toMatch(/^scan-cleanup-preview-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
        expect(new TextEncoder().encode(requestId).byteLength).toBeLessThanOrEqual(128);
        expect(requestId).not.toContain('owner-1');
        expect(requestId).not.toContain('/docs/reference.pdf');
        mounted.unmount();
    });

    it('keeps navigation from destroying the preview work it just caused', async () => {
        const rows = [];
        for (const scenario of SCENARIOS) rows.push(await runScenario(scenario));
        // Opt-in so the same run that gates the thresholds also produces the
        // comparable table; unset, the suite writes nothing.
        if (process.env.SCAN_CLEANUP_NAVIGATION_REPORT) {
            writeFileSync(process.env.SCAN_CLEANUP_NAVIGATION_REPORT, `${JSON.stringify({
                previewMs: PREVIEW_MS,
                pageBytes: PAGE_BYTES,
                rows,
            }, null, 2)}\n`);
        }
        const byName = new Map(rows.map(row => [
            row.name,
            row,
        ]));

        // Reading forward at 4 s a page used to hit the cache never — the
        // adjacent prefetch only starts once the visible page has rendered, and
        // the next navigation killed it before it could finish.
        expect(byName.get('read-forward-slow')!.hitRate).toBeGreaterThan(0.5);
        expect(byName.get('read-forward-slow')!.previewSpawns).toBeLessThan(30);
        expect(byName.get('read-forward-slow')!.wasteRate).toBeLessThan(0.1);
        // Turning a page every 2.4 s used to render nothing at all: every
        // request was aborted by the following turn.
        expect(byName.get('read-forward-page-turn')!.previewCompleted).toBeGreaterThan(10);
        expect(byName.get('read-forward-page-turn')!.finalCacheEntries).toBeGreaterThan(0);
        // D3 — a 20-navigation flick used to end with an empty cache, and D2 —
        // it used to waste every preview it started, 20 of them.
        expect(byName.get('flick-forward')!.finalCacheEntries).toBeGreaterThan(0);
        expect(byName.get('flick-forward')!.wasteRate).toBeLessThan(0.5);
        expect(byName.get('flick-forward')!.previewSpawns).toBeLessThan(6);
        // D1 — the steps after a flick settles, and the previews the flick threw away.
        expect(byName.get('flick-then-settle')!.settledHitRate).toBeGreaterThan(0.5);
        expect(byName.get('flick-then-settle')!.wasteRate).toBeLessThan(0.5);
        // Detection landing mid-read rewrites every key; the pages read after it
        // used to miss every time.
        expect(byName.get('detection-lands-midway')!.hitRate).toBeGreaterThan(0.3);
    });

    it('cancels in-flight work and discards results from a retired lifecycle', async () => {
        const backend = previewBackend();
        const retiredPreview = Promise.withResolvers<TScanCleanupPreviewWireResult>();
        const preview = vi.fn((_request: IScanCleanupPreviewRequest) => retiredPreview.promise);
        const cancelPreview = vi.fn(async () => true);
        capability.value = {
            ...backend.capability,
            preview,
            cancelPreview,
        };
        const lifecycleKey = ref('reference.pdf:0');
        const mounted = mountPreviewSession(ref(100), reactive(new Map()), undefined, lifecycleKey);
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        expect(preview).toHaveBeenCalledOnce();
        cancelPreview.mockClear();

        lifecycleKey.value = 'reference.pdf:1';
        await nextTick();

        expect(cancelPreview).toHaveBeenCalledWith(expect.objectContaining({
            sourcePdfPath: '/docs/reference.pdf',
            ownerId: 'owner-1',
            documentRevision: 'revision-1',
            invalidateRawCache: true,
        }));
        const retiredResult = previewResult(100);
        if (retiredResult.canceled === true) throw new Error('fixture unexpectedly canceled');
        retiredPreview.resolve({
            ...retiredResult,
            rawImageData: new Uint8Array(new ArrayBuffer(PAGE_BYTES)),
        });
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

        expect(mounted.session.metadataByPage.size).toBe(0);
        expect(cacheProbe.instances[0]?.size).toBe(0);
        mounted.unmount();
    });

    it('reschedules the visible page after its lifecycle generation changes', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const lifecycleKey = ref('reference.pdf:0');
        const mounted = mountPreviewSession(previewPage, reactive(new Map()), undefined, lifecycleKey);

        await backend.advanceBy(PREVIEW_MS + 500);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        const callsBefore = backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === 100).length;

        lifecycleKey.value = 'reference.pdf:1';
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        await backend.advanceBy(PREVIEW_MS + 500);

        expect(backend.previewCalls.mock.calls.filter(([request]) => request.pageNumber === 100)).toHaveLength(callsBefore + 1);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        mounted.unmount();
    });

    it('keeps a mismatched preview when cancellation retires its pending refresh', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const documentPriorByPage = reactive(new Map<number, IScanCleanupDocumentPrior>());
        const mounted = mountPreviewSession(previewPage, documentPriorByPage);

        await backend.advanceBy(PREVIEW_MS + 500);
        expect(mounted.session.resultCurrent.value).toBe(true);
        expect(mounted.session.result.value?.pageNumber).toBe(100);

        // A settled detection/settings fact changes the request key, but the
        // replacement preview is still waiting on its debounce when Run takes
        // ownership and cancels preview work without invalidating raw caches.
        documentPriorByPage.set(100, {
            dominantLayout: 'single-uncut-page',
            cutterRatioMedian: null,
            clusterDims: {
                widthPx: 883,
                heightPx: 1335,
            },
            agreementStrength: 0.74,
        });
        await nextTick();
        expect(mounted.session.resultCurrent.value).toBe(false);

        mounted.session.cancel(false);

        expect(mounted.session.loading.value).toBe(false);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        expect(mounted.session.rawResult.value?.pageNumber).toBe(100);
        mounted.unmount();
    });

    it('keeps the last completed frame when a final run pauses a pending authoritative refresh', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const documentPriorByPage = reactive(new Map<number, IScanCleanupDocumentPrior>());
        const mounted = mountPreviewSession(previewPage, documentPriorByPage);

        await backend.advanceBy(PREVIEW_MS + 500);
        const completed = mounted.session.result.value;
        const raw = mounted.session.rawResult.value;
        expect(mounted.session.resultCurrent.value).toBe(true);

        documentPriorByPage.set(100, {
            dominantLayout: 'single-uncut-page',
            cutterRatioMedian: null,
            clusterDims: {
                widthPx: 883,
                heightPx: 1335,
            },
            agreementStrength: 0.74,
        });
        await nextTick();
        expect(mounted.session.resultCurrent.value).toBe(false);

        await mounted.session.pauseForRun();

        expect(mounted.session.loading.value).toBe(false);
        expect(mounted.session.result.value).toBe(completed);
        expect(mounted.session.rawResult.value).toBe(raw);
        expect(mounted.session.resultCurrent.value).toBe(false);
        expect(backend.capability.cancelPreview).toHaveBeenLastCalledWith(expect.objectContaining({invalidateRawCache: false}));
        mounted.unmount();
    });

    it('adopts the in-flight prefetch of the page the user navigates to instead of restarting it', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        // The adjacent prefetch of 101 is now running.
        await backend.advanceBy(50);
        expect(backend.inFlightPages).toContain(101);
        const prefetchStartedAtMs = backend.startedAtMsFor(101);
        const spawnsBeforeNavigation = backend.counters.spawns;
        const abortedBeforeNavigation = backend.counters.aborted;

        previewPage.value = 101;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        expect(mounted.session.rawResult.value?.pageNumber).toBe(101);
        await backend.advanceBy(500);

        expect(backend.counters.spawns).toBe(spawnsBeforeNavigation);
        expect(backend.counters.joins).toBeGreaterThan(0);
        expect(backend.counters.aborted).toBe(abortedBeforeNavigation);
        expect(backend.startedAtMsFor(101)).toBe(prefetchStartedAtMs);
        mounted.unmount();
    });

    it.each([
        'cleaned' as const,
        'original' as const,
    ])('spends one request and one raster on a page switch in %s view, raw first', async (viewMode) => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()), viewMode);
        expect(mounted.session.viewMode.value).toBe(viewMode);

        await backend.advanceBy(PREVIEW_MS + 4_000);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        const requestsFor = (pageNumber: number) => backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === pageNumber).length;
        const rastersFor = (pageNumber: number) => backend.rasterPayloadPages
            .filter(page => page === pageNumber).length;
        expect(requestsFor(200)).toBe(0);

        previewPage.value = 200;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

        // C1: the switch costs one preview invocation, not a raw leg and then a
        // cleaned one. C2: and the page's raster crosses once for it.
        expect(requestsFor(200)).toBe(1);
        expect(rastersFor(200)).toBe(1);
        // The raw page is on screen while its cleanup runs, in either view
        // mode, and the page being replaced is still the cleaned result.
        expect(mounted.session.rawResult.value?.pageNumber).toBe(200);
        expect(mounted.session.rawResult.value?.rawImageData.byteLength).toBe(PAGE_BYTES);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        expect(mounted.session.loading.value).toBe(true);

        await backend.advanceBy(PREVIEW_MS + 100);

        // The cleaned result supersedes it and keeps the raster it was shown
        // with, so the entry cached for this page can still answer Original.
        expect(mounted.session.result.value?.pageNumber).toBe(200);
        expect(mounted.session.result.value?.rawImageData.byteLength).toBe(PAGE_BYTES);
        expect(requestsFor(200)).toBe(1);
        expect(rastersFor(200)).toBe(1);

        previewPage.value = 100;
        await nextTick();
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        expect(mounted.session.rawResult.value?.rawImageData.byteLength).toBe(PAGE_BYTES);
        expect(requestsFor(100)).toBe(1);
        expect(rastersFor(100)).toBe(1);
        mounted.unmount();
        capability.value = null;
    });

    it('stops loading when a page is canceled and re-requests it on the next visit', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        expect(mounted.session.result.value?.pageNumber).toBe(100);

        previewPage.value = 400;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        expect(mounted.session.loading.value).toBe(true);
        const requestsFor = (pageNumber: number) => backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === pageNumber).length;
        expect(requestsFor(400)).toBe(1);

        // The whole document is canceled underneath the page being rendered,
        // which is what a settings change or a closing workspace does.
        mounted.session.cancel();
        await backend.advanceBy(PREVIEW_MS + 500);

        expect(mounted.session.loading.value).toBe(false);
        expect(mounted.session.error.value).toBe('');
        expect(backend.counters.aborted).toBeGreaterThan(0);

        // Revisiting the page asks for it again rather than waiting on the run
        // that was thrown away.
        previewPage.value = 401;
        await nextTick();
        previewPage.value = 400;
        await nextTick();
        await backend.advanceBy(PREVIEW_MS + 500);

        expect(requestsFor(400)).toBeGreaterThan(1);
        expect(mounted.session.result.value?.pageNumber).toBe(400);
        expect(mounted.session.loading.value).toBe(false);
        mounted.unmount();
        capability.value = null;
    });

    it('re-requests the page it is on when its run answers canceled', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        expect(mounted.session.result.value?.pageNumber).toBe(100);

        previewPage.value = 400;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        const requestsFor = (pageNumber: number) => backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === pageNumber).length;
        expect(requestsFor(400)).toBe(1);

        // The run for the page the user is on is retired underneath it. Nothing
        // navigated, so nothing else would ever ask for this page again.
        expect(backend.retire(400)).toBe(1);
        await backend.advanceBy(PREVIEW_MS + 500);

        expect(requestsFor(400)).toBe(2);
        expect(mounted.session.result.value?.pageNumber).toBe(400);
        expect(mounted.session.loading.value).toBe(false);
        expect(mounted.session.error.value).toBe('');
        mounted.unmount();
        capability.value = null;
    });

    it('retains a previous-settings raster when a final run cancels a debounced preview', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        expect(mounted.session.resultCurrent.value).toBe(true);

        mounted.settings.marginsMm.topMm = 8;
        await nextTick();
        expect(mounted.session.resultCurrent.value).toBe(false);
        expect(mounted.session.loading.value).toBe(true);

        // The final run freezes its own options. Its cancellation retires the
        // pending refresh but keeps the last completed visual as stale content.
        mounted.session.cancel(false);

        expect(mounted.session.loading.value).toBe(false);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        expect(mounted.session.rawResult.value?.pageNumber).toBe(100);
        expect(mounted.session.resultCurrent.value).toBe(false);
        mounted.unmount();
        capability.value = null;
    });

    it('drops a queued raw event without clearing the retained frame on cancel', async () => {
        const backend = previewBackend();
        let rawListener: ((raw: IScanCleanupRawPreviewEvent) => void) | null = null;
        capability.value = {
            ...backend.capability,
            onPreviewRaw: (listener) => {
                rawListener = listener;
                return backend.capability.onPreviewRaw(listener);
            },
        };
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        expect(mounted.session.rawResult.value?.pageNumber).toBe(100);
        const [request] = backend.previewCalls.mock.calls.at(-1)!;

        const retainedRaw = mounted.session.rawResult.value;
        mounted.session.cancel();
        expect(mounted.session.rawResult.value).toBe(retainedRaw);

        // The IPC queue can still hold a raw event for the request that was
        // just cancelled; owner and revision both match, so only the retired
        // request ID distinguishes it from live work.
        rawListener!({
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            requestId: request.requestId,
            pageNumber: request.pageNumber,
            totalPages: TOTAL_PAGES,
            rawImageData: new Uint8Array(new ArrayBuffer(PAGE_BYTES)),
            rawWidthPx: 883,
            rawHeightPx: 1335,
        });

        expect(mounted.session.rawResult.value).toBe(retainedRaw);
        mounted.unmount();
        capability.value = null;
    });

    it('stops re-requesting a page whose run keeps answering canceled', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        previewPage.value = 400;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

        const requestsFor = (pageNumber: number) => backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === pageNumber).length;
        for (let attempt = 0; attempt < 6; attempt += 1) {
            backend.retire(400);
            await backend.advanceBy(100);
        }

        // Two retries and then it stops, rather than spinning against a page
        // that cannot be rendered.
        expect(requestsFor(400)).toBe(3);
        // And the page says so: a recoverable error with the Retry the shell
        // already renders, rather than a blank frame and no spinner.
        expect(mounted.session.loading.value).toBe(false);
        expect(mounted.session.resultCurrent.value).toBe(false);
        expect(mounted.session.error.value).not.toBe('');

        // Retrying spends a fresh budget and renders.
        mounted.session.retry();
        await backend.advanceBy(PREVIEW_MS + 500);

        expect(requestsFor(400)).toBe(4);
        expect(mounted.session.error.value).toBe('');
        expect(mounted.session.result.value?.pageNumber).toBe(400);
        mounted.unmount();
        capability.value = null;
    });

    it('gives a page that gave up a fresh budget when the user turns back to it', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        previewPage.value = 400;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        const requestsFor = (pageNumber: number) => backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === pageNumber).length;
        for (let attempt = 0; attempt < 6; attempt += 1) {
            backend.retire(400);
            await backend.advanceBy(100);
        }
        expect(requestsFor(400)).toBe(3);

        previewPage.value = 100;
        await nextTick();
        await backend.advanceBy(PREVIEW_MS + 500);
        previewPage.value = 400;
        await nextTick();
        await backend.advanceBy(PREVIEW_MS + 500);

        // The page renders again instead of inheriting the budget the last
        // visit exhausted.
        expect(requestsFor(400)).toBeGreaterThan(3);
        expect(mounted.session.result.value?.pageNumber).toBe(400);
        expect(mounted.session.error.value).toBe('');
        mounted.unmount();
        capability.value = null;
    });

    it('keeps a deliberate page turn immediate when nothing is in flight', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 4_000);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        const callsBefore = backend.previewCalls.mock.calls.length;

        previewPage.value = 150;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

        expect(backend.previewCalls.mock.calls.length).toBeGreaterThan(callsBefore);
        mounted.unmount();
    });
});
