import {vi} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import type {
    IDocumentPageRenderRequest,
    IDocumentPageSource,
} from '@app/modules/document-viewer/source/documentPageSource';
import DocumentThumbnailList from '@app/components/document-viewer/DocumentThumbnailList.vue';
import {requireDocumentRef} from '@contracts/documentRef';

/**
 * Shared mounting machinery for the thumbnail rail: the DOM globals it needs
 * (ResizeObserver, animation frames, element geometry), a page source whose
 * per-page render outcome the scenario chooses, and the settle/scroll steps a
 * virtualized rail needs before its DOM is worth reading.
 *
 * Scenarios keep their own assertions; this file only puts the rail on screen.
 */

/** `defer` holds the render open until the scenario fails it by hand. */
export type TDocumentThumbnailRenderBehavior = 'defer' | 'fail' | 'succeed';

export interface IDocumentThumbnailSourceHarness {
    /** Per-page render outcome; absent pages succeed. */
    behaviors: Map<number, TDocumentThumbnailRenderBehavior>;
    /** Rejects the open `defer` render for a page and lets the rail settle. */
    failPendingRender: (pageNumber: number) => Promise<void>;
    metricsCalls: number[];
    /** Full-page renders, which the rail is never supposed to ask for. */
    pageRenderCalls: number[];
    /** Thumbnail renders the rail asked the thumbnail provider for. */
    renderCalls: number[];
    /** Every thumbnail render the rail issued, with the width it asked for. */
    renderRequests: IDocumentThumbnailRenderRequestRecord[];
    /** Pages the harness stopped answering because they passed the call cap. */
    runawayPages: ReadonlySet<number>;
    source: IDocumentPageSource;
}

export interface IDocumentThumbnailRenderRequestRecord {
    pageNumber: number;
    widthPx: number;
}

export interface IMountedDocumentThumbnailList {
    host: HTMLElement;
    /** Pages the rail asked to navigate to, in order. */
    navigations: number[];
    /**
     * The activation event each navigation carried, in the same order. The
     * rail forwards the user's own event so a consumer can read its modifier
     * keys instead of rebuilding one.
     */
    navigationEvents: MouseEvent[];
    setCurrentPage: (page: number) => void;
    setItemMetricsKey: (key: unknown) => void;
    setActive: (active: boolean) => void;
    setSource: (source: IDocumentPageSource | null) => void;
    unmount: () => void;
}

interface IPendingRender {
    fail: (reason: Error) => void;
    pageNumber: number;
    promise: Promise<never>;
}

const ICON_STUB = defineComponent({
    props: {name: {
        type: String,
        required: true,
    }},
    setup: props => () => h('span', {'data-icon': props.name}),
});

class ResizeObserverStub implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
/** Captured before any fake clock is installed, so settling can still yield. */
const scheduleRealMacrotask = globalThis.setTimeout.bind(globalThis);
const mounted = new Set<() => void>();

/**
 * Bumped by every question the rail asks the source. Settling watches it to
 * tell a rail that is still working through a promise chain from one that has
 * genuinely stopped, without any scenario having to guess a chain's length.
 */
let sourceActivity = 0;
let openThumbnailRenders = 0;

const DEFAULT_FRAME_WIDTH = 180;

/**
 * The raster this harness leases for every accepted render, whatever width was
 * asked for. It is deliberately none of the widths the rail can demand — those
 * are bucketed multiples of 32 — so a scenario can tell a rail that tracks the
 * width it requested from one that tracks the raster it got.
 */
export const LEASED_THUMBNAIL_RASTER_WIDTH = 150;

/**
 * A rail that keeps re-demanding a page the scheduler already considers done
 * spins as a microtask storm, which kills the worker with a heap error instead
 * of failing an assertion. Past this many render calls for one page the harness
 * stops answering and records the page in `runawayPages`, so a retry loop shows
 * up as a bounded count in whichever expectation the scenario already has. The
 * cap is well above the handful of attempts any real scenario needs.
 */
const RUNAWAY_RENDER_CALL_CAP = 12;

/**
 * Settling drains the rail's own pending work rather than a wall clock, so it
 * only stops when the rail stops. This bound turns a rail that never stops into
 * a named failure instead of a hung worker; it is far above the handful of
 * timer generations any real scenario needs.
 */
const MAX_SETTLE_ROUNDS = 200;

function stubFrameGeometry(width: number) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        bottom: 150,
        height: 140,
        left: 0,
        right: width,
        top: 10,
        width,
        x: 0,
        y: 10,
        toJSON: () => ({}),
    });
}

/** Installs the DOM globals and element geometry the rail measures against. */
export function installDocumentThumbnailListEnvironment() {
    // A fake clock makes the rail's pending timers countable, which is what
    // lets settling wait for the scroll/resize settle timers and the animation
    // frames they schedule instead of for real elapsed time.
    vi.useFakeTimers();
    globalThis.ResizeObserver = ResizeObserverStub;
    globalThis.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 0);
    globalThis.cancelAnimationFrame = handle => window.clearTimeout(handle);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(220);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    stubFrameGeometry(DEFAULT_FRAME_WIDTH);
}

/**
 * Widens the measured row frame so the next measurement lands in a different
 * raster bucket, which is how a real resize asks for a wider re-render of pages
 * that already committed a narrower one.
 */
export function widenDocumentThumbnailFrames(width: number) {
    stubFrameGeometry(width);
}

/** Unmounts every rail this harness mounted and undoes the installed globals. */
export function restoreDocumentThumbnailListEnvironment() {
    for (const unmount of [...mounted]) unmount();
    vi.useRealTimers();
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
}

export function createDocumentThumbnailSourceHarness(
    pageCount = 12,
    documentRef = '/thumbnails.pdf',
): IDocumentThumbnailSourceHarness {
    const behaviors = new Map<number, TDocumentThumbnailRenderBehavior>();
    const metricsCalls: number[] = [];
    const pageRenderCalls: number[] = [];
    const pending: IPendingRender[] = [];
    const renderCalls: number[] = [];
    const renderRequests: IDocumentThumbnailRenderRequestRecord[] = [];
    const runawayPages = new Set<number>();
    const renderThumbnail = vi.fn((request: {
        pageNumber: number;
        widthPx: number;
        signal?: AbortSignal;
    }) => {
        openThumbnailRenders += 1;
        let open = true;
        const close = () => {
            if (open) {
                open = false;
                openThumbnailRenders -= 1;
            }
        };
        request.signal?.addEventListener('abort', close, {once: true});
        const render = startThumbnailRender(request);
        void render.then(close, close);
        return render;
    });
    async function startThumbnailRender(request: {
        pageNumber: number;
        widthPx: number;
    }) {
        sourceActivity += 1;
        renderCalls.push(request.pageNumber);
        renderRequests.push({
            pageNumber: request.pageNumber,
            widthPx: request.widthPx,
        });
        if (countDocumentThumbnailCalls(renderCalls, request.pageNumber) > RUNAWAY_RENDER_CALL_CAP) {
            runawayPages.add(request.pageNumber);
            return new Promise<never>(() => undefined);
        }
        if (behaviors.get(request.pageNumber) === 'defer') {
            let fail!: (reason: Error) => void;
            const promise = new Promise<never>((_resolve, reject) => {
                fail = reject;
            });
            pending.push({
                fail,
                pageNumber: request.pageNumber,
                promise,
            });
            return promise;
        }
        if (behaviors.get(request.pageNumber) === 'fail') {
            throw new Error(`thumbnail ${String(request.pageNumber)} failed`);
        }
        return {
            widthPx: LEASED_THUMBNAIL_RASTER_WIDTH,
            heightPx: 210,
            bytes: 126_000,
            surface: document.createElement('canvas'),
            release: vi.fn(),
        };
    }
    const source: IDocumentPageSource = {
        kind: 'pdf',
        documentRef: requireDocumentRef(documentRef),
        pageCount,
        getPageMetrics: vi.fn(async (pageNumber: number) => {
            sourceActivity += 1;
            metricsCalls.push(pageNumber);
            return {
                widthPoints: 500,
                heightPoints: 700,
                rotation: 0 as const,
            };
        }),
        // The rail is supposed to reach a raster only through the thumbnail
        // provider, so a full-page render answers from its own spy: thumbnail
        // accounting then cannot be quietly fed by page renders.
        renderPage: vi.fn(async (request: IDocumentPageRenderRequest) => {
            sourceActivity += 1;
            pageRenderCalls.push(request.pageNumber);
            return {
                widthPx: request.widthPx,
                heightPx: request.widthPx * 2,
                bytes: request.widthPx * 4,
                surface: document.createElement('canvas'),
                release: vi.fn(),
            };
        }),
        thumbnailProvider: {renderThumbnail},
        dispose: vi.fn(),
    };
    return {
        behaviors,
        async failPendingRender(pageNumber: number) {
            const index = pending.findIndex(entry => entry.pageNumber === pageNumber);
            const entry = index >= 0 ? pending.splice(index, 1)[0] : undefined;
            if (!entry) {
                throw new Error(`no pending render for page ${String(pageNumber)}`);
            }
            entry.fail(new Error(`thumbnail ${String(pageNumber)} failed`));
            await entry.promise.catch(() => undefined);
            await settleDocumentThumbnailList();
        },
        metricsCalls,
        pageRenderCalls,
        renderCalls,
        renderRequests,
        runawayPages,
        source,
    };
}

export function mountDocumentThumbnailList(
    source: IDocumentPageSource | null,
    isActive = true,
): IMountedDocumentThumbnailList {
    const activeSource = ref<IDocumentPageSource | null>(source);
    const active = ref(isActive);
    const currentPage = ref(1);
    const itemMetricsKey = ref<unknown>();
    const navigations: number[] = [];
    const navigationEvents: MouseEvent[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({render: () => h(DocumentThumbnailList, {
        source: activeSource.value,
        currentPage: currentPage.value,
        isActive: active.value,
        itemMetricsKey: itemMetricsKey.value,
        onGoToPage: (pageNumber: number, event: MouseEvent) => {
            navigations.push(pageNumber);
            navigationEvents.push(event);
        },
    })});
    app.component('UIcon', ICON_STUB);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        mounted.delete(unmount);
    };
    mounted.add(unmount);
    return {
        host,
        navigations,
        navigationEvents,
        setCurrentPage: (page: number) => {
            currentPage.value = page;
        },
        setItemMetricsKey: (key: unknown) => {
            itemMetricsKey.value = key;
        },
        setActive: (nextActive: boolean) => {
            active.value = nextActive;
        },
        setSource: (next: IDocumentPageSource | null) => {
            activeSource.value = next;
        },
        unmount,
    };
}

/**
 * Yields to the event loop on the real clock, which runs only once every queued
 * microtask has, so a render that resolves through a promise chain of any depth
 * lands before this returns. Vue's own queue is a microtask too; the `nextTick`
 * is what guarantees its DOM writes are visible afterwards.
 */
async function drainDocumentThumbnailWork() {
    await new Promise(resolve => scheduleRealMacrotask(resolve, 0));
    await nextTick();
}

/**
 * Lets scheduled renders, settle timers, and the resulting re-renders drain,
 * and returns as soon as the rail has nothing left to do: no timer it scheduled
 * is still pending, and a full drain produced no further work from the source.
 * Each pending timer fires at its own deadline on the fake clock, so a scenario
 * observes the rail's real settle sequence rather than a guessed wait, and a
 * deliberately parked render (`defer`) leaves only its render deadline pending.
 */
export async function settleDocumentThumbnailList() {
    let lastActivity = -1;
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
        await drainDocumentThumbnailWork();
        // Every open render holds one scheduler deadline timer. Advancing to it
        // would time out a render the scenario parked on purpose.
        const pendingTimers = vi.getTimerCount() - openThumbnailRenders;
        if (pendingTimers <= 0 && sourceActivity === lastActivity) {
            return;
        }
        lastActivity = sourceActivity;
        if (pendingTimers > 0) await vi.advanceTimersToNextTimerAsync();
    }
    throw new Error(
        `the thumbnail rail was still scheduling work after ${String(MAX_SETTLE_ROUNDS)} settle rounds`,
    );
}

export async function scrollDocumentThumbnailRail(host: HTMLElement, scrollTop: number) {
    const rail = host.querySelector<HTMLElement>('[data-document-thumbnail-rail]');
    if (!rail) {
        throw new Error('thumbnail rail is not mounted');
    }
    rail.scrollTop = scrollTop;
    rail.dispatchEvent(new Event('scroll'));
    await settleDocumentThumbnailList();
}

/** Scrolls to an offset and returns a page the rail actually rendered there. */
export async function scrollToRenderedPage(
    harness: {renderCalls: number[]},
    host: HTMLElement,
    scrollTop: number,
) {
    const before = harness.renderCalls.length;
    await scrollDocumentThumbnailRail(host, scrollTop);
    const target = harness.renderCalls.slice(before).at(-1);
    if (target === undefined) {
        throw new Error(`the rail rendered nothing at offset ${String(scrollTop)}`);
    }
    return target;
}

export function documentThumbnailRow(host: HTMLElement, pageNumber: number) {
    return host.querySelector<HTMLElement>(`[data-thumbnail-page="${String(pageNumber)}"]`);
}

export function countDocumentThumbnailCalls(calls: readonly number[], pageNumber: number) {
    return calls.filter(page => page === pageNumber).length;
}
