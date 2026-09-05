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
    nextTick,
    shallowRef,
} from 'vue';
import type { App } from 'vue';
import {
    createDocumentOpenSurfaceSession,
    documentOpenSurfaceSessionKey,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { workspaceViewerChunkLoaders } from '@app/modules/workspace-shell/viewers/workspaceViewerChunkLoaders';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import { cast } from '@tests/helpers/cast';

interface IToolbarNavigationCommand {
    page: number;
    revision: number;
}

const toolbarRenders: Array<Record<string, unknown>> = [];
const surfaceRenders = vi.hoisted(() => ({
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
        expose({scrollToPage: vi.fn()});
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

// The toolbar is the consumer of the workspace navigation command. Recording
// what DocumentWorkspace binds to it is the only way to observe, from outside,
// which command stream the workspace publishes.
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
    nuxtState.clear();
});

function readToolbarAttrs() {
    const latest = toolbarRenders.at(-1);
    if (!latest) {
        throw new Error('The workspace toolbar never rendered.');
    }
    return latest;
}

function readToolbarNavigationCommand() {
    return cast<IToolbarNavigationCommand | null>(readToolbarAttrs()['navigation-command'] ?? null);
}

async function mountDocumentWorkspace(options: {
    initialSurfaceMode?: 'reader' | 'scan-cleanup';
    pendingDocumentPath?: string;
} = {}) {
    const { default: DocumentWorkspace } = await import(
        '@app/modules/workspace-shell/components/DocumentWorkspace.vue'
    );
    const documentSession = createWorkspaceDocumentController({
        tabId: 'tab-1',
        initialRecord: createWorkspaceDocumentRecord({
            tab: options.pendingDocumentPath
                ? {
                    fileName: 'reopened.pdf',
                    originalPath: options.pendingDocumentPath,
                }
                : undefined,
            toolbarSnapshot: options.pendingDocumentPath
                ? {
                    currentPage: 1,
                    hasPdf: true,
                    totalPages: 1,
                }
                : undefined,
        }),
    });
    if (options.initialSurfaceMode) {
        documentSession.applyViewState({
            ...documentSession.snapshot.value.viewState,
            surfaceMode: options.initialSurfaceMode,
        });
    }
    const exposes: IWorkspaceExpose[] = [];
    // Nuxt UI registers its primitives globally in the app; unit mounts resolve
    // them to an inert passthrough so the workspace tree itself stays real.
    const designSystemStub = defineComponent({
        name: 'DesignSystemStub',
        inheritAttrs: false,
        setup(_props, {slots}) {
            return () => h('div', slots.default?.({}) ?? []);
        },
    });
    const app = createApp(defineComponent({setup() {
        return () => h(cast<never>(DocumentWorkspace), {
            tabId: 'tab-1',
            isActive: true,
            isRenderActive: true,
            isTabTransitionBusy: false,
            isFullscreen: false,
            fullscreenSupported: false,
            isWorkspaceLayoutResizing: false,
            initialViewState: null,
            pendingDocumentOpen: Boolean(options.pendingDocumentPath),
            pendingDocumentPath: options.pendingDocumentPath ?? null,
            suppressEmptyState: false,
            splitCacheSession: null,
            startSection: 'recent',
            documentSession,
            onExposeReady: (expose: IWorkspaceExpose) => exposes.push(expose),
        });
    }}));
    cast<{_context: {components: unknown}}>(app)._context.components = new Proxy({}, {
        get: () => designSystemStub,
        has: () => true,
    });
    app.provide(documentOpenSurfaceSessionKey, createDocumentOpenSurfaceSession());
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
    const expose = exposes.at(-1);
    if (!expose) {
        throw new Error('DocumentWorkspace never published its workspace expose.');
    }
    return {expose};
}

describe('DocumentWorkspace navigation command', () => {
    it('does not mount the reader presentation in scan-cleanup mode', async () => {
        await mountDocumentWorkspace({
            initialSurfaceMode: 'scan-cleanup',
            pendingDocumentPath: '/tmp/reopened.pdf',
        });

        await vi.waitFor(() => {
            expect(surfaceRenders.viewers.length).toBeGreaterThan(0);
        });
        const viewer = surfaceRenders.viewers.at(-1);
        expect(surfaceRenders.sidebars).toHaveLength(0);
        expect(viewer?.mountPresentation ?? viewer?.['mount-presentation']).toBe(false);
    }, 120_000);

    it('publishes every page navigation to the toolbar as one command stream', async () => {
        const workspace = await mountDocumentWorkspace();

        expect(readToolbarNavigationCommand()).toBeNull();

        workspace.expose.handleGoToPage(4);
        await nextTick();
        expect(readToolbarNavigationCommand()).toEqual({
            page: 4,
            revision: 1,
        });

        workspace.expose.handleGoToPage(7);
        await nextTick();
        expect(readToolbarNavigationCommand()).toEqual({
            page: 7,
            revision: 2,
        });
    }, 120_000);

    it('shares one revision stream between the toolbar and the rest of the workspace', async () => {
        const workspace = await mountDocumentWorkspace();
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

        // A second publisher would restart its own revisions, leaving the
        // toolbar unable to tell that another source superseded its intent.
        expect(readToolbarNavigationCommand()).toEqual({
            page: 9,
            revision: 2,
        });
    }, 120_000);
});
