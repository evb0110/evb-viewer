// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/utils/document-viewer/source/createDjvuPageSource';

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    provide,
    ref,
    type Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import DocumentPageSourceFeaturePack from '@app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceSession,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import {
    createDocumentViewerChassisAuthority,
    documentViewerChassisAuthorityKey,
} from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';

const mocks = vi.hoisted(() => ({
    createDjvuPagePreviewSourceFromPath: vi.fn(),
    createDjvuPageSource: vi.fn(),
}));

vi.mock('@app/platform/browser-api/public', () => ({createDjvuPagePreviewSourceFromPath:
    mocks.createDjvuPagePreviewSourceFromPath}));
vi.mock('@app/utils/document-viewer/source/createDjvuPageSource', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    createDjvuPageSource:
    mocks.createDjvuPageSource,
}));

const mountedApps = new Set<() => void>();

interface IWorkspaceOpenSettleHarness {
    initialVisualReady: Ref<boolean>;
    totalPages: Ref<number>;
    waitForDocumentOpenSettled: () => Promise<void>;
}

function createWorkspaceOpenSettleHarness(): IWorkspaceOpenSettleHarness {
    return {
        initialVisualReady: ref(false),
        totalPages: ref(0),
        waitForDocumentOpenSettled: () => Promise.reject(new Error('Workspace host is not mounted')),
    };
}

function createPageSource(documentRef: TDocumentRef): IDocumentPageSource {
    return {
        kind: 'djvu',
        documentRef,
        pageCount: 1,
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
            const authority = createDocumentViewerChassisAuthority(ref('djvu'), 1, surface);
            const totalPages = ref(0);
            const isLoading = ref(false);
            const settle = useDocumentOpenVisualSettle({
                tabId: String(documentRef),
                hasPdf: ref(false),
                pdfSrc: ref(null),
                pdfDocument: ref(null),
                totalPages,
                pageLabelsResolved: ref(false),
                isLoading,
                pdfError: ref(null),
                djvuError: ref(null),
                showDjvuSource: ref(true),
                openSurface: surface,
                markAnnotationCommentsLoading: vi.fn(),
            });
            settleHarness.initialVisualReady = settle.initialDocumentVisualReady;
            settleHarness.totalPages = totalPages;
            settleHarness.waitForDocumentOpenSettled = settle.waitForDocumentOpenSettled;
            provide(documentViewerChassisAuthorityKey, authority);
            return () => {
                const snapshot = surface.snapshot.value;
                return h('div', {
                    ref: (element: unknown) => {
                        authority.bindViewportElement(element instanceof HTMLElement ? element : null);
                    },
                    class: 'document-viewer-viewport',
                    'data-document-ref': documentRef,
                }, [
                    h('section', {
                        ref: (element: unknown) => {
                            authority.bindOpeningPageElement(element instanceof HTMLElement ? element : null);
                        },
                        'data-document-page-number': '1',
                        'data-open-surface-frame-owner': snapshot.openingPageFrame?.ownerId ?? '',
                        'data-open-surface-generation': String(snapshot.generation),
                        'data-page-number': '1',
                    }),
                    h(DocumentPageSourceFeaturePack, {
                        currentPage: 1,
                        documentRevisionToken: requireDocumentRevisionToken(`revision:${documentRef}`),
                        isActive: isActive.value,
                        isResizing: isResizing.value,
                        onInitialVisualPending: settle.handlePdfInitialVisualPending,
                        onInitialVisualReady: settle.handlePdfInitialVisualReady,
                        onLoadError: (error: unknown) => loadErrors.value.push(error),
                        onLoading: (loading: boolean) => {
                            isLoading.value = loading;
                        },
                        'onUpdate:totalPages': (pageCount: number) => {
                            totalPages.value = pageCount;
                        },
                        src: documentRef,
                    }),
                ]);
            };
        },
    });
}

afterEach(() => {
    for (const unmount of mountedApps) unmount();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('DocumentPageSourceFeaturePack concurrent open surfaces', () => {
    it('publishes prepared opening page count before the page source resolves', async () => {
        const documentRef = '/documents/large.djvu' as TDocumentRef;
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: documentRef,
            documentRevision: 'open-intent:large',
        }, {
            documentId: documentRef,
            height: 800,
            pageCount: 1_859,
            pageNumber: 1,
            rotation: 0,
            width: 600,
        });
        const previewGate = Promise.withResolvers<{path: TDocumentRef}>();
        mocks.createDjvuPagePreviewSourceFromPath.mockImplementation(() => previewGate.promise);
        mocks.createDjvuPageSource.mockImplementation(async (path: TDocumentRef) => createPageSource(path));
        const settle = createWorkspaceOpenSettleHarness();
        const Host = createFeaturePackHost(
            surface,
            documentRef,
            ref<unknown[]>([]),
            settle,
            ref(false),
        );
        const root = document.createElement('div');
        document.body.append(root);
        const app = createApp(Host);
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
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

    it('settles a cold second workspace after its opening image is relocated', async () => {
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
        vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
        vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(600);
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
        mocks.createDjvuPagePreviewSourceFromPath.mockImplementation(async (path: TDocumentRef) => ({path}));
        mocks.createDjvuPageSource.mockImplementation(async (path: TDocumentRef) => createPageSource(path));

        const firstDocumentRef = '/documents/first.djvu' as TDocumentRef;
        const secondDocumentRef = '/documents/second.djvu' as TDocumentRef;
        const firstSurface = createDocumentOpenSurfaceSession();
        const secondSurface = createDocumentOpenSurfaceSession();
        const firstGeneration = firstSurface.begin({
            documentId: firstDocumentRef,
            documentRevision: 'open-intent:first',
        }, {
            documentId: firstDocumentRef,
            height: 800,
            pageCount: 1,
            pageNumber: 1,
            rotation: 0,
            width: 600,
        });
        const secondGeneration = secondSurface.begin({
            documentId: secondDocumentRef,
            documentRevision: 'open-intent:second',
        });
        const secondGeometryCommit = vi.spyOn(secondSurface, 'commitGeometry');
        const firstLoadErrors = ref<unknown[]>([]);
        const secondLoadErrors = ref<unknown[]>([]);
        const firstSettle = createWorkspaceOpenSettleHarness();
        const secondSettle = createWorkspaceOpenSettleHarness();
        const firstWorkspaceIsResizing = ref(false);
        const secondWorkspaceIsResizing = ref(false);
        const FirstHost = createFeaturePackHost(
            firstSurface,
            firstDocumentRef,
            firstLoadErrors,
            firstSettle,
            firstWorkspaceIsResizing,
        );
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
        const app = createApp(defineComponent({setup: () => () => h('div', [
            h(FirstHost),
            showSecondWorkspace.value ? h(SecondHost) : null,
        ])}));
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
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
        const firstSettled = firstSettle.waitForDocumentOpenSettled();
        firstImage.dispatchEvent(new Event('load'));
        await vi.waitFor(() => expect(firstSettle.initialVisualReady.value).toBe(true));
        await expect(firstSettled).resolves.toBeUndefined();

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
        const secondSettled = secondSettle.waitForDocumentOpenSettled();
        const openingTarget = secondImage.parentElement!;
        const openingTargetParent = openingTarget.parentElement!;
        secondImage.dispatchEvent(new Event('load'));
        openingTarget.remove();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        openingTargetParent.append(openingTarget);
        secondWorkspaceIsResizing.value = true;
        await nextTick();
        secondWorkspaceIsResizing.value = false;

        await vi.waitFor(() => expect(secondSettle.initialVisualReady.value).toBe(true));
        await expect(secondSettled).resolves.toBeUndefined();

        expect(firstSurface.snapshot.value.generation).toBe(firstGeneration);
        expect(firstSurface.snapshot.value.phase).toBe('ready');
        expect(secondSurface.snapshot.value.generation).toBe(secondGeneration);
        expect(secondSurface.snapshot.value.phase).toBe('ready');
        expect(secondGeometryCommit.mock.results.map(result => result.value)).toEqual([true]);
        expect(firstLoadErrors.value).toEqual([]);
        expect(secondLoadErrors.value).toEqual([]);
    });

    it('restores a remounted successor after its predecessor wedges mid-open', async () => {
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
        vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
        vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(600);
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
        });
        const successorSurface = createDocumentOpenSurfaceSession();
        successorSurface.begin({
            documentId: successorRef,
            documentRevision: 'open-intent:successor',
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
        const app = createApp(defineComponent({setup: () => () => (
            activeTab.value === 'predecessor'
                ? h(PredecessorHost)
                : showSuccessor.value ? h(SuccessorHost) : null
        )}));
        app.component('USkeleton', defineComponent({setup: () => () => h('span')}));
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
