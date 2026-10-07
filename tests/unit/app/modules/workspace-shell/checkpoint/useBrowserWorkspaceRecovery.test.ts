// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
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
    ref,
    shallowRef,
} from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import { requirePaneId } from '@contracts/editorPanes';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { requireEpochMs } from '@contracts/timestamps';
import { requireTabId } from '@contracts/windowTabs';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { cast } from '@tests/helpers/cast';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

// The browser stores are the boundary: what recovery stores is what a later
// session recovers from.
const stores = vi.hoisted(() => ({
    documents: [] as string[],
    checkpoints: [] as unknown[],
}));

vi.mock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: {
    createStoredDocument: vi.fn(async (fileName: string) => {
        stores.documents.push(fileName);
        return `/browser-recovery/${String(stores.documents.length)}-${fileName}`;
    }),
    cleanupDetachedDocument: vi.fn(async () => {}),
}}));
vi.mock('@app/platform/browser/browserWorkspaceRecoveryStore', () => ({
    loadBrowserWorkspaceRecovery: vi.fn(async () => null),
    saveBrowserWorkspaceRecovery: vi.fn(async (_ownerId: string, generation: number, checkpoint: unknown) => {
        stores.checkpoints.push(checkpoint);
        return {
            saved: true,
            generation: generation + 1,
        };
    }),
    clearBrowserWorkspaceRecovery: vi.fn(async (_ownerId: string, generation: number) => ({
        saved: true,
        generation,
    })),
    touchBrowserWorkspaceRecovery: vi.fn(async (_ownerId: string, generation: number) => ({
        saved: true,
        generation,
    })),
}));
vi.mock('@app/platform/browserWindowTabs', () => ({getBrowserWindowRecoveryOwnerId: () => 'owner-1'}));
// The desktop crash checkpoint's boundary: the checkpoints main saved.
const desktop = vi.hoisted(() => ({
    saved: [] as unknown[],
    save: async (checkpoint: unknown) => {
        desktop.saved.push(checkpoint);
    },
}));
vi.mock('@app/utils/platformWindowTabs', () => ({getWindowTabsCapability: () => ({saveWorkspaceCheckpoint: (checkpoint: unknown) => desktop.save(checkpoint)})}));
vi.mock('@app/utils/platform', async importOriginal => ({
    ...await importOriginal<object>(),
    waitForDesktopPlatformBridge: async () => undefined,
}));
vi.mock('@app/platform/browser/browserDocumentLeaseStore', () => ({
    createBrowserDocumentLiveLease: vi.fn(async () => ({generation: 1})),
    saveBrowserDocumentLiveLease: vi.fn(async () => ({generation: 1})),
    releaseBrowserDocumentLiveLease: vi.fn(async () => {}),
}));

const { useBrowserWorkspaceRecovery } = await import(
    '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery'
);
const { useWorkspaceCrashCheckpoint } = await import(
    '@app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint'
);

// The existing toaster is the notice boundary: a rejected checkpoint must
// retain its visible warning until a replacement checkpoint becomes durable.
const notices = ref<Array<{
    id: string;
    title: string;
    description?: string
}>>([]);
beforeEach(() => {
    vi.stubGlobal('useToast', () => ({
        toasts: notices,
        add: (notice: (typeof notices.value)[number]) => {
            const previous = notices.value.findIndex(candidate => candidate.id === notice.id);
            if (previous < 0) notices.value.push(notice);
            else notices.value[previous] = notice;
        },
        remove: (id: string) => {
            notices.value = notices.value.filter(notice => notice.id !== id);
        },
    }));
});

const unmounts: Array<() => void> = [];

afterEach(() => {
    unmounts.splice(0).forEach(unmount => unmount());
    stores.documents.length = 0;
    stores.checkpoints.length = 0;
    notices.value = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// Mounts recovery over one dirty PDF shown in two views (tab-1 and tab-2),
// whose mounted workspaces produce recovery bytes through `snapshotBytes`.
function mountLinkedDocumentRecovery(snapshotBytes: () => Promise<Uint8Array | null>) {
    const workingCopyPath = requireDocumentRef('/browser-working/shared.pdf');
    const originalPath = requireDocumentRef('/documents/shared.pdf');
    const session = createWorkspaceDocumentController({tabId: 'tab-1'});
    session.commitDocument({
        fileName: 'shared.pdf',
        originalPath,
        isDjvu: false,
        revisionInfo: {
            version: 1,
            token: requireDocumentRevisionToken('revision-1'),
            documentRef: workingCopyPath,
            authority: 'browser-document-store',
            contentRevision: 1,
            mintedAt: requireEpochMs(1),
        },
    });
    session.setDirty(true);
    session.addView('tab-2');
    for (const tabId of [
        'tab-1',
        'tab-2',
    ]) {
        session.attachWorkspace(tabId, createWorkspaceExposeFixture({
            createRecoverySnapshotBytes: snapshotBytes,
            getAutomationStateSnapshot: () => cast({
                originalPath,
                workingCopyPath,
            }),
        }));
    }
    const panes: IEditorPaneState[] = [
        {
            paneId: requirePaneId('pane-1'),
            tabIds: [requireTabId('tab-1')],
            activeTabId: requireTabId('tab-1'),
        },
        {
            paneId: requirePaneId('pane-2'),
            tabIds: [requireTabId('tab-2')],
            activeTabId: requireTabId('tab-2'),
        },
    ];
    const host = document.createElement('div');
    const app = createApp(defineComponent({setup() {
        useBrowserWorkspaceRecovery({
            enabled: ref(true),
            panes: ref(panes),
            tabs: ref([
                {id: 'tab-1'},
                {id: 'tab-2'},
            ]),
            layout: ref<TEditorLayoutNode | null>({
                type: 'split',
                id: 'split-1',
                orientation: 'horizontal',
                ratio: 0.5,
                first: {
                    type: 'leaf',
                    paneId: requirePaneId('pane-1'),
                },
                second: {
                    type: 'leaf',
                    paneId: requirePaneId('pane-2'),
                },
            }),
            activePaneId: ref<string | null>('pane-2'),
            activeTabId: ref<string | null>('tab-2'),
            documentSessionsByTabId: shallowRef({
                'tab-1': session,
                'tab-2': session,
            }),
            getPaneByTabId: tabId => panes.find(pane => pane.tabIds.includes(requireTabId(tabId))) ?? null,
        });
        return () => h('div');
    }}));
    app.mount(host);
    unmounts.push(() => app.unmount());
}

const PDF_BYTES = new Uint8Array([
    37,
    80,
    68,
    70,
]);

function latestCheckpointRefs() {
    return (stores.checkpoints.at(-1) as IWorkspaceCheckpoint | undefined)?.tabs.map(tab => tab.workingCopyRef) ?? [];
}

describe('browser workspace recovery', () => {
    it('stores one recovery copy for a dirty document shown in two views, named by both tabs', async () => {
        vi.useFakeTimers();
        mountLinkedDocumentRecovery(async () => PDF_BYTES);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(stores.documents).toHaveLength(1);
        const refs = latestCheckpointRefs();
        expect(refs).toHaveLength(2);
        expect(refs[0]).not.toBeNull();
        expect(refs[1]).toBe(refs[0]);

        // An edit through the other view refreshes the one copy both tabs name.
        window.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(1_000);

        expect(stores.documents).toHaveLength(2);
        const refreshed = latestCheckpointRefs();
        expect(refreshed[0]).not.toBe(refs[0]);
        expect(refreshed[1]).toBe(refreshed[0]);
    });

    it('leaves both views of a document out together until one recovery copy can be made', async () => {
        vi.useFakeTimers();
        let bytes: Uint8Array | null = null;
        mountLinkedDocumentRecovery(async () => bytes);

        await vi.advanceTimersByTimeAsync(1_000);

        // No copy could be made and none is retained: neither view is recorded
        // with a copy of its own, so restore cannot split the document.
        expect(stores.documents).toHaveLength(0);
        expect(stores.checkpoints).not.toHaveLength(0);
        expect(latestCheckpointRefs()).toEqual([]);

        bytes = PDF_BYTES;
        window.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(1_000);

        const refs = latestCheckpointRefs();
        expect(refs).toHaveLength(2);
        expect(refs[0]).not.toBeNull();
        expect(refs[1]).toBe(refs[0]);
    });
});

describe('desktop crash checkpoint written now', () => {
    // One pane with a reader's tab; `addBackgroundTab` places a document's tab
    // behind it, unopened, as a recovered scan output is placed.
    function mountCrashCheckpoint() {
        const reader = createWorkspaceDocumentController({tabId: 'tab-1'});
        const panes = ref<IEditorPaneState[]>([{
            paneId: requirePaneId('pane-1'),
            tabIds: [requireTabId('tab-1')],
            activeTabId: requireTabId('tab-1'),
        }]);
        const tabs = ref<Array<{id: string}>>([{id: 'tab-1'}]);
        const sessions = shallowRef<Record<string, ReturnType<typeof createWorkspaceDocumentController>>>({'tab-1': reader});
        const enabled = ref(true);
        let checkpoint: ReturnType<typeof useWorkspaceCrashCheckpoint> | null = null;
        const app = createApp(defineComponent({setup() {
            checkpoint = useWorkspaceCrashCheckpoint({
                enabled,
                panes,
                tabs: cast(tabs),
                layout: ref<TEditorLayoutNode | null>({
                    type: 'leaf',
                    paneId: requirePaneId('pane-1'),
                }),
                activePaneId: ref<string | null>('pane-1'),
                activeTabId: ref<string | null>('tab-1'),
                documentSessionsByTabId: sessions,
                getPaneByTabId: () => panes.value[0] ?? null,
            });
            return () => h('div');
        }}));
        app.mount(document.createElement('div'));
        unmounts.push(() => app.unmount());
        return {
            persistNow: () => checkpoint!.persistCheckpointNow(),
            reader,
            enabled,
            unmount: () => app.unmount(),
            addBackgroundTab(path: string) {
                const output = createWorkspaceDocumentController({tabId: 'tab-2'});
                output.commitDocument({
                    fileName: 'output.pdf',
                    originalPath: requireDocumentRef(path),
                    isDjvu: false,
                    revisionInfo: null,
                });
                tabs.value = [
                    ...tabs.value,
                    {id: 'tab-2'},
                ];
                panes.value = [{
                    ...panes.value[0]!,
                    tabIds: [
                        requireTabId('tab-1'),
                        requireTabId('tab-2'),
                    ],
                }];
                sessions.value = {
                    ...sessions.value,
                    'tab-2': output,
                };
            },
        };
    }

    function savedSources(checkpoint: unknown) {
        return (checkpoint as IWorkspaceCheckpoint).tabs.map(tab => tab.sourceRef);
    }

    afterEach(() => {
        desktop.saved.length = 0;
        desktop.save = async (checkpoint) => {
            desktop.saved.push(checkpoint);
        };
    });

    it('resolves only once a checkpoint holding a new background tab is saved, past a write already running', async () => {
        vi.useFakeTimers();
        const held = Promise.withResolvers<undefined>();
        desktop.save = async (checkpoint) => {
            desktop.saved.push(checkpoint);
            if (desktop.saved.length === 1) {
                await held.promise;
            }
        };
        const workspace = mountCrashCheckpoint();
        // An earlier write, without the tab, is still running.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(desktop.saved.map(savedSources)).toEqual([[null]]);

        workspace.addBackgroundTab('/managed/output — cleaned.pdf');
        const durable = {value: false};
        const persisted = workspace.persistNow().then(() => {
            durable.value = true;
        });
        await Promise.resolve();
        expect(durable.value).toBe(false);

        held.resolve(undefined);
        await persisted;
        expect(durable.value).toBe(true);
        expect(savedSources(desktop.saved.at(-1))).toEqual([
            null,
            '/managed/output — cleaned.pdf',
        ]);
    });

    it('retains the protection warning until the replacement checkpoint is durable and clears it with its owner', async () => {
        vi.useFakeTimers();
        const workspace = mountCrashCheckpoint();
        const workingCopyRef = requireDocumentRef('/managed/image.pdf');
        const originalPath = requireDocumentRef('/documents/image.pdf');
        workspace.reader.commitDocument({
            fileName: 'image.pdf',
            originalPath,
            isDjvu: false,
            revisionInfo: {
                version: 1,
                token: requireDocumentRevisionToken('image-revision'),
                documentRef: workingCopyRef,
                authority: 'electron-working-copy',
                contentRevision: 1,
                mintedAt: requireEpochMs(1),
            },
        });
        workspace.reader.setDirty(true);
        let rejectsCapture = true;
        workspace.reader.attachWorkspace('tab-1', createWorkspaceExposeFixture({
            getAutomationStateSnapshot: () => cast({
                originalPath,
                workingCopyPath: workingCopyRef,
            }),
            captureCanonicalAnnotationRecovery: () => {
                if (rejectsCapture) throw new Error('Recovery state exceeds the 4194304-byte annotation budget');
                return null;
            },
        }));
        await workspace.persistNow();
        await workspace.persistNow();
        expect(notices.value).toHaveLength(1);
        expect(notices.value[0]?.description).toContain('4194304-byte');
        expect(notices.value[0]?.description).toContain('image.pdf');
        expect((desktop.saved.at(-1) as IWorkspaceCheckpoint).tabs[0]?.annotationRecoveryFailure?.reason).toBe('capture-rejected');

        rejectsCapture = false;
        desktop.save = async () => {throw new Error('disk full');};
        await expect(workspace.persistNow()).rejects.toThrow('disk full');
        expect(notices.value).toHaveLength(1);
        expect(notices.value[0]?.description).toContain('4194304-byte');

        desktop.save = async (checkpoint) => {desktop.saved.push(checkpoint);};
        await workspace.persistNow();
        expect(notices.value).toEqual([]);
        rejectsCapture = true;
        await workspace.persistNow();
        expect(notices.value).toHaveLength(1);
        workspace.enabled.value = false;
        await nextTick();
        expect(notices.value).toEqual([]);
        workspace.enabled.value = true;
        await workspace.persistNow();
        expect(notices.value).toHaveLength(1);
        workspace.unmount();
        expect(notices.value).toEqual([]);
    });

    it('fails when the checkpoint holding the tab cannot be saved', async () => {
        vi.useFakeTimers();
        const workspace = mountCrashCheckpoint();
        await vi.advanceTimersByTimeAsync(2_000);
        desktop.save = async () => {
            throw new Error('disk full');
        };

        workspace.addBackgroundTab('/managed/output — cleaned.pdf');

        await expect(workspace.persistNow()).rejects.toThrow('disk full');
    });
});
