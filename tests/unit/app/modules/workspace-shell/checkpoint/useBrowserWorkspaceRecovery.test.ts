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
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import { requireEpochMs } from '@contracts/timestamps';
import { requireTabId } from '@contracts/windowTabs';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { cast } from '@tests/helpers/cast';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

// The browser stores are the boundary: what recovery stores is what a later
// session recovers from.
const stores = vi.hoisted(() => ({
    documents: [] as string[],
    readableDocuments: new Map<string, Uint8Array>(),
    checkpoints: [] as unknown[],
}));

vi.mock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: {
    createStoredDocument: vi.fn(async (fileName: string, bytes: Uint8Array) => {
        stores.documents.push(fileName);
        const ref = `/browser-recovery/${String(stores.documents.length)}-${fileName}`;
        stores.readableDocuments.set(ref, bytes.slice());
        return ref;
    }),
    read: vi.fn(async (ref: string) => {
        const bytes = stores.readableDocuments.get(ref);
        if (!bytes) throw new Error(`Browser document not found: ${ref}`);
        return bytes;
    }),
    cleanupDetachedDocument: vi.fn(async (ref: string) => stores.readableDocuments.delete(ref)),
}}));
vi.mock('@app/platform/browser/browserWorkspaceRecoveryStore', () => ({
    loadBrowserWorkspaceRecovery: vi.fn(async () => {
        const checkpoint = stores.checkpoints.at(-1) as IWorkspaceCheckpoint | undefined;
        return checkpoint ? {
            checkpoint,
            generation: stores.checkpoints.length,
            snapshotRefs: checkpoint.tabs.flatMap(tab => tab.isDirty && tab.workingCopyRef ? [tab.workingCopyRef] : []),
        } : null;
    }),
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
    stores.readableDocuments.clear();
    stores.checkpoints.length = 0;
    notices.value = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// Mounts recovery over one dirty PDF shown in two views (tab-1 and tab-2),
// whose mounted workspaces produce recovery bytes through `snapshotBytes`.
function mountLinkedDocumentRecovery(
    snapshotBytes: () => Promise<Uint8Array | null>,
    contentRevision = ref(0),
    workingCopyPath = requireDocumentRef('/browser-working/shared.pdf'),
) {
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
            getWorkspaceDocumentRecoveryChangeSignature: () => [contentRevision.value],
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
    return session;
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
        const contentRevision = ref(0);
        mountLinkedDocumentRecovery(async () => PDF_BYTES, contentRevision);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(stores.documents).toHaveLength(1);
        const refs = latestCheckpointRefs();
        expect(refs).toHaveLength(2);
        expect(refs[0]).not.toBeNull();
        expect(refs[1]).toBe(refs[0]);

        // An edit through the other view refreshes the one copy both tabs name.
        contentRevision.value += 1;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(stores.documents).toHaveLength(2);
        const refreshed = latestCheckpointRefs();
        expect(refreshed[0]).not.toBe(refs[0]);
        expect(refreshed[1]).toBe(refreshed[0]);
    });

    it('keeps adopted recovery bytes readable when replacement and clean checkpoints are published', async () => {
        vi.useFakeTimers();
        mountLinkedDocumentRecovery(async () => PDF_BYTES);
        await vi.advanceTimersByTimeAsync(1_000);
        const adoptedRef = requireDocumentRef(latestCheckpointRefs()[0]);
        unmounts.pop()!();
        const session = mountLinkedDocumentRecovery(async () => PDF_BYTES, ref(0), adoptedRef);
        await vi.advanceTimersByTimeAsync(1_000);
        const replacementRef = requireDocumentRef(latestCheckpointRefs()[0]);
        const {browserDocumentStore} = await import('@app/platform/browserDocumentStore');
        expect(replacementRef).not.toBe(adoptedRef);
        await expect(browserDocumentStore.read(adoptedRef)).resolves.toEqual(PDF_BYTES);
        await expect(browserDocumentStore.read(replacementRef)).resolves.toEqual(PDF_BYTES);

        session.setDirty(false);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(browserDocumentStore.read(adoptedRef)).resolves.toEqual(PDF_BYTES);
        await expect(browserDocumentStore.read(replacementRef)).rejects.toThrow('Browser document not found');
    });

    it('updates linked reading views while retaining unchanged dirty recovery bytes', async () => {
        vi.useFakeTimers();
        const session = mountLinkedDocumentRecovery(async () => PDF_BYTES);
        const first = session.getView('tab-1')!;
        const second = session.getView('tab-2')!;
        first.publishToolbarSnapshot({
            ...first.toolbarSnapshot.value,
            hasPdf: true,
            currentPage: 1,
            zoom: 1,
        });
        second.publishToolbarSnapshot({
            ...second.toolbarSnapshot.value,
            hasPdf: true,
            currentPage: 1,
            zoom: 1,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        const refs = latestCheckpointRefs();

        for (const eventName of [
            'change',
            'input',
            'keyup',
            'pointerup',
        ]) {
            window.dispatchEvent(new Event(eventName));
        }
        first.publishToolbarSnapshot({
            ...first.toolbarSnapshot.value,
            currentPage: 3,
            zoom: 1.25,
        });
        second.publishToolbarSnapshot({
            ...second.toolbarSnapshot.value,
            currentPage: 2,
            zoom: 1.5,
        });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(stores.documents).toHaveLength(1);
        expect(latestCheckpointRefs()).toEqual(refs);
        const checkpoint = stores.checkpoints.at(-1) as IWorkspaceCheckpoint;
        expect(checkpoint.tabs.map(tab => [
            tab.currentPage,
            tab.zoom,
        ])).toEqual([
            [
                3,
                1.25,
            ],
            [
                2,
                1.5,
            ],
        ]);
    });

    it.each([
        'unavailable',
        'rejected',
    ] as const)('does not report saved work as unprotected when Save finishes during %s recovery capture', async (outcome) => {
        vi.useFakeTimers();
        const heldSnapshot = Promise.withResolvers<Uint8Array | null>();
        let snapshot = heldSnapshot.promise;
        const session = mountLinkedDocumentRecovery(() => snapshot);
        const diagnostics: string[] = [];
        const warning = vi.spyOn(BrowserLogger, 'warn').mockImplementation((section, message) => {
            diagnostics.push(`[${section}] ${message}`);
        });
        try {
            await vi.advanceTimersByTimeAsync(1_000);
            session.setDirty(false);
            await nextTick();
            if (outcome === 'rejected') heldSnapshot.reject(createStaleRevisionError({}));
            else heldSnapshot.resolve(null);
            await vi.advanceTimersByTimeAsync(1_000);

            expect(diagnostics).toEqual([]);
            expect(latestCheckpointRefs()).toEqual([]);

            // A subsequent accepted edit still protects the document's two views.
            snapshot = Promise.resolve(PDF_BYTES);
            session.setDirty(true);
            await vi.advanceTimersByTimeAsync(1_000);
            const refs = latestCheckpointRefs();
            expect(refs).toHaveLength(2);
            expect(refs[0]).not.toBeNull();
            expect(refs[1]).toBe(refs[0]);
        } finally {
            warning.mockRestore();
        }
    });

    it('keeps retained bytes bound to their document when a newer capture is unavailable', async () => {
        vi.useFakeTimers();
        let bytes: Uint8Array | null = PDF_BYTES;
        const session = mountLinkedDocumentRecovery(async () => bytes);
        await vi.advanceTimersByTimeAsync(1_000);
        const refs = latestCheckpointRefs();
        bytes = null;
        session.commitDocument({
            fileName: 'replacement.pdf',
            originalPath: requireDocumentRef('/documents/replacement.pdf'),
            isDjvu: false,
            revisionInfo: {
                version: 1,
                token: requireDocumentRevisionToken('revision-2'),
                documentRef: requireDocumentRef('/browser-working/replacement.pdf'),
                authority: 'browser-document-store',
                contentRevision: 1,
                mintedAt: requireEpochMs(2),
            },
        });
        session.setDirty(true);
        const view = session.getView('tab-1')!;
        view.publishToolbarSnapshot({
            ...view.toolbarSnapshot.value,
            hasPdf: true,
            currentPage: 3,
        });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(latestCheckpointRefs()).toEqual(refs);
        const checkpoint = stores.checkpoints.at(-1) as IWorkspaceCheckpoint;
        expect(checkpoint.tabs[0]?.sourceRef).toBe('/documents/shared.pdf');
        expect(checkpoint.tabs[0]?.fileName).toBe('shared.pdf');
        expect(checkpoint.tabs[0]?.currentPage).toBe(3);
    });

    it('reports a current capture rejection while retaining readable recovery bytes', async () => {
        vi.useFakeTimers();
        const contentRevision = ref(0);
        const error = createStaleRevisionError({});
        let rejectCapture = false;
        mountLinkedDocumentRecovery(async () => {
            if (rejectCapture) throw error;
            return PDF_BYTES;
        }, contentRevision);
        await vi.advanceTimersByTimeAsync(1_000);
        const refs = latestCheckpointRefs();
        const diagnostics: string[] = [];
        const warning = vi.spyOn(BrowserLogger, 'warn').mockImplementation((section, message, cause) => {
            diagnostics.push(`[${section}] ${message}: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
        try {
            rejectCapture = true;
            contentRevision.value += 1;
            await vi.advanceTimersByTimeAsync(1_000);
            expect(diagnostics.some(message => message.includes('Failed to refresh recovery snapshot') && message.includes(error.message))).toBe(true);
            expect(latestCheckpointRefs()).toEqual(refs);
            const {browserDocumentStore} = await import('@app/platform/browserDocumentStore');
            await expect(browserDocumentStore.read(requireDocumentRef(refs[0]))).resolves.toEqual(PDF_BYTES);
        } finally {
            warning.mockRestore();
        }
    });

    it('leaves both views of a document out together until one recovery copy can be made', async () => {
        vi.useFakeTimers();
        let bytes: Uint8Array | null = null;
        const contentRevision = ref(0);
        mountLinkedDocumentRecovery(async () => bytes, contentRevision);

        await vi.advanceTimersByTimeAsync(1_000);

        // No copy could be made and none is retained: neither view is recorded
        // with a copy of its own, so restore cannot split the document.
        expect(stores.documents).toHaveLength(0);
        expect(stores.checkpoints).not.toHaveLength(0);
        expect(latestCheckpointRefs()).toEqual([]);

        bytes = PDF_BYTES;
        contentRevision.value += 1;
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
