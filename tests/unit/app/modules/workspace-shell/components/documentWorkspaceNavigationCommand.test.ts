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
import type { IDocumentNavigationTicket } from '@app/modules/document-viewer/public';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { provideDocumentContextRegistry } from '@app/modules/workspace-shell/documentContext';
import {
    documentViewDetachKey,
    type TDocumentViewDetach,
} from '@app/modules/workspace-shell/documentViewContext';
import { workspaceViewerChunkLoaders } from '@app/modules/workspace-shell/viewers/workspaceViewerChunkLoaders';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import { cast } from '@tests/helpers/cast';

const toolbarRenders: Array<Record<string, unknown>> = [];
const surfaceRenders = vi.hoisted(() => ({
    openSurface: null as IDocumentOpenSurfaceSession | null,
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
        surfaceRenders.openSurface = inject(documentOpenSurfaceSessionKey, null);
        expose({
            scrollToPage: vi.fn(),
            getViewerContainer: () => null,
            restoreReadingAnchor: (anchor: unknown) => surfaceRenders.restoreReadingAnchor?.(anchor),
            getUserViewportInteractionEpoch: () => surfaceRenders.interactionEpoch.value,
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
    surfaceRenders.restoreReadingAnchor = null;
    surfaceRenders.interactionEpoch.value = 0;
    nuxtState.clear();
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
    detachDocumentView?: TDocumentViewDetach;
} = {}) {
    const { default: DocumentWorkspace } = await import(
        '@app/modules/workspace-shell/components/DocumentWorkspace.vue'
    );
    const documentSession = createWorkspaceDocumentController({tabId: 'tab-1'});
    const documentView = documentSession.getView('tab-1')!;
    if (options.hiddenSecondView) {
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
    const { default: DocumentSessionHost } = await import(
        '@app/modules/workspace-shell/components/DocumentSessionHost.vue'
    );
    const app = createApp(defineComponent({setup() {
        provideDocumentContextRegistry();
        return () => [
            h(DocumentSessionHost, {documentController: documentSession}),
            h(cast<never>(DocumentWorkspace), {
                tabId: 'tab-1',
                isActive: true,
                isRenderActive: true,
                isTabTransitionBusy: false,
                isFullscreen: false,
                fullscreenSupported: false,
                isWorkspaceLayoutResizing: false,
                splitCacheSession: null,
                startSection: 'recent',
                documentSession,
            }),
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
    app.mount(host);
    mountedApp = app;
    mountedHost = host;
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
        surfaceRenders.openSurface!.begin({
            documentId: options.openSurfaceDocument,
            documentRevision: 'revision:test-navigation',
        });
        await nextTick();
    }
    return {
        expose,
        documentSession,
    };
}

describe('DocumentWorkspace navigation command', () => {
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
            const placing = workspace.expose.placeReadingAnchorAfterOpen!(anchor);
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
