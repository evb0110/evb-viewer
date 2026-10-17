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
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { captureCanonicalAnnotationRecovery } from '@app/modules/pdf-viewer/annotations/domain/annotationRecovery';
import { createdTextBox } from '@tests/unit/app/modules/pdf-viewer/components/pdfAnnotationEditorLayerEventFixtures';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

// Capability output is the durable document and checkpoint a later session reads.
const stores = vi.hoisted(() => ({
    documents: [] as string[],
    readableDocuments: new Map<string, Uint8Array>(),
    checkpoints: [] as unknown[],
}));

const browserLifecycle = vi.hoisted(() => ({rekey: vi.fn()}));

const recovery = {
    getOwnerId: () => 'owner-1',
    load: async (_ownerId: string) => {
        const checkpoint = stores.checkpoints.at(-1) as IWorkspaceCheckpoint | undefined;
        return checkpoint ? {
            checkpoint,
            generation: stores.checkpoints.length,
            snapshotRefs: checkpoint.tabs.flatMap(tab => tab.isDirty && tab.workingCopyRef ? [tab.workingCopyRef] : []),
        } : null;
    },
    save: async (_ownerId: string, generation: number, checkpoint: unknown) => {
        stores.checkpoints.push(checkpoint);
        return {
            saved: true,
            generation: generation + 1,
        };
    },
    clear: async (_ownerId: string, generation: number) => ({
        saved: true,
        generation,
    }),
    touch: async (_ownerId: string, generation: number) => ({
        saved: true,
        generation,
    }),
};
vi.mock('@app/platform/browserWindowTabs', () => ({
    registerBrowserDocumentDependencyReader: () => () => {},
    publishBrowserDocumentLiveLeases: async () => null,
    rekeyCurrentWindow: browserLifecycle.rekey,
}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentWorkingCopyCapability: () => ({recovery: {
    async createSnapshot(fileName: string, bytes: Uint8Array) {
        stores.documents.push(fileName);
        const ref = requireDocumentRef(`/browser-recovery/${String(stores.documents.length)}-${fileName}`);
        stores.readableDocuments.set(ref, bytes.slice());
        return {
            ref,
            revisionToken: requireDocumentRevisionToken('recovery-revision'),
        };
    },
    cleanupSnapshot: async (ref: string) => { stores.readableDocuments.delete(ref); },
}})}));

// The desktop crash checkpoint's boundary: the checkpoints main saved.
const desktop = vi.hoisted(() => ({
    saved: [] as unknown[],
    save: async (checkpoint: unknown) => {
        desktop.saved.push(checkpoint);
        return true;
    },
}));
vi.mock('@app/utils/platformWindowTabs', () => ({getWindowTabsCapability: () => ({
    browserRecovery: recovery,
    saveWorkspaceCheckpoint: (checkpoint: unknown) => desktop.save(checkpoint),
})}));
vi.mock('@app/utils/platform', async importOriginal => ({
    ...await importOriginal<object>(),
    waitForDesktopPlatformBridge: async () => undefined,
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
    vi.restoreAllMocks();
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
    it('keeps new notes recoverable after a prior heartbeat returns behind Save clearing', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
        const publication = Promise.withResolvers<undefined>();
        let durableGeneration = 0;
        vi.spyOn(recovery, 'load').mockImplementation(async () => {
            const checkpoint = stores.checkpoints.at(-1) as IWorkspaceCheckpoint | undefined;
            return checkpoint ? {
                checkpoint,
                generation: durableGeneration,
                snapshotRefs: [],
            } : null;
        });
        vi.spyOn(recovery, 'save').mockImplementation(async (_owner, expected, checkpoint) => {
            if (expected !== durableGeneration) return {
                saved: false,
                generation: durableGeneration,
            };
            stores.checkpoints.push(checkpoint);
            return {
                saved: true,
                generation: ++durableGeneration,
            };
        });
        vi.spyOn(recovery, 'clear').mockImplementation(async () => {
            stores.checkpoints.length = 0;
            durableGeneration = 0;
            return {
                saved: true,
                generation: 0,
            };
        });
        vi.spyOn(recovery, 'touch').mockImplementation(async (_owner, expected) => {
            const result = {
                saved: expected === durableGeneration && expected > 0,
                generation: durableGeneration,
            };
            return result;
        }).mockImplementationOnce(async (_owner, expected) => {
            const result = {
                saved: expected === durableGeneration && expected > 0,
                generation: durableGeneration,
            };
            await publication.promise;
            return result;
        });
        const revision = ref(0);
        const editedBytes = Uint8Array.from([
            ...PDF_BYTES,
            42,
        ]);
        const session = mountLinkedDocumentRecovery(async () => revision.value ? editedBytes : PDF_BYTES, revision);
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(10_000);
        session.setDirty(false);
        await vi.advanceTimersByTimeAsync(1_000);
        publication.resolve(undefined);
        await vi.advanceTimersByTimeAsync(10_000);
        session.setDirty(true);
        revision.value += 1;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(stores.checkpoints).toHaveLength(1);
        expect(stores.readableDocuments.get(requireDocumentRef(latestCheckpointRefs()[0]))).toEqual(editedBytes);
        expect(warn).not.toHaveBeenCalled();
    });

    it('keeps the successor checkpoint and saves a resumed owner’s later edits under its new identity', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
        let owner = 'owner-1';
        vi.spyOn(recovery, 'getOwnerId').mockImplementation(() => owner);
        browserLifecycle.rekey.mockImplementation(() => {owner = 'owner-2';});
        const records = new Map<string, {
            generation: number;
            checkpoint: IWorkspaceCheckpoint;
            snapshotRefs: Array<ReturnType<typeof requireDocumentRef>>
        } >();
        vi.spyOn(recovery, 'load').mockImplementation(async id => records.get(id) ?? null);
        vi.spyOn(recovery, 'save').mockImplementation(async (id, expected, value) => {
            const checkpoint = cast<IWorkspaceCheckpoint>(value);
            stores.checkpoints.push(checkpoint);
            records.set(id, {
                generation: expected + 1,
                checkpoint,
                snapshotRefs: checkpoint.tabs.flatMap(tab => tab.workingCopyRef ? [tab.workingCopyRef] : []),
            });
            return {
                saved: true,
                generation: expected + 1,
            };
        });
        vi.spyOn(recovery, 'touch').mockResolvedValueOnce({
            saved: false,
            generation: 2,
        });
        const revision = ref(0);
        const edited = Uint8Array.from([
            ...PDF_BYTES,
            7,
        ]);
        mountLinkedDocumentRecovery(async () => revision.value ? edited : PDF_BYTES, revision);
        await vi.advanceTimersByTimeAsync(11_000);
        revision.value += 1;
        await vi.advanceTimersByTimeAsync(1_000);
        const previous = records.get('owner-1')!;
        const resumed = records.get('owner-2')!;
        expect(stores.readableDocuments.get(previous.snapshotRefs[0]!)).toEqual(PDF_BYTES);
        expect(stores.readableDocuments.get(resumed.snapshotRefs[0]!)).toEqual(edited);
        expect(warn).not.toHaveBeenCalled();
    });

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
        expect(replacementRef).not.toBe(adoptedRef);
        expect(stores.readableDocuments.get(adoptedRef)).toEqual(PDF_BYTES);
        expect(stores.readableDocuments.get(replacementRef)).toEqual(PDF_BYTES);

        session.setDirty(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(stores.readableDocuments.get(adoptedRef)).toEqual(PDF_BYTES);
        expect(stores.readableDocuments.has(replacementRef)).toBe(false);
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
            expect(stores.readableDocuments.get(requireDocumentRef(refs[0]))).toEqual(PDF_BYTES);
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
        const isStartupOpenClaimPending = ref(false);
        let checkpoint: ReturnType<typeof useWorkspaceCrashCheckpoint> | null = null;
        const app = createApp(defineComponent({setup() {
            checkpoint = useWorkspaceCrashCheckpoint({
                enabled,
                isStartupOpenClaimPending,
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
            protectSave: (path = requireDocumentRef('/managed/accepted.pdf')) => checkpoint!.persistCheckpointNow(true, path),
            reader,
            enabled,
            isStartupOpenClaimPending,
            unmount: () => app.unmount(),
            attachDirtyReader(capture: NonNullable<ReturnType<typeof createWorkspaceExposeFixture>['captureCanonicalAnnotationRecovery']>) {
                const originalPath = requireDocumentRef('/documents/accepted.pdf');
                const workingCopyPath = requireDocumentRef('/managed/accepted.pdf');
                reader.assign({
                    fileName: 'accepted.pdf',
                    originalPath,
                    isDirty: true,
                    isDjvu: false,
                });
                reader.commitDocument({
                    fileName: 'accepted.pdf',
                    originalPath,
                    isDjvu: false,
                    revisionInfo: {
                        version: 1,
                        token: requireDocumentRevisionToken('accepted-revision'),
                        documentRef: workingCopyPath,
                        authority: 'electron-working-copy',
                        contentRevision: 1,
                        mintedAt: requireEpochMs(1),
                    },
                });
                reader.setDirty(true);
                const mounted = createWorkspaceExposeFixture({
                    getAutomationStateSnapshot: () => cast({
                        originalPath,
                        workingCopyPath,
                    }),
                    captureCanonicalAnnotationRecovery: capture,
                });
                reader.bindMutationFrontier(() => JSON.stringify(mounted.captureCanonicalAnnotationRecovery?.()) ?? '', async () => {}, async () => {});
                reader.attachWorkspace('tab-1', mounted);
                return mounted;
            },
            showLinkedReader(mounted: ReturnType<typeof createWorkspaceExposeFixture>) {
                reader.addView('tab-2');
                reader.attachWorkspace('tab-2', mounted);
                reader.detachWorkspace('tab-1', mounted);
                tabs.value.push({id: 'tab-2'});
                panes.value[0]!.tabIds.push(requireTabId('tab-2'));
                sessions.value = {
                    ...sessions.value,
                    'tab-2': reader,
                };
            },
            closeFirstReaderView() {
                reader.removeView('tab-1');
                tabs.value = tabs.value.filter(tab => tab.id !== 'tab-1');
                panes.value[0]!.tabIds = [requireTabId('tab-2')];
                sessions.value = {'tab-2': reader};
            },
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
                return output;
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
            return true;
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
            return true;
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

    it('resolves a queued checkpoint once it is saved, after the write before it failed', async () => {
        vi.useFakeTimers();
        const held = Promise.withResolvers<undefined>();
        desktop.save = async (checkpoint) => {
            desktop.saved.push(checkpoint);
            if (desktop.saved.length === 1) {
                await held.promise;
                throw new Error('disk full');
            }
            return true;
        };
        const workspace = mountCrashCheckpoint();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(desktop.saved.map(savedSources)).toEqual([[null]]);

        workspace.addBackgroundTab('/managed/output — cleaned.pdf');
        const persisted = workspace.persistNow();
        await nextTick();
        await nextTick();
        held.resolve(undefined);

        await expect(persisted).resolves.toBeUndefined();
        expect(desktop.saved.map(savedSources)).toEqual([
            [null],
            [
                null,
                '/managed/output — cleaned.pdf',
            ],
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

        desktop.save = async (checkpoint) => {desktop.saved.push(checkpoint); return true;};
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

    it('rejects its target capture while keeping permissive background capture scheduled', async () => {
        vi.useFakeTimers();
        const workspace = mountCrashCheckpoint();
        workspace.attachDirtyReader(() => {throw new Error('accepted text capture rejected');});
        await expect(workspace.protectSave()).rejects.toThrow('accepted text capture rejected');
        expect(workspace.reader.snapshot.value.dirty).toBe(true);
        await vi.advanceTimersByTimeAsync(2_000);
        expect((desktop.saved.at(-1) as IWorkspaceCheckpoint).tabs[0]?.annotationRecoveryFailure?.message)
            .toBe('accepted text capture rejected');
    });

    it.each([
        'missing',
        'disabled',
        'disposed',
    ] as const)('does not acknowledge %s protection for a dirty Save', async reason => {
        vi.useFakeTimers();
        const workspace = mountCrashCheckpoint();
        workspace.attachDirtyReader(() => reason === 'missing' ? null : {
            version: 1,
            annotationMutationGeneration: 2,
            entities: [],
            foreign: [],
            drafts: [],
        });
        if (reason === 'disabled') workspace.enabled.value = false;
        if (reason === 'disposed') workspace.unmount();
        await expect(workspace.protectSave()).rejects.toThrow();
        expect(workspace.reader.snapshot.value.dirty).toBe(true);
        expect(desktop.saved).toEqual([]);
    });

    it('protects an admitted Save during startup while keeping automatic capture blocked', async () => {
        vi.useFakeTimers();
        const workspace = mountCrashCheckpoint();
        workspace.isStartupOpenClaimPending.value = true;
        const annotations = new AnnotationApplication('startup-target');
        annotations.store.createTextBox({
            ...createdTextBox,
            text: 'Accepted while another tab restores',
        });
        workspace.attachDirtyReader(() => captureCanonicalAnnotationRecovery(annotations.store));

        await nextTick();
        await workspace.persistNow();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(desktop.saved).toEqual([]);
        await workspace.protectSave();
        expect((desktop.saved.at(-1) as IWorkspaceCheckpoint).tabs[0]?.annotationRecovery?.payload)
            .toEqual(expect.objectContaining({entities: annotations.store.list({includeDeleted: true})}));
        expect(workspace.reader.snapshot.value.dirty).toBe(true);
        workspace.enabled.value = false;
        await expect(workspace.protectSave()).rejects.toMatchObject({name: 'AbortError'});
        expect(desktop.saved).toHaveLength(1);
    });

    it('cannot acknowledge a required capture replaced by a later permissive failed capture', async () => {
        vi.useFakeTimers();
        const held = Promise.withResolvers<undefined>();
        desktop.save = async checkpoint => {
            desktop.saved.push(checkpoint);
            if (desktop.saved.length === 1) await held.promise;
            return true;
        };
        const workspace = mountCrashCheckpoint();
        await vi.advanceTimersByTimeAsync(2_000);
        let rejectCapture = false;
        workspace.attachDirtyReader(() => {
            if (rejectCapture) throw new Error('later capture rejected');
            return {
                version: 1,
                annotationMutationGeneration: 2,
                entities: [],
                foreign: [],
                drafts: [],
            };
        });
        const required = workspace.protectSave();
        const rejected = expect(required).rejects.toThrow('later capture rejected');
        rejectCapture = true;
        const permissive = workspace.persistNow();
        held.resolve(undefined);
        await Promise.all([
            rejected,
            permissive,
        ]);
        expect(workspace.reader.snapshot.value.dirty).toBe(true);
        expect((desktop.saved.at(-1) as IWorkspaceCheckpoint).tabs[0]?.annotationRecoveryFailure?.message)
            .toBe('later capture rejected');
    });

    it('acknowledges the target captured just after a preceding write completes', async () => {
        vi.useFakeTimers();
        const workspace = mountCrashCheckpoint();
        const protectedSave = Promise.withResolvers<undefined>();
        desktop.save = checkpoint => {
            desktop.saved.push(checkpoint);
            const written = Promise.resolve(true);
            if (desktop.saved.length === 1) {
                void written.then(() => queueMicrotask(() => {
                    workspace.attachDirtyReader(() => ({
                        version: 1,
                        annotationMutationGeneration: 2,
                        entities: [],
                        foreign: [],
                        drafts: [],
                    }));
                    void workspace.protectSave().then(() => protectedSave.resolve(undefined), protectedSave.reject);
                }));
            }
            return written;
        };
        await workspace.persistNow();
        await protectedSave.promise;
        expect((desktop.saved.at(-1) as IWorkspaceCheckpoint).tabs[0]?.annotationRecovery?.workingCopyRef)
            .toBe('/managed/accepted.pdf');
        expect(workspace.reader.snapshot.value.dirty).toBe(true);
    });

    it('rejects protection whose document lifetime ends during the individual write', async () => {
        vi.useFakeTimers();
        const held = Promise.withResolvers<undefined>();
        desktop.save = async checkpoint => {desktop.saved.push(checkpoint); await held.promise; return true;};
        const workspace = mountCrashCheckpoint();
        workspace.attachDirtyReader(() => ({
            version: 1,
            annotationMutationGeneration: 2,
            entities: [],
            foreign: [],
            drafts: [],
        }));
        const required = workspace.protectSave();
        const rejected = expect(required).rejects.toThrow();
        workspace.enabled.value = false;
        held.resolve(undefined);
        await rejected;
        expect(workspace.reader.snapshot.value.dirty).toBe(true);
    });

    it.each([
        'hidden',
        'closed',
    ] as const)('protects a linked document when the artifact’s first view is %s', async firstView => {
        vi.useFakeTimers();
        const held = Promise.withResolvers<undefined>();
        const admitted = Promise.withResolvers<undefined>();
        desktop.save = async checkpoint => {desktop.saved.push(checkpoint); admitted.resolve(undefined); await held.promise; return true;};
        const workspace = mountCrashCheckpoint();
        const mounted = workspace.attachDirtyReader(() => ({
            version: 1,
            annotationMutationGeneration: 2,
            entities: [],
            foreign: [],
            drafts: [],
        }));
        workspace.showLinkedReader(mounted);
        const protectedSave = workspace.protectSave();
        await admitted.promise;
        if (firstView === 'closed') workspace.closeFirstReaderView();
        held.resolve(undefined);
        await protectedSave;
        const saved = desktop.saved.at(-1) as IWorkspaceCheckpoint;
        expect(saved.tabs.map(tab => tab.workingCopyRef)).toEqual([
            '/managed/accepted.pdf',
            '/managed/accepted.pdf',
        ]);
        expect(saved.tabs[0]?.annotationRecovery?.annotationMutationGeneration).toBe(2);
        expect(saved.tabs[1]?.annotationRecovery).toBeUndefined();
    });

    it('requires a real committed write for its current target and leaves background cancellation benign', async () => {
        vi.useFakeTimers();
        const workspace = mountCrashCheckpoint();
        workspace.attachDirtyReader(() => ({
            version: 1,
            annotationMutationGeneration: 2,
            entities: [],
            foreign: [],
            drafts: [],
        }));
        desktop.save = async () => false;
        await expect(workspace.persistNow()).resolves.toBeUndefined();
        await expect(workspace.protectSave()).rejects.toMatchObject({name: 'AbortError'});
        expect(workspace.reader.snapshot.value.dirty).toBe(true);
        expect(notices.value).toEqual([]);
    });

    it('writes a clean current target after Save and refuses a same-instance newer frontier', async () => {
        vi.useFakeTimers();
        const workspace = mountCrashCheckpoint();
        const annotations = new AnnotationApplication('current-checkpoint-target');
        const annotation = annotations.store.createTextBox({
            ...createdTextBox,
            text: 'accepted text',
        });
        workspace.attachDirtyReader(() => captureCanonicalAnnotationRecovery(annotations.store));
        workspace.reader.setDirty(false);
        await workspace.protectSave();
        expect((desktop.saved.at(-1) as IWorkspaceCheckpoint).tabs[0]?.isDirty).toBe(false);
        workspace.reader.setDirty(true);
        const held = Promise.withResolvers<undefined>();
        const admitted = Promise.withResolvers<undefined>();
        desktop.save = async checkpoint => {desktop.saved.push(checkpoint); admitted.resolve(undefined); await held.promise; return true;};
        const protection = workspace.protectSave();
        const refusal = expect(protection).rejects.toMatchObject({name: 'AbortError'});
        await admitted.promise;
        annotations.store.updateTextBox(annotation.identity.id, {text: 'newer retained edit'});
        held.resolve(undefined);
        await refusal;
        expect(workspace.reader.snapshot.value.dirty).toBe(true);
        expect(annotations.listReadModels()[0]?.text).toBe('newer retained edit');
        expect(notices.value).toEqual([]);
    });

    it('keeps the old checkpoint through a global capture failure until a current explicit write succeeds', async () => {
        vi.useFakeTimers();
        const workspace = mountCrashCheckpoint();
        const mounted = workspace.attachDirtyReader(() => ({
            version: 1,
            annotationMutationGeneration: 2,
            entities: [],
            foreign: [],
            drafts: [],
        }));
        await workspace.persistNow();
        const durable = desktop.saved.at(-1);
        const capture = vi.spyOn(mounted, 'getAutomationStateSnapshot').mockImplementation(() => {throw new Error('global document snapshot capture failed');});
        workspace.addBackgroundTab('/documents/new-background.pdf');
        await vi.advanceTimersByTimeAsync(600);
        expect(desktop.saved.at(-1)).toBe(durable);
        expect(workspace.reader.snapshot.value.dirty).toBe(true);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(desktop.saved.at(-1)).toBe(durable);
        capture.mockRestore();
        await workspace.persistNow();
        expect((desktop.saved.at(-1) as IWorkspaceCheckpoint).tabs.map(tab => tab.sourceRef)).toEqual([
            '/documents/accepted.pdf',
            '/documents/new-background.pdf',
        ]);
    });

    it('protects its target while an unrelated dirty document rejects capture', async () => {
        vi.useFakeTimers();
        const workspace = mountCrashCheckpoint();
        workspace.attachDirtyReader(() => ({
            version: 1,
            annotationMutationGeneration: 2,
            entities: [],
            foreign: [],
            drafts: [],
        }));
        const unrelated = workspace.addBackgroundTab('/documents/other.pdf');
        unrelated.setDirty(true);
        unrelated.attachWorkspace('tab-2', createWorkspaceExposeFixture({captureCanonicalAnnotationRecovery: () => {throw new Error('unrelated rejected capture');}}));
        await workspace.protectSave();
        const saved = desktop.saved.at(-1) as IWorkspaceCheckpoint;
        expect(saved.tabs[0]?.annotationRecovery?.annotationMutationGeneration).toBe(2);
        expect(saved.tabs[1]?.annotationRecoveryFailure?.message).toBe('unrelated rejected capture');
        expect(workspace.reader.snapshot.value.dirty).toBe(true);
        expect(unrelated.snapshot.value.dirty).toBe(true);
    });
});
