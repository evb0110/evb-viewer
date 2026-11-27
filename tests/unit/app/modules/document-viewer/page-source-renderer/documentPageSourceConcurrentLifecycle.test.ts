// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/modules/document-viewer/source/createDjvuPageSource';

import {afterEach, describe, expect, it, vi} from 'vitest';
import {computed, createApp, defineComponent, h, nextTick, provide, ref, shallowRef, watch, type Ref} from 'vue';
import type {TDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import DocumentPageSourceFeaturePack from '@app/modules/document-viewer/page-source-renderer/DocumentPageSourceFeaturePack.vue';
import * as pageSourceState from '@app/modules/document-viewer/page-source-renderer/documentPageSourceFeaturePackState';
import {useDocumentOpenVisualSettle} from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import {createDocumentViewerRuntime, documentViewerRuntimeKey} from '@app/modules/document-viewer/public';
import {createPageNavigationRequest, type IDocumentPageSource, type IDocumentRenderLease} from '@app/modules/document-viewer/public';
import type {IDocumentViewerExpose} from '@app/modules/pdf-viewer/public';

const mocks = vi.hoisted(() => ({
    createDjvuPagePreviewSourceFromPath: vi.fn(),
    createDjvuPageSource: vi.fn(),
}));

vi.mock('@app/platform/browser-api/public', () => ({createDjvuPagePreviewSourceFromPath: mocks.createDjvuPagePreviewSourceFromPath}));
vi.mock('@app/modules/document-viewer/source/createDjvuPageSource', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    createDjvuPageSource: mocks.createDjvuPageSource,
}));

const mountedApps = new Set<() => void>();

interface IWorkspaceOpenSettleHarness {
    initialVisualReady: Ref<boolean>;
    totalPages: Ref<number>;
    documentOpenSettled: Readonly<Ref<boolean>>;
    /** What the mounted feature pack exposes to the shell. */
    viewer?: Readonly<Ref<IDocumentViewerExpose | null>>;
}

function createWorkspaceOpenSettleHarness(): IWorkspaceOpenSettleHarness {
    return {
        initialVisualReady: ref(false),
        totalPages: ref(0),
        documentOpenSettled: ref(false),
    };
}

function createPageSource(documentRef: TDocumentRef, pageCount = 1): IDocumentPageSource {
    return {
        kind: 'djvu',
        documentRef,
        pageCount,
        getPageMetrics: vi.fn(async () => ({
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0 as const,
        })),
        renderPage: vi.fn(async () => ({
            bytes: 480_000,
            heightPx: 800,
            release: vi.fn(),
            surface: 'data:image/png;base64,',
            widthPx: 600,
        })),
        dispose: vi.fn(),
    };
}

function createFeaturePackHost(
    surface: IDocumentOpenSurfaceSession,
    documentRef: TDocumentRef,
    loadErrors: Ref<unknown[]>,
    settleHarness: IWorkspaceOpenSettleHarness,
    isResizing: Ref<boolean>,
    isActive: Ref<boolean> = ref(true),
) {
    return defineComponent({
        name: 'DocumentPageSourceFeaturePackHost',
        setup() {
            const authority = createDocumentViewerRuntime(ref('djvu'), surface);
            const totalPages = ref(0);
            const featurePack = shallowRef<(IDocumentViewerExpose & {isDocumentLoading?: () => boolean}) | null>(null);
            // The shell reads the renderer's loading live from what it exposes.
            const isLoading = computed(() => featurePack.value?.isDocumentLoading?.() ?? false);
            const settle = useDocumentOpenVisualSettle({
                isLoading,
                pdfError: ref(null),
                djvuError: ref(null),
                showDjvuSource: ref(true),
                openSurface: surface,
            });
            settleHarness.initialVisualReady = settle.initialDocumentVisualReady;
            settleHarness.totalPages = totalPages;
            settleHarness.documentOpenSettled = settle.documentOpenSettled;
            settleHarness.viewer = featurePack;
            provide(documentViewerRuntimeKey, authority);
            return () => {
                const snapshot = surface.snapshot.value;
                return h(
                    'div',
                    {
                        ref: (element: unknown) => {
                            authority.bindViewportElement(element instanceof HTMLElement ? element : null);
                        },
                        class: 'document-viewer-viewport',
                        'data-document-ref': documentRef,
                    },
                    [
                        h('section', {
                            ref: (element: unknown) => {
                                authority.bindOpeningPageElement(element instanceof HTMLElement ? element : null);
                            },
                            // As the chassis's opening shell: the page the open presents.
                            'data-document-page-number': String(surface.viewportSession.value.requestedPage),
                            'data-open-surface-frame-owner': snapshot.openingPageFrame?.ownerId ?? '',
                            'data-open-surface-generation': String(snapshot.generation),
                            'data-page-number': String(surface.viewportSession.value.requestedPage),
                        }),
                        h(DocumentPageSourceFeaturePack, {
                            documentRevisionToken: requireDocumentRevisionToken(`revision:${documentRef}`),
                            isActive: isActive.value,
                            isResizing: isResizing.value,
                            onLoadError: (error: unknown) => loadErrors.value.push(error),
                            ref: featurePack,
                            'onUpdate:totalPages': (pageCount: number) => {
                                totalPages.value = pageCount;
                            },
                            src: documentRef,
                        }),
                    ],
                );
            };
        },
    });
}

afterEach(() => {
    for (const unmount of mountedApps) {
        unmount();
    }
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

// A 900x700 viewport whose page images have loaded at 860x1146.
function layOutLoadedPages(imagesLoaded = true) {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(imagesLoaded);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(imagesLoaded ? 600 : 0);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        bottom: 1_146,
        height: 1_146,
        left: 0,
        right: 860,
        top: 0,
        width: 860,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    });
}

async function flushOpeningFrame() {
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.advanceTimersToNextFrame();
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A 5-page DjVu shown at page 3 in a 900x700 box, every page painted and the reading page placed. */
async function mountPlacedDjvu(isActive = ref(true), isResizing = ref(false)) {
    layOutLoadedPages();
    mocks.createDjvuPagePreviewSourceFromPath.mockImplementation(async (path: TDocumentRef) => ({path}));
    const documentRef = '/documents/split.djvu' as TDocumentRef;
    const source = createPageSource(documentRef, 5);
    mocks.createDjvuPageSource.mockResolvedValue(source);
    const surface = createDocumentOpenSurfaceSession();
    surface.begin(
        {
            documentId: documentRef,
            documentRevision: 'open-intent:split',
            provisional: true,
        },
        null,
        1,
    );
    surface.navigate(createPageNavigationRequest(3, 'restore'));
    const settle = createWorkspaceOpenSettleHarness();
    const root = document.createElement('div');
    document.body.append(root);
    const app = createApp(createFeaturePackHost(surface, documentRef, ref<unknown[]>([]), settle, isResizing, isActive));
    app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
    app.component(
        'UButton',
        defineComponent({
            props: ['label'],
            setup: (props) => () => h('button', props.label),
        }),
    );
    app.mount(root);
    const unmount = () => {
        app.unmount();
        root.remove();
        mountedApps.delete(unmount);
    };
    mountedApps.add(unmount);
    await vi.waitFor(() => expect(settle.documentOpenSettled.value).toBe(true));
    const viewer = settle.viewer!.value!;
    const pageWidth = () => root.querySelector<HTMLElement>('[data-testid="document-page-source-page"]')!.style.width;
    // The rendered page publishes its metrics, whose restore frame places the opening's point.
    const image = await vi.waitFor(() => {
        const rendered = root.querySelector<HTMLImageElement>(
            '[data-testid="document-page-source-image"]:not([data-page-source-candidate])',
        );
        expect(rendered).not.toBeNull();
        return rendered!;
    });
    image.dispatchEvent(new Event('load'));
    // The neighbouring pages paint over later render frames; a test that counts
    // frames starts only once every page is painted and the last pass has run.
    await vi.waitFor(() =>
        expect(
            [...root.querySelectorAll<HTMLElement>('[data-testid="document-page-source-page"]')].map(
                (page) => page.dataset.pageSourceVisual,
            ),
        ).toEqual(Array(5).fill('fresh')),
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
        isActive,
        isResizing,
        pageWidth,
        surface,
        viewer,
    };
}

describe('DocumentPageSourceFeaturePack concurrent open surfaces', () => {
    it.each([
        {scenario: 'no required target renders', isActive: false},
        {scenario: 'the navigation ticket retires before commit', isActive: true},
    ])('settles the DjVu visual when $scenario', async ({isActive}) => {
        vi.useFakeTimers({toFake: ['requestAnimationFrame', 'cancelAnimationFrame']});
        layOutLoadedPages(false);
        const documentRef = '/documents/unpresented.djvu' as TDocumentRef;
        mocks.createDjvuPagePreviewSourceFromPath.mockResolvedValue({path: documentRef});
        mocks.createDjvuPageSource.mockResolvedValue(createPageSource(documentRef, 2));
        const surface = createDocumentOpenSurfaceSession();
        surface.begin(
            {
                documentId: documentRef,
                documentRevision: 'open-intent:unpresented',
                provisional: true,
            },
            null,
            1,
        );
        if (isActive) {
            surface.navigate(createPageNavigationRequest(2, 'restore'));
        }

        let visual: boolean | 'pending' = 'pending';
        const {createDocumentPageSourceOpenJob} = pageSourceState;
        vi.spyOn(pageSourceState, 'createDocumentPageSourceOpenJob').mockImplementation(() => {
            const job = createDocumentPageSourceOpenJob();
            void job.visual.then((result) => {
                visual = result;
            });
            return job;
        });

        const settle = createWorkspaceOpenSettleHarness();
        const errors = ref<unknown[]>([]);
        const root = document.createElement('div');
        document.body.append(root);
        const app = createApp(createFeaturePackHost(surface, documentRef, errors, settle, ref(false), ref(isActive)));
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
        app.component(
            'UButton',
            defineComponent({
                props: ['label'],
                setup: (props) => () => h('button', props.label),
            }),
        );
        app.mount(root);

        try {
            await flushOpeningFrame();
            expect(settle.totalPages.value).toBe(2);
            expect(errors.value).toEqual([]);
            expect(surface.snapshot.value.committedRender).toBeNull();
            const image = root.querySelector('[data-testid="document-page-source-image"]');
            if (isActive) {
                expect(image?.isConnected).toBe(true);
                expect(visual).toBe('pending');
                const ticket = surface.navigationTicket.value!;
                expect(surface.reportNavigation(ticket, {kind: 'abandoned', by: 'user-input'})).toBe(true);
                await expect(ticket.finished).resolves.toEqual({kind: 'superseded', by: 'user-input'});
                await flushOpeningFrame();
            } else {
                expect(image).toBeNull();
            }
            expect(visual, 'the visual job must settle without a committed render').toBe(false);
        } finally {
            app.unmount();
            root.remove();
            vi.useRealTimers();
        }
    });

    it.each(['resize', 'resolution'])('replaces a settled raster after a density-only %s change', async (trigger) => {
        layOutLoadedPages();
        const originalDpr = window.devicePixelRatio;
        const setDpr = (value: number) =>
            Object.defineProperty(window, 'devicePixelRatio', {
                configurable: true,
                value,
            });
        setDpr(1);
        const resolutionChange = new EventTarget();
        vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
            return Object.assign(resolutionChange, {
                matches: true,
                media: query,
            }) as MediaQueryList;
        });
        const decode = Promise.withResolvers<undefined>();
        vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(() => decode.promise);
        const documentRef = '/documents/density.djvu' as TDocumentRef;
        const source = createPageSource(documentRef);
        const oldRelease = vi.fn();
        const replacement = Promise.withResolvers<IDocumentRenderLease>();
        source.renderPage = vi.fn(async ({widthPx}) =>
            widthPx === 860
                ? {
                      bytes: 860 * 1_147 * 4,
                      widthPx,
                      heightPx: 1_147,
                      surface: 'data:image/png;base64,low',
                      release: oldRelease,
                  }
                : replacement.promise,
        );
        mocks.createDjvuPagePreviewSourceFromPath.mockImplementation(async (path: TDocumentRef) => ({path}));
        mocks.createDjvuPageSource.mockResolvedValue(source);
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: documentRef,
            documentRevision: 'open-intent:density',
            provisional: true,
        });
        const settle = createWorkspaceOpenSettleHarness();
        const errors = ref<unknown[]>([]);
        const root = document.createElement('div');
        document.body.append(root);
        const app = createApp(createFeaturePackHost(surface, documentRef, errors, settle, ref(false)));
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
        app.component(
            'UButton',
            defineComponent({
                props: ['label'],
                setup: (props) => () => h('button', props.label),
            }),
        );
        app.mount(root);
        const image = () =>
            root.querySelector<HTMLImageElement>('[data-testid="document-page-source-image"]:not([data-page-source-candidate])')!;
        const readPageLayout = () => {
            const page = image().closest<HTMLElement>('[data-testid="document-page-source-page"]')!;
            const {width, height, top, left} = page.style;
            return {
                width,
                height,
                top,
                left,
            };
        };
        try {
            await vi.waitFor(() => expect(settle.documentOpenSettled.value).toBe(true));
            // The chassis retires its opening shell and mounts the final image.
            await nextTick();
            image().dispatchEvent(new Event('load'));
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            const lowImage = image();
            expect(lowImage.getAttribute('src')).toContain('base64,low');
            const layout = readPageLayout();
            expect(layout).toMatchObject({
                width: '860px',
                height: '1147px',
            });
            const scrollTop = root.firstElementChild!.scrollTop;
            setDpr(2);
            if (trigger === 'resize') {
                window.dispatchEvent(new Event('resize'));
            } else {
                resolutionChange.dispatchEvent(new Event('change'));
            }
            await vi.waitFor(() =>
                expect(source.renderPage).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        pageNumber: 1,
                        widthPx: 1_720,
                    }),
                ),
            );
            expect(oldRelease).not.toHaveBeenCalled();
            expect(lowImage.isConnected).toBe(true);
            replacement.resolve({
                bytes: 1_720 * 2_293 * 4,
                widthPx: 1_720,
                heightPx: 2_293,
                surface: 'data:image/png;base64,high',
                release: vi.fn(),
            });
            await vi.waitFor(() => expect(root.querySelector('[data-page-source-candidate]')).not.toBeNull());
            expect(oldRelease).not.toHaveBeenCalled();
            decode.resolve(undefined);
            await vi.waitFor(() => expect(image().getAttribute('src')).toContain('base64,high'));
            await vi.waitFor(() => expect(oldRelease).toHaveBeenCalledOnce());
            expect(readPageLayout()).toEqual(layout);
            expect(root.firstElementChild!.scrollTop).toBe(scrollTop);
            expect(errors.value).toEqual([]);
            const rendered = vi.mocked(source.renderPage).mock.calls.length;
            window.dispatchEvent(new Event('resize'));
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            expect(source.renderPage).toHaveBeenCalledTimes(rendered);
        } finally {
            decode.resolve(undefined);
            app.unmount();
            root.remove();
            setDpr(originalDpr);
        }
    });

    it('publishes prepared opening page count before the page source resolves', async () => {
        const documentRef = '/documents/large.djvu' as TDocumentRef;
        const surface = createDocumentOpenSurfaceSession();
        surface.begin(
            {
                documentId: documentRef,
                documentRevision: 'open-intent:large',
                provisional: true,
            },
            {
                documentId: documentRef,
                height: 800,
                pageCount: 1_859,
                pageNumber: 1,
                rotation: 0,
                width: 600,
            },
        );
        const previewGate = Promise.withResolvers<{path: TDocumentRef}>();
        mocks.createDjvuPagePreviewSourceFromPath.mockImplementation(() => previewGate.promise);
        mocks.createDjvuPageSource.mockImplementation(async (path: TDocumentRef) => createPageSource(path));
        const settle = createWorkspaceOpenSettleHarness();
        const Host = createFeaturePackHost(surface, documentRef, ref<unknown[]>([]), settle, ref(false));
        const root = document.createElement('div');
        document.body.append(root);
        const app = createApp(Host);
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
        app.component(
            'UButton',
            defineComponent({
                props: ['label'],
                setup: (props) => () => h('button', props.label),
            }),
        );
        app.mount(root);
        const unmount = () => {
            app.unmount();
            root.remove();
            mountedApps.delete(unmount);
        };
        mountedApps.add(unmount);

        expect(settle.totalPages.value).toBe(1_859);

        previewGate.resolve({path: documentRef});
        await vi.waitFor(() => expect(mocks.createDjvuPageSource).toHaveBeenCalled());
    });

    it('opens a DjVu at the page its opening was sent to before the source arrived, not at page 1', async () => {
        layOutLoadedPages();
        mocks.createDjvuPagePreviewSourceFromPath.mockImplementation(async (path: TDocumentRef) => ({path}));
        mocks.createDjvuPageSource.mockImplementation(async (path: TDocumentRef) => createPageSource(path, 5));
        const documentRef = '/documents/remembered.djvu' as TDocumentRef;
        const surface = createDocumentOpenSurfaceSession();
        surface.begin(
            {
                documentId: documentRef,
                documentRevision: 'open-intent:remembered',
                provisional: true,
            },
            null,
            1,
        );
        // The admitted reading place goes out as the opening's own restore.
        surface.navigate(createPageNavigationRequest(3, 'restore'));
        const committedPages: number[] = [];
        const stop = watch(
            () => surface.viewportSession.value.committedPage,
            (page) => {
                if (page !== null) {
                    committedPages.push(page);
                }
            },
            {flush: 'sync'},
        );
        const settle = createWorkspaceOpenSettleHarness();
        const root = document.createElement('div');
        document.body.append(root);
        const app = createApp(createFeaturePackHost(surface, documentRef, ref<unknown[]>([]), settle, ref(false)));
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
        app.component(
            'UButton',
            defineComponent({
                props: ['label'],
                setup: (props) => () => h('button', props.label),
            }),
        );
        app.mount(root);
        const unmount = () => {
            stop();
            app.unmount();
            root.remove();
            mountedApps.delete(unmount);
        };
        mountedApps.add(unmount);

        // The opening settles on the restored page; no later commit moves it.
        await vi.waitFor(() => expect(settle.documentOpenSettled.value).toBe(true));
        expect(committedPages[0]).toBe(3);
        expect(surface.viewportSession.value.committedPage).toBe(3);
    });

    it('places the DjVu reading page in a resized box before its layout receipt settles', async () => {
        const {isActive, pageWidth, surface, viewer} = await mountPlacedDjvu();
        const settled: string[] = [];
        const frames = vi.spyOn(window, 'requestAnimationFrame');

        // An unchanged box places nothing and waits for no frame.
        void viewer.whenLayoutPlaced!().then(() => settled.push('unchanged'));
        await vi.waitFor(() => expect(settled).toEqual(['unchanged']));
        expect(frames).not.toHaveBeenCalled();
        const wideWidth = pageWidth();

        // A split narrows the pane; no ResizeObserver delivery is needed.
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(450);
        await viewer.whenLayoutPlaced!();
        // The receipt waited for the restore frame that placed the point in the narrower layout.
        expect(frames).toHaveBeenCalled();
        expect(pageWidth()).not.toBe(wideWidth);
        expect(viewer.getCurrentPage?.()).toBe(3);
        expect(surface.viewportSession.value.committedPage).toBe(3);

        // A hidden view has nothing to place.
        isActive.value = false;
        await nextTick();
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
        frames.mockClear();
        await viewer.whenLayoutPlaced!();
        expect(frames).not.toHaveBeenCalled();
    });

    it('settles the DjVu layout receipt through a resize release, a navigation and a hidden view', async () => {
        const {isActive, isResizing, viewer} = await mountPlacedDjvu();
        const frames = vi.spyOn(window, 'requestAnimationFrame');
        const track = () => {
            const state = {settled: false};
            void viewer.whenLayoutPlaced!().then(() => {
                state.settled = true;
            });
            return state;
        };

        // The fence falls: the restore it queues is the receipt's.
        isResizing.value = true;
        await nextTick();
        isResizing.value = false;
        await nextTick();
        const released = track();
        await nextTick();
        await nextTick();
        expect(released.settled).toBe(false);
        await vi.waitFor(() => expect(released.settled).toBe(true));
        expect(frames).toHaveBeenCalled();

        // A navigation lands while a resize restore waits for its frame.
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
        const navigated = track();
        viewer.scrollToPage(2);
        await vi.waitFor(() => expect(navigated.settled).toBe(true));
        expect(viewer.getCurrentPage?.()).toBe(2);

        // The view is hidden while a resize restore waits for its frame.
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(450);
        const hidden = track();
        isActive.value = false;
        await vi.waitFor(() => expect(hidden.settled).toBe(true));
    });

    it('settles a retained source in a same-file replacement opening', async () => {
        layOutLoadedPages();
        const documentRef = '/documents/reopened.djvu' as TDocumentRef;
        const source = createPageSource(documentRef);
        mocks.createDjvuPagePreviewSourceFromPath.mockImplementation(async (path: TDocumentRef) => ({path}));
        mocks.createDjvuPageSource.mockResolvedValue(source);
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: documentRef,
            documentRevision: 'open-intent:first',
            provisional: true,
        });
        const settle = createWorkspaceOpenSettleHarness();
        const errors = ref<unknown[]>([]);
        const root = document.createElement('div');
        document.body.append(root);
        const app = createApp(createFeaturePackHost(surface, documentRef, errors, settle, ref(false)));
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
        app.component(
            'UButton',
            defineComponent({
                props: ['label'],
                setup: (props) => () => h('button', props.label),
            }),
        );
        app.mount(root);
        const unmount = () => {
            app.unmount();
            root.remove();
            mountedApps.delete(unmount);
        };
        mountedApps.add(unmount);
        await vi.waitFor(() => expect(settle.documentOpenSettled.value).toBe(true));

        const generation = surface.begin(
            {
                documentId: documentRef,
                documentRevision: 'open-intent:reopen',
                provisional: true,
            },
            {
                documentId: documentRef,
                pageNumber: 1,
                pageCount: 1,
                width: 600,
                height: 800,
                rotation: 0,
            },
        );
        // The retained feature pack receives a new chassis-owned opening shell.
        surface.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'reopen-frame',
            pageNumber: 1,
            intentKey: 'reopen',
            style: {
                width: '860px',
                height: '1146px',
            },
        });
        await vi.waitFor(() => expect(settle.documentOpenSettled.value).toBe(true));
        expect(surface.snapshot.value).toMatchObject({
            generation,
            phase: 'ready',
        });
        expect(settle.initialVisualReady.value).toBe(true);
        await nextTick();
        // happy-dom does not load the image remounted after the shell retires.
        root.querySelector<HTMLImageElement>('[data-testid="document-page-source-image"]')!.dispatchEvent(new Event('load'));
        await vi.waitFor(() => expect(root.querySelector('[data-page-source-visual="fresh"]')).not.toBeNull());
        expect(errors.value).toEqual([]);
    });

    it('settles a cold second workspace after its opening image is relocated', async () => {
        layOutLoadedPages();
        mocks.createDjvuPagePreviewSourceFromPath.mockImplementation(async (path: TDocumentRef) => ({path}));
        mocks.createDjvuPageSource.mockImplementation(async (path: TDocumentRef) => createPageSource(path));

        const firstDocumentRef = '/documents/first.djvu' as TDocumentRef;
        const secondDocumentRef = '/documents/second.djvu' as TDocumentRef;
        const firstSurface = createDocumentOpenSurfaceSession();
        const secondSurface = createDocumentOpenSurfaceSession();
        const firstGeneration = firstSurface.begin(
            {
                documentId: firstDocumentRef,
                documentRevision: 'open-intent:first',
                provisional: true,
            },
            {
                documentId: firstDocumentRef,
                height: 800,
                pageCount: 1,
                pageNumber: 1,
                rotation: 0,
                width: 600,
            },
        );
        const secondGeneration = secondSurface.begin({
            documentId: secondDocumentRef,
            documentRevision: 'open-intent:second',
            provisional: true,
        });
        const secondGeometryCommit = vi.spyOn(secondSurface, 'commitGeometry');
        const firstLoadErrors = ref<unknown[]>([]);
        const secondLoadErrors = ref<unknown[]>([]);
        const firstSettle = createWorkspaceOpenSettleHarness();
        const secondSettle = createWorkspaceOpenSettleHarness();
        const firstWorkspaceIsResizing = ref(false);
        const secondWorkspaceIsResizing = ref(false);
        const FirstHost = createFeaturePackHost(firstSurface, firstDocumentRef, firstLoadErrors, firstSettle, firstWorkspaceIsResizing);
        const SecondHost = createFeaturePackHost(
            secondSurface,
            secondDocumentRef,
            secondLoadErrors,
            secondSettle,
            secondWorkspaceIsResizing,
        );
        const showSecondWorkspace = ref(false);
        const root = document.createElement('div');
        document.body.append(root);
        const app = createApp(
            defineComponent({setup: () => () => h('div', [h(FirstHost), showSecondWorkspace.value ? h(SecondHost) : null])}),
        );
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
        app.component(
            'UButton',
            defineComponent({
                props: ['label'],
                setup: (props) => () => h('button', props.label),
            }),
        );
        app.mount(root);
        const unmount = () => {
            app.unmount();
            root.remove();
            mountedApps.delete(unmount);
        };
        mountedApps.add(unmount);

        await vi.waitFor(() => expect(firstSurface.snapshot.value.geometry).not.toBeNull());
        const firstImage = await vi.waitFor(() => {
            const image = root.querySelector<HTMLImageElement>(
                '[data-document-ref="/documents/first.djvu"] [data-testid="document-page-source-image"]',
            );
            expect(image).not.toBeNull();
            return image!;
        });
        firstImage.dispatchEvent(new Event('load'));
        await vi.waitFor(() => expect(firstSettle.initialVisualReady.value).toBe(true));
        expect(firstSettle.documentOpenSettled.value).toBe(true);

        showSecondWorkspace.value = true;
        await nextTick();
        await vi.waitFor(() => expect(secondSurface.snapshot.value.geometry).not.toBeNull());
        const secondImage = await vi.waitFor(() => {
            const image = root.querySelector<HTMLImageElement>(
                '[data-document-ref="/documents/second.djvu"] [data-testid="document-page-source-image"]',
            );
            expect(image).not.toBeNull();
            return image!;
        });
        const openingTarget = secondImage.parentElement!;
        const openingTargetParent = openingTarget.parentElement!;
        secondImage.dispatchEvent(new Event('load'));
        openingTarget.remove();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        openingTargetParent.append(openingTarget);
        secondWorkspaceIsResizing.value = true;
        await nextTick();
        secondWorkspaceIsResizing.value = false;

        await vi.waitFor(() => expect(secondSettle.initialVisualReady.value).toBe(true));
        expect(secondSettle.documentOpenSettled.value).toBe(true);

        expect(firstSurface.snapshot.value.generation).toBe(firstGeneration);
        expect(firstSurface.snapshot.value.phase).toBe('ready');
        expect(secondSurface.snapshot.value.generation).toBe(secondGeneration);
        expect(secondSurface.snapshot.value.phase).toBe('ready');
        expect(secondGeometryCommit.mock.results.map((result) => result.value)).toEqual([true]);
        expect(firstLoadErrors.value).toEqual([]);
        expect(secondLoadErrors.value).toEqual([]);
    });

    it('restores a remounted successor after its predecessor wedges mid-open', async () => {
        layOutLoadedPages();
        const predecessorRef = '/documents/wedged.djvu' as TDocumentRef;
        const successorRef = '/documents/successor.djvu' as TDocumentRef;
        let resolvePredecessorMetric!: () => void;
        const predecessorMetric = new Promise<void>((resolve) => {
            resolvePredecessorMetric = resolve;
        });
        const predecessorSource = createPageSource(predecessorRef);
        predecessorSource.getPageMetrics = vi.fn(async () => {
            await predecessorMetric;
            return {
                heightPoints: 800,
                rotation: 0 as const,
                widthPoints: 600,
            };
        });
        const successorSources: IDocumentPageSource[] = [];
        mocks.createDjvuPagePreviewSourceFromPath.mockImplementation(async (path: TDocumentRef) => ({path}));
        mocks.createDjvuPageSource.mockImplementation(async (path: TDocumentRef) => {
            if (path === predecessorRef) {
                return predecessorSource;
            }
            const source = createPageSource(path);
            successorSources.push(source);
            return source;
        });
        const predecessorSurface = createDocumentOpenSurfaceSession();
        predecessorSurface.begin({
            documentId: predecessorRef,
            documentRevision: 'open-intent:predecessor',
            provisional: true,
        });
        const successorSurface = createDocumentOpenSurfaceSession();
        successorSurface.begin({
            documentId: successorRef,
            documentRevision: 'open-intent:successor',
            provisional: true,
        });
        const predecessorErrors = ref<unknown[]>([]);
        const successorErrors = ref<unknown[]>([]);
        const predecessorSettle = createWorkspaceOpenSettleHarness();
        const successorSettle = createWorkspaceOpenSettleHarness();
        const predecessorResizing = ref(false);
        const successorResizing = ref(false);
        const successorActive = ref(true);
        const PredecessorHost = createFeaturePackHost(
            predecessorSurface,
            predecessorRef,
            predecessorErrors,
            predecessorSettle,
            predecessorResizing,
        );
        const SuccessorHost = createFeaturePackHost(
            successorSurface,
            successorRef,
            successorErrors,
            successorSettle,
            successorResizing,
            successorActive,
        );
        const activeTab = ref<'predecessor' | 'successor'>('predecessor');
        const showSuccessor = ref(true);
        const root = document.createElement('div');
        document.body.append(root);
        const app = createApp(
            defineComponent({
                setup: () => () => (activeTab.value === 'predecessor' ? h(PredecessorHost) : showSuccessor.value ? h(SuccessorHost) : null),
            }),
        );
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
        app.component(
            'UButton',
            defineComponent({
                props: ['label'],
                setup: (props) => () => h('button', props.label),
            }),
        );
        app.mount(root);
        const unmount = () => {
            app.unmount();
            root.remove();
            mountedApps.delete(unmount);
        };
        mountedApps.add(unmount);
        await vi.waitFor(() => expect(predecessorSource.getPageMetrics).toHaveBeenCalled());

        activeTab.value = 'successor';
        await nextTick();
        const settleSuccessor = async () => {
            const image = await vi.waitFor(() => {
                const candidate = root.querySelector<HTMLImageElement>(
                    '[data-document-ref="/documents/successor.djvu"] [data-testid="document-page-source-image"]',
                );
                expect(candidate).not.toBeNull();
                return candidate!;
            });
            image.dispatchEvent(new Event('load'));
            await vi.waitFor(() => expect(successorSurface.snapshot.value.phase).toBe('ready'));
            return image;
        };
        await settleSuccessor();
        expect(predecessorSource.dispose).toHaveBeenCalledOnce();

        showSuccessor.value = false;
        await nextTick();
        showSuccessor.value = true;
        await nextTick();
        const restoredImage = await settleSuccessor();
        successorActive.value = false;
        await nextTick();
        successorActive.value = true;
        await nextTick();
        restoredImage.dispatchEvent(new Event('load'));
        await vi.waitFor(() => expect(restoredImage.dataset.documentPageVisual).toBe('committed'));

        resolvePredecessorMetric();
        await nextTick();
        expect(successorSources).toHaveLength(2);
        expect(successorSurface.snapshot.value.phase).toBe('ready');
        expect(predecessorErrors.value).toEqual([]);
        expect(successorErrors.value).toEqual([]);
    });
});
