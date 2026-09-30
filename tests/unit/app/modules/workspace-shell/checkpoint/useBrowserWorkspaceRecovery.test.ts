// @vitest-environment happy-dom

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
vi.mock('@app/platform/browser/browserDocumentLeaseStore', () => ({
    createBrowserDocumentLiveLease: vi.fn(async () => ({generation: 1})),
    saveBrowserDocumentLiveLease: vi.fn(async () => ({generation: 1})),
    releaseBrowserDocumentLiveLease: vi.fn(async () => {}),
}));

const { useBrowserWorkspaceRecovery } = await import(
    '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery'
);

const unmounts: Array<() => void> = [];

afterEach(() => {
    unmounts.splice(0).forEach(unmount => unmount());
    stores.documents.length = 0;
    stores.checkpoints.length = 0;
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
