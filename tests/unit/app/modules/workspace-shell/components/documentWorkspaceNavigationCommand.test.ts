// @vitest-environment happy-dom

import {
    afterAll,
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
    inject,
    nextTick,
    shallowRef,
} from 'vue';
import type { App } from 'vue';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    documentOpenSurfaceSessionKey,
    type IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import type { IPdfSemanticAnchor } from '@contracts/recentReadingView';
import type { IDocumentNavigationTicket } from '@app/modules/document-viewer/public';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { provideDocumentContextRegistry } from '@app/modules/workspace-shell/documentContext';
import {
    documentViewDetachKey,
    useDocumentViewContext,
    type TDocumentViewDetach,
} from '@app/modules/workspace-shell/documentViewContext';
import { workspaceViewerChunkLoaders } from '@app/modules/workspace-shell/viewers/workspaceViewerChunkLoaders';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import { cast } from '@tests/helpers/cast';
import type * as PlatformDocuments from '@app/utils/platformDocuments';
import { seedOpeningSource } from '@app/modules/workspace-shell/document-sessions/recentReadingView';
import DocumentWorkspace from '@app/modules/workspace-shell/components/DocumentWorkspace.vue';
import DocumentSessionHost from '@app/modules/workspace-shell/components/DocumentSessionHost.vue';

const recentReadingViews = vi.hoisted(() => ({
    readingView: vi.fn(),
    rememberReadingView: async () => undefined,
}));
vi.mock('@app/utils/platformDocuments', async importOriginal => ({
    ...await importOriginal<typeof PlatformDocuments>(),
    getDocumentRecentFilesCapability: () => ({recentFiles: recentReadingViews}),
}));

const toolbarRenders: Array<Record<string, unknown>> = [];
const surfaceRenders = vi.hoisted(() => ({
    openSurface: null as IDocumentOpenSurfaceSession | null,
    openSurfaces: new Map<string, IDocumentOpenSurfaceSession>(),
    presentations: new Map<string, {
        presentDocument: () => void;
        clearPresentedDocument: () => void;
        captureReadingAnchor: () => IPdfSemanticAnchor | null
    }>(),
    restoreReadingAnchor: null as ((anchor: unknown) => void) | null,
    // The viewer's count of the reader's scrolls and drags.
    interactionEpoch: {value: 0},
    sidebars: [] as Array<Record<string, unknown>>,
    viewers: [] as Array<Record<string, unknown>>,
}));

vi.mock('@app/modules/pdf-viewer/components/PdfSidebar.vue', () => ({default: defineComponent({
    name: 'PdfSidebarStub',
    inheritAttrs: false,
    setup(_props, {attrs}) {
        return () => {
            surfaceRenders.sidebars.push({...attrs});
            return h('aside', {class: 'pdf-sidebar-stub'});
        };
    },
})}));

vi.mock('@app/modules/workspace-shell/viewers/workspaceViewerChunkLoaders', () => ({workspaceViewerChunkLoaders: {chassis: () => Promise.resolve({default: defineComponent({
    name: 'DocumentViewerChassisStub',
    inheritAttrs: false,
    setup(_props, {
        attrs,
        expose,
    }) {
        // The workspace owns its open surface; the viewer is where it is shared.
        const tabId = useDocumentViewContext().tabId;
        const surface = inject(documentOpenSurfaceSessionKey, null)!;
        surfaceRenders.openSurface = surface;
        surfaceRenders.openSurfaces.set(tabId, surface);
        let presented = false;
        const presentation = {
            presentDocument: () => { presented = true; },
            clearPresentedDocument: () => { presented = false; },
            captureReadingAnchor: () => presented ? {
                page: tabId === 'tab-1' ? 3 : 5,
                pageXFraction: tabId === 'tab-1' ? 0.42 : 0.72,
                pageYFraction: tabId === 'tab-1' ? 0.61 : 0.28,
                viewportXFraction: 0.5,
                viewportYFraction: 0.5,
                affinity: 'center' as const,
            } : null,
        };
        surfaceRenders.presentations.set(tabId, presentation);
        expose({
            scrollToPage: vi.fn(),
            ...presentation,
            getViewerContainer: () => null,
            restoreReadingAnchor: (anchor: unknown) => surfaceRenders.restoreReadingAnchor?.(anchor),
            getReaderInteractionEpoch: () => surfaceRenders.interactionEpoch.value,
            observeReaderCommand: () => {
                surfaceRenders.interactionEpoch.value += 1;
            },
        });
        return () => {
            surfaceRenders.viewers.push({...attrs});
            return h('div', {class: 'document-viewer-chassis-stub'});
        };
    },
})})}}));

vi.mock('@app/modules/scan-cleanup/public/workspace', () => ({
    ScanCleanupWorkspace: defineComponent({
        name: 'ScanCleanupWorkspaceStub',
        emits: [
            'done',
            'ready',
        ],
        inheritAttrs: false,
        setup: () => () => h('div', {class: 'scan-cleanup-workspace-stub'}),
    }),
    useScanCleanupSourceSha256: () => shallowRef(null),
}));

vi.mock('@app/modules/workspace-shell/components/ScanCleanupWorkspaceLoading.vue', () => ({default: defineComponent({
    name: 'ScanCleanupWorkspaceLoadingStub',
    emits: [
        'done',
        'ready',
    ],
    inheritAttrs: false,
    setup: () => () => h('div', {class: 'scan-cleanup-workspace-loading-stub'}),
})}));

// The toolbar is the consumer of the shared navigation ticket. Recording what
// DocumentWorkspace binds to it is the only way to observe, from outside, the
// command stream the workspace publishes.
vi.mock('@app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue', () => ({default: defineComponent({
    name: 'WorkspacePdfToolbarViewStub',
    inheritAttrs: false,
    setup(_props, {attrs}) {
        return () => {
            toolbarRenders.push({...attrs});
            return h('div', {class: 'workspace-pdf-toolbar-stub'});
        };
    },
})}));

// Teleport availability polls `import.meta.client`, which only Nuxt defines.
// The unit mount provides the host elements itself, so it reports them ready.
vi.mock('@app/modules/workspace-shell/composables/useWorkspaceHostTeleportAvailability', () => ({useWorkspaceHostTeleportAvailability: () => ({
    canTeleportStatus: shallowRef(true),
    canTeleportToolbar: shallowRef(true),
})}));

const nuxtState = new Map<string, unknown>();
vi.stubGlobal('useToast', () => ({add: vi.fn()}));
vi.stubGlobal('useState', (key: string, initialValue?: () => unknown) => {
    if (!nuxtState.has(key)) {
        nuxtState.set(key, shallowRef(initialValue?.()));
    }
    return nuxtState.get(key);
});
vi.stubGlobal('useCookie', (_key: string, options?: {default?: () => unknown}) => shallowRef(options?.default?.() ?? null));

let mountedApp: App | null = null;
let mountedHost: HTMLElement | null = null;
const teleportTargets: HTMLElement[] = [];

afterAll(() => {
    vi.unstubAllGlobals();
});

afterEach(() => {
    mountedApp?.unmount();
    mountedApp = null;
    mountedHost?.remove();
    mountedHost = null;
    teleportTargets.splice(0).forEach(target => target.remove());
    toolbarRenders.length = 0;
    surfaceRenders.sidebars.length = 0;
    surfaceRenders.viewers.length = 0;
    surfaceRenders.openSurface = null;
    surfaceRenders.openSurfaces.clear();
    surfaceRenders.presentations.clear();
    surfaceRenders.restoreReadingAnchor = null;
    surfaceRenders.interactionEpoch.value = 0;
    nuxtState.clear();
    vi.restoreAllMocks();
    recentReadingViews.readingView.mockReset();
});

function readToolbarAttrs() {
    const latest = toolbarRenders.at(-1);
    if (!latest) {
        throw new Error('The workspace toolbar never rendered.');
    }
    return latest;
}

function readToolbarNavigationTicket() {
    return cast<IDocumentNavigationTicket | null>(readToolbarAttrs()['navigation-ticket'] ?? null);
}

async function mountDocumentWorkspace(options: {
    initialSurfaceMode?: 'reader' | 'scan-cleanup';
    pendingDocumentPath?: TDocumentRef;
    openSurfaceDocument?: TDocumentRef;
    /** Another tab views the document without a mounted workspace, as a hidden tab does. */
    hiddenSecondView?: boolean;
    linkedSecondView?: boolean;
    detachDocumentView?: TDocumentViewDetach;
} = {}) {
    const documentSession = createWorkspaceDocumentController({tabId: 'tab-1'});
    const documentView = documentSession.getView('tab-1')!;
    if (options.hiddenSecondView || options.linkedSecondView) {
        documentSession.addView('tab-2');
    }
    if (options.initialSurfaceMode) {
        documentView.applyViewState({
            ...documentView.viewState.value,
            surfaceMode: options.initialSurfaceMode,
        });
    }
    if (options.pendingDocumentPath) {
        // An open that has not finished loading keeps the tab opening.
        void documentSession.runOpen({
            kind: 'open',
            target: {
                fileName: 'reopened.pdf',
                originalPath: options.pendingDocumentPath,
            },
        }, () => new Promise<boolean>(() => {}));
    }
    // Nuxt UI registers its primitives globally in the app; unit mounts resolve
    // them to an inert passthrough so the workspace tree itself stays real.
    const designSystemStub = defineComponent({
        name: 'DesignSystemStub',
        inheritAttrs: false,
        setup(_props, {slots}) {
            return () => h('div', slots.default?.({}) ?? []);
        },
    });
    let registry: ReturnType<typeof provideDocumentContextRegistry> | null = null;
    const app = createApp(defineComponent({setup() {
        registry = provideDocumentContextRegistry();
        return () => [
            h(DocumentSessionHost, {documentController: documentSession}),
            ...(options.linkedSecondView ? [
                'tab-1',
                'tab-2',
            ] : ['tab-1']).map(tabId => h(cast<never>(DocumentWorkspace), {
                tabId,
                isActive: tabId === 'tab-1',
                isRenderActive: true,
                isTabTransitionBusy: false,
                isFullscreen: false,
                fullscreenSupported: false,
                isWorkspaceLayoutResizing: false,
                splitCacheSession: null,
                startSection: 'recent',
                documentSession,
            })),
        ];
    }}));
    if (options.detachDocumentView) {
        app.provide(documentViewDetachKey, options.detachDocumentView);
    }
    cast<{_context: {components: unknown}}>(app)._context.components = new Proxy({}, {
        get: () => designSystemStub,
        has: () => true,
    });
    // The shell teleports its toolbar into the app-owned host element, so the
    // toolbar only renders when that target exists.
    for (const hostId of [
        'editor-global-toolbar-host',
        'editor-global-status-host',
    ]) {
        const teleportTarget = document.createElement('div');
        teleportTarget.id = hostId;
        document.body.append(teleportTarget);
        teleportTargets.push(teleportTarget);
    }
    const host = document.createElement('div');
    document.body.append(host);
    // Register cleanup before mounting so a failed or timed-out mount cannot
    // leave a workspace rendering into the next case.
    mountedApp = app;
    mountedHost = host;
    app.mount(host);
    // The viewer chassis is an async chunk the shell requests while mounting.
    // Settling it here keeps its import from resolving after the environment
    // has been torn down.
    await workspaceViewerChunkLoaders.chassis();
    await nextTick();
    const expose = documentView.mountedWorkspace.value;
    if (!expose) {
        throw new Error('DocumentWorkspace never attached to its tab controller.');
    }
    if (options.openSurfaceDocument) {
        await vi.waitFor(() => expect(surfaceRenders.openSurface).not.toBeNull());
        for (const surface of surfaceRenders.openSurfaces.values()) {
            surface.begin({
                documentId: options.openSurfaceDocument,
                documentRevision: 'revision:test-navigation',
            });
        }
        await nextTick();
    }
    return {
        expose,
        documentSession,
        documentContext: registry!.get(documentSession)!,
    };
}

describe('DocumentWorkspace navigation command', () => {
    it.each([
        false,
        true,
    ])('keeps each pre-save reading point after the old presentation clears (late revision: %s)', async (lateRevision) => {
        const path = requireDocumentRef('/tmp/shared.pdf');
        const workspace = await mountDocumentWorkspace({
            pendingDocumentPath: path,
            openSurfaceDocument: path,
            linkedSecondView: true,
        });
        const source = {
            kind: 'path' as const,
            path,
            size: 400,
        };
        workspace.documentContext.file.pdfSrc.value = source;
        workspace.documentSession.markPresented();
        for (const view of surfaceRenders.presentations.values()) view.presentDocument();
        await nextTick();
        const anchors = [...surfaceRenders.presentations.values()].map(view => view.captureReadingAnchor());
        vi.spyOn(workspace.documentContext.saveService.isAnySaving, 'value', 'get').mockReturnValue(true);

        workspace.documentContext.file.pdfSrc.value = {...source};
        for (const view of surfaceRenders.presentations.values()) {
            view.clearPresentedDocument();
            expect(view.captureReadingAnchor()).toBeNull();
        }
        const revision = lateRevision ? 'revision:saved' : 'revision:test-navigation';
        if (lateRevision) {
            workspace.documentContext.file.documentRevisionToken.value = cast<never>(revision);
        }
        for (const [
            index,
            surface,
        ] of [...surfaceRenders.openSurfaces.values()].entries()) {
            surface.acquireSource({
                documentId: path,
                documentRevision: revision,
            }, surface.snapshot.value.generation);
            expect(surface.snapshot.value.identity?.documentRevision).toBe(revision);
            expect(surface.navigationTicket.value?.request).toMatchObject({
                source: 'restore',
                target: {
                    kind: 'page',
                    page: anchors[index]!.page,
                    anchor: anchors[index],
                },
            });
        }
        await nextTick();
        expect(readToolbarNavigationTicket()?.request.target).toMatchObject({anchor: anchors[0]});
    });

    it('leaves page-mutation navigation in charge of a source reload outside saving', async () => {
        const path = requireDocumentRef('/tmp/mutation.pdf');
        const workspace = await mountDocumentWorkspace({
            pendingDocumentPath: path,
            openSurfaceDocument: path,
        });
        const source = {
            kind: 'path' as const,
            path,
            size: 400,
        };
        workspace.documentContext.file.pdfSrc.value = source;
        workspace.documentSession.markPresented();
        for (const view of surfaceRenders.presentations.values()) view.presentDocument();
        await nextTick();
        workspace.expose.handleGoToPage(4);
        workspace.documentContext.file.pdfSrc.value = {...source};
        await nextTick();
        expect(readToolbarNavigationTicket()?.request.target).toEqual({
            kind: 'page',
            page: 4,
        });
    });

    it.each([
        [
            'page-operation',
            'nothing',
        ],
        [
            'page-operation',
            'save',
        ],
        [
            'page-operation',
            'save-as',
        ],
        [
            'ocr-apply',
            'nothing',
        ],
        [
            'ocr-apply',
            'save',
        ],
        [
            'ocr-apply',
            'save-as',
        ],
    ] as const)('keeps the page a %s places when %s waits behind it', async (kind, queuedSave) => {
        const path = requireDocumentRef('/tmp/queued-save.pdf');
        const workspace = await mountDocumentWorkspace({
            pendingDocumentPath: path,
            openSurfaceDocument: path,
        });
        const source = {
            kind: 'path' as const,
            path,
            size: 400,
        };
        const file = workspace.documentContext.file;
        file.pdfSrc.value = source;
        file.workingCopyPath.value = path;
        file.originalPath.value = path;
        file.isDirty.value = true;
        workspace.documentSession.markPresented();
        for (const view of surfaceRenders.presentations.values()) view.presentDocument();
        await nextTick();

        let releaseOperation!: () => void;
        const gate = new Promise<void>(resolve => {
            releaseOperation = resolve;
        });
        const operation = workspace.documentSession.operationLease.runExclusive(kind, () => gate);
        await vi.waitFor(() => expect(workspace.documentSession.operationLease.activeKind.value).toBe(kind));
        const {saveService} = workspace.documentContext;
        const save = queuedSave === 'save-as'
            ? saveService.handleSaveAs()
            : queuedSave === 'save' ? saveService.handleSave() : null;
        try {
            // The queued save joins the operation lease within the next microtask.
            await nextTick();
            workspace.expose.handleGoToPage(4);
            file.pdfSrc.value = {...source};
            await nextTick();
            expect(readToolbarNavigationTicket()?.request.target).toEqual({
                kind: 'page',
                page: 4,
            });
        } finally {
            releaseOperation();
            await operation;
            await save?.catch(() => false);
        }
    });

    it('does not mount the reader presentation in scan-cleanup mode', async () => {
        await mountDocumentWorkspace({
            initialSurfaceMode: 'scan-cleanup',
            pendingDocumentPath: requireDocumentRef('/tmp/reopened.pdf'),
        });

        await vi.waitFor(() => {
            expect(surfaceRenders.viewers.length).toBeGreaterThan(0);
        });
        const viewer = surfaceRenders.viewers.at(-1);
        expect(surfaceRenders.sidebars).toHaveLength(0);
        expect(viewer?.mountPresentation ?? viewer?.['mount-presentation']).toBe(false);
    }, 120_000);

    it('publishes every page navigation to the toolbar as one command stream', async () => {
        const workspace = await mountDocumentWorkspace({openSurfaceDocument: requireDocumentRef('/tmp/navigation.pdf')});

        expect(readToolbarNavigationTicket()?.request.target).toEqual({
            kind: 'page',
            page: 1,
        });

        workspace.expose.handleGoToPage(4);
        await nextTick();
        expect(readToolbarNavigationTicket()?.request.target).toEqual({
            kind: 'page',
            page: 4,
        });

        workspace.expose.handleGoToPage(7);
        await nextTick();
        expect(readToolbarNavigationTicket()?.request.target).toEqual({
            kind: 'page',
            page: 7,
        });
    }, 120_000);

    it('shares one revision stream between the toolbar and the rest of the workspace', async () => {
        const workspace = await mountDocumentWorkspace({openSurfaceDocument: requireDocumentRef('/tmp/navigation.pdf')});
        const toolbarGoToPage = cast<(page: number, options?: IScrollToPageOptions) => void>(readToolbarAttrs()['onGoToPage']);
        const navigationOptions: IScrollToPageOptions = {
            navigationSource: 'annotation',
            markerRect: {
                left: 0.25,
                top: 0.7,
                width: 0.2,
                height: 0.1,
            },
        };

        workspace.expose.handleGoToPage(4);
        await nextTick();
        toolbarGoToPage(9, navigationOptions);
        await nextTick();

        // The shared surface retains one current ticket, so a newer publisher
        // replaces the toolbar's target and source atomically.
        expect(readToolbarNavigationTicket()?.request).toMatchObject({
            target: {
                kind: 'rect',
                page: 9,
            },
            source: 'annotation',
        });
    }, 120_000);

    it('opens another file in a document of its own while a hidden tab still views this one', async () => {
        const detachDocumentView = vi.fn<TDocumentViewDetach>(async () => {});
        const workspace = await mountDocumentWorkspace({
            openSurfaceDocument: requireDocumentRef('/tmp/shared.pdf'),
            hiddenSecondView: true,
            detachDocumentView,
        });

        await workspace.expose.handleOpenFileDirectWithPersist(requireDocumentRef('/tmp/other.pdf'));

        // The view leaves the shared document; the document itself opens nothing.
        expect(detachDocumentView).toHaveBeenCalledWith('tab-1', expect.any(Function));
        expect(workspace.documentSession.snapshot.value.activeTransaction).toBeNull();
        expect(workspace.documentSession.snapshot.value.identity.originalPath).toBeNull();
    }, 120_000);

    it.each([
        'handleZoomIn',
        'handleZoomOut',
        'handleActualSize',
        'handleFitWidth',
        'handleFitHeight',
    ] as const)('lets the reader\'s %s outrank a restored place, which a restored view does not', async (command) => {
        const workspace = await mountDocumentWorkspace({
            pendingDocumentPath: requireDocumentRef('/tmp/shared.pdf'),
            openSurfaceDocument: requireDocumentRef('/tmp/shared.pdf'),
        });
        const reader = workspace.expose.followReader!();

        workspace.expose.restoreViewState({
            currentPage: null,
            zoom: 1.5,
            zoomMode: 'custom',
            continuousScroll: false,
            viewMode: 'facing',
            viewRotation: 90,
        });
        expect(reader.moved()).toBe(false);
        expect(workspace.expose.getToolbarSnapshot().zoom).toBe(1.5);

        workspace.expose[command]();
        expect(reader.moved()).toBe(true);
        await reader.finish(null);
    }, 120_000);

    describe('following the reader of an open across the viewer routing', () => {
        // The workspace routes its viewer through the PDF or the DjVu slot as
        // the source changes, clearing and re-binding them while the same
        // chassis, with its interaction count, stays mounted. The routing is
        // driven here directly, before the workspace re-renders and re-binds.
        async function mountFollowedView() {
            surfaceRenders.interactionEpoch.value = 3;
            const {
                documentContext,
                expose,
            } = await mountDocumentWorkspace();
            const view = cast<{
                pdfViewerRef: {value: unknown};
                djvuViewerRef: {value: unknown};
                documentViewerRef: {value: unknown};
            }>(documentContext.views.commandView.value!.view);
            await vi.waitFor(() => expect(view.documentViewerRef.value).not.toBeNull());
            const chassis = view.documentViewerRef.value;
            const reader = expose.followReader!();
            const routeAway = () => {
                view.pdfViewerRef.value = null;
                view.djvuViewerRef.value = null;
            };
            return {
                view,
                chassis,
                reader,
                routeAway,
                routeTo: (viewer: unknown) => {
                    view.djvuViewerRef.value = viewer;
                },
            };
        }

        it('keeps a reader who has not moved unmoved when the same chassis is routed away and back', async () => {
            const followed = await mountFollowedView();

            followed.routeAway();
            expect(followed.view.documentViewerRef.value).toBeNull();
            followed.routeTo(followed.chassis);
            expect(followed.reader.moved()).toBe(false);

            surfaceRenders.interactionEpoch.value = 4;
            expect(followed.reader.moved()).toBe(true);
            await followed.reader.finish(null);
        }, 120_000);

        it('counts a move in a different chassis that replaced the followed one from that chassis\'s start', async () => {
            const followed = await mountFollowedView();
            const replacementMoves = {value: 0};

            followed.routeAway();
            followed.routeTo({getReaderInteractionEpoch: () => replacementMoves.value});
            expect(followed.reader.moved()).toBe(false);

            replacementMoves.value = 1;
            expect(followed.reader.moved()).toBe(true);
            await followed.reader.finish(null);
        }, 120_000);
    });

    it('ends a normal open whose admission throws as a failed open ends: its view takes no later reading seed', async () => {
        const {
            documentContext,
            documentSession,
            expose,
        } = await mountDocumentWorkspace();
        const {
            zoom: zoomBefore,
            zoomMode: zoomModeBefore,
        } = expose.getToolbarSnapshot();
        recentReadingViews.readingView.mockResolvedValue({
            currentPage: 27,
            pageCount: 40,
            zoom: 1.85,
            zoomMode: 'custom',
            viewMode: 'single',
            continuousScroll: true,
            viewRotation: 0,
        });

        await expect(documentContext.views.runDocumentOpen({
            kind: 'open',
            target: {
                fileName: 'remembered.pdf',
                originalPath: requireDocumentRef('/tmp/remembered.pdf'),
            },
        }, () => Promise.reject(new Error('admission refused')))).rejects.toThrow('admission refused');
        // A late source admission for the open that ended reaches no open.
        await seedOpeningSource(documentSession, requireDocumentRef('/tmp/remembered-working.pdf'), Promise.resolve(40));

        await nextTick();
        expect(expose.getToolbarSnapshot()).toMatchObject({
            zoom: zoomBefore,
            zoomMode: zoomModeBefore,
        });
    }, 120_000);

    describe('placing a split view at its source\'s reading point', () => {
        const anchor = {
            page: 3,
            pageXFraction: 0.5,
            pageYFraction: 0.4,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
            affinity: 'center' as const,
        };

        async function mountOpeningView() {
            const restored: unknown[] = [];
            surfaceRenders.restoreReadingAnchor = anchorToRestore => restored.push(anchorToRestore);
            const workspace = await mountDocumentWorkspace({
                pendingDocumentPath: requireDocumentRef('/tmp/shared.pdf'),
                openSurfaceDocument: requireDocumentRef('/tmp/shared.pdf'),
            });
            const placing = workspace.expose.followReader!().finish(anchor);
            return {
                ...workspace,
                placing,
                restored,
                // The view's document finishes opening.
                settle: () => workspace.documentSession.markPresented(),
            };
        }

        it('places the anchor once the document has opened', async () => {
            const view = await mountOpeningView();
            await nextTick();
            expect(view.restored).toEqual([]);

            view.settle();
            await view.placing;

            expect(view.restored).toEqual([anchor]);
        }, 120_000);

        it('places the anchor after the opening restores the view\'s own page', async () => {
            const view = await mountOpeningView();

            // What the page-session restore issues once the view has a page count.
            surfaceRenders.openSurface!.navigate({
                target: {
                    kind: 'page',
                    page: 1,
                },
                alignment: 'page-top',
                readiness: 'page-canvas',
                source: 'restore',
                supersession: 'latest-wins',
            });
            await nextTick();
            view.settle();
            await view.placing;

            expect(view.restored).toEqual([anchor]);
        }, 120_000);

        it('leaves the view where the reader sent it by going to its own first page while it opened', async () => {
            const view = await mountOpeningView();

            // The toolbar's Go to page on the page the view opens at, to see its top.
            view.expose.handleGoToPage(1);
            await nextTick();
            view.settle();
            await view.placing;

            expect(view.restored).toEqual([]);
        }, 120_000);

        it('places the anchor in a viewer the reader had used before the placement began', async () => {
            surfaceRenders.interactionEpoch.value = 3;
            const view = await mountOpeningView();

            view.settle();
            await view.placing;

            expect(view.restored).toEqual([anchor]);
        }, 120_000);

        it('leaves the view where the reader scrolled while it opened', async () => {
            surfaceRenders.interactionEpoch.value = 3;
            const view = await mountOpeningView();

            surfaceRenders.interactionEpoch.value = 4;
            await nextTick();
            view.settle();
            await view.placing;

            expect(view.restored).toEqual([]);
        }, 120_000);

        it('leaves the view where the reader navigated while it opened', async () => {
            const view = await mountOpeningView();

            view.expose.handleGoToPage(5);
            await nextTick();
            view.settle();
            await view.placing;

            expect(view.restored).toEqual([]);
        }, 120_000);
    });
});
