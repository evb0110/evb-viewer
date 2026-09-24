import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
    TPaneId,
} from '@contracts/editorPanes';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { requireDocumentInstanceId } from '@contracts/documentInstanceId';
import {
    requireDocumentRevisionToken,
    type IDocumentRevisionInfo,
} from '@contracts/documentRevision';
import { requirePaneId } from '@contracts/editorPanes';
import { requireEpochMs } from '@contracts/timestamps';
import type { TTabId } from '@contracts/windowTabs';
import { requireTabId } from '@contracts/windowTabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { buildWorkspaceCheckpointChangeSignature } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpointChangeSignature';
import {
    buildWorkspaceCheckpoint,
    WorkspaceCheckpointCaptureError,
} from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';

function createSession(tabId: string) {
    return createWorkspaceDocumentController({
        tabId,
        assignment: {
            fileName: `${tabId}.pdf`,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        },
    });
}

function toolbar(overrides: Partial<ReturnType<typeof createDefaultWorkspaceToolbarSnapshot>>) {
    return {
        ...createDefaultWorkspaceToolbarSnapshot(),
        ...overrides,
    };
}

function createIdentity(token: string, contentRevision: number): IDocumentRevisionInfo {
    return {
        version: 1,
        token: requireDocumentRevisionToken(token),
        documentRef: requireDocumentRef('/doc.pdf'),
        authority: 'electron-working-copy',
        contentRevision,
        mintedAt: requireEpochMs(0),
    };
}

function createSignatureOptions() {
    const pane: IEditorPaneState = {
        paneId: requirePaneId('pane-1'),
        tabIds: [
            requireTabId('tab-a'),
            requireTabId('tab-b'),
        ],
        activeTabId: requireTabId('tab-a'),
    };
    return {
        panes: ref([pane]),
        tabs: ref([
            {id: 'tab-a'},
            {id: 'tab-b'},
        ]),
        layout: ref<TEditorLayoutNode | null>(null),
        activePaneId: ref<TPaneId | null>(requirePaneId('pane-1')),
        activeTabId: ref<TTabId | null>(requireTabId('tab-a')),
        documentSessionsByTabId: shallowRef({
            'tab-a': createSession('tab-a'),
            'tab-b': createSession('tab-b'),
        }),
        getPaneByTabId: (): IEditorPaneState | null => pane,
    };
}

describe('buildWorkspaceCheckpointChangeSignature', () => {
    it('is stable across rebuilds of identical state', () => {
        const options = createSignatureOptions();
        const first = buildWorkspaceCheckpointChangeSignature(options);
        const second = buildWorkspaceCheckpointChangeSignature(options);
        expect(second.workspace).toBe(first.workspace);
        expect([...second.tabSignatures.entries()]).toEqual([...first.tabSignatures.entries()]);
    });

    it('changes only the affected tab signature when a document record changes', () => {
        const options = createSignatureOptions();
        const before = buildWorkspaceCheckpointChangeSignature(options);
        options.documentSessionsByTabId.value['tab-b'].publishToolbarSnapshot(toolbar({
            hasPdf: true,
            currentPage: 7,
            totalPages: 30,
        }));
        const after = buildWorkspaceCheckpointChangeSignature(options);
        expect(after.tabSignatures.get('tab-a')).toBe(before.tabSignatures.get('tab-a'));
        expect(after.tabSignatures.get('tab-b')).not.toBe(before.tabSignatures.get('tab-b'));
        expect(after.workspace).not.toBe(before.workspace);
    });

    it('tracks toolbar view state the checkpoint persists', () => {
        const options = createSignatureOptions();
        const session = options.documentSessionsByTabId.value['tab-a'];
        session.publishToolbarSnapshot(toolbar({
            hasPdf: true,
            currentPage: 7,
            totalPages: 30,
        }));
        const before = buildWorkspaceCheckpointChangeSignature(options);
        session.publishToolbarSnapshot(toolbar({
            hasPdf: true,
            currentPage: 8,
            totalPages: 30,
        }));
        const after = buildWorkspaceCheckpointChangeSignature(options);
        expect(after.tabSignatures.get('tab-a')).not.toBe(before.tabSignatures.get('tab-a'));
    });

    it('tracks tab dirtiness, mount state, and pane membership', () => {
        const options = createSignatureOptions();
        const base = buildWorkspaceCheckpointChangeSignature(options);

        const session = options.documentSessionsByTabId.value['tab-a'];
        session.setDirty(true);
        const afterDirty = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterDirty.tabSignatures.get('tab-a')).not.toBe(base.tabSignatures.get('tab-a'));
        expect(afterDirty.tabSignatures.get('tab-b')).toBe(base.tabSignatures.get('tab-b'));

        session.setDirty(false);
        const workspace = {} as IWorkspaceExpose;
        session.attachWorkspace(workspace);
        const afterMount = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterMount.tabSignatures.get('tab-a')).not.toBe(base.tabSignatures.get('tab-a'));

        session.detachWorkspace(workspace);
        const detachedOptions = {
            ...options,
            getPaneByTabId: (): IEditorPaneState | null => null,
        };
        const afterPaneChange = buildWorkspaceCheckpointChangeSignature(detachedOptions);
        expect(afterPaneChange.tabSignatures.get('tab-a')).not.toBe(base.tabSignatures.get('tab-a'));
    });

    it('tracks the document revision identity', () => {
        const options = createSignatureOptions();
        const session = options.documentSessionsByTabId.value['tab-a'];
        const commit = (revisionInfo: IDocumentRevisionInfo) => session.commitDocument({
            fileName: 'tab-a.pdf',
            originalPath: null,
            isDjvu: false,
            revisionInfo,
        });
        commit(createIdentity('token-1', 1));
        const before = buildWorkspaceCheckpointChangeSignature(options);
        commit(createIdentity('token-1', 2));
        const after = buildWorkspaceCheckpointChangeSignature(options);
        expect(after.tabSignatures.get('tab-a')).not.toBe(before.tabSignatures.get('tab-a'));

        commit(createIdentity('token-2', 2));
        const afterTokenChange = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterTokenChange.tabSignatures.get('tab-a')).not.toBe(after.tabSignatures.get('tab-a'));

        session.assign({
            fileName: 'tab-a.pdf',
            originalPath: null,
            documentInstanceId: requireDocumentInstanceId('document-1'),
            isDirty: false,
            isDjvu: false,
        });
        const afterDocumentInstanceChange = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterDocumentInstanceChange.tabSignatures.get('tab-a')).not.toBe(afterTokenChange.tabSignatures.get('tab-a'));
    });

    it('tracks live document refs owned by a mounted workspace', () => {
        const options = createSignatureOptions();
        let originalPath: TDocumentRef | null = null;
        const workspace = {} as IWorkspaceExpose;
        workspace.getAutomationStateSnapshot = () => ({
            documentIdentity: null,
            annotationComments: [],
            annotationCommentsStatus: 'ready',
            annotationInventory: null,
            annotationDirty: false,
            originalPath,
            sortedAnnotationNoteWindows: [],
            workingCopyPath: null,
        });
        options.documentSessionsByTabId.value['tab-a'].attachWorkspace(workspace);
        const before = buildWorkspaceCheckpointChangeSignature(options);

        originalPath = requireDocumentRef('/restored.pdf');
        const after = buildWorkspaceCheckpointChangeSignature(options);

        expect(after.tabSignatures.get('tab-a')).not.toBe(before.tabSignatures.get('tab-a'));
        expect(after.workspace).not.toBe(before.workspace);
    });

    it('changes the workspace signature for workspace-only state', () => {
        const options = createSignatureOptions();
        const before = buildWorkspaceCheckpointChangeSignature(options);

        options.activeTabId.value = requireTabId('tab-b');
        const afterActiveTab = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterActiveTab.workspace).not.toBe(before.workspace);
        expect([...afterActiveTab.tabSignatures.entries()]).toEqual([...before.tabSignatures.entries()]);

        options.activeTabId.value = requireTabId('tab-a');
        options.panes.value = [{
            paneId: requirePaneId('pane-1'),
            tabIds: [
                requireTabId('tab-b'),
                requireTabId('tab-a'),
            ],
            activeTabId: requireTabId('tab-a'),
        }];
        const afterTabOrder = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterTabOrder.workspace).not.toBe(before.workspace);
    });
});

describe('buildWorkspaceCheckpoint', () => {
    it('fails closed when a mounted workspace snapshot cannot be captured', () => {
        const options = createSignatureOptions();
        const workspace = {} as IWorkspaceExpose;
        workspace.getAutomationStateSnapshot = () => {
            throw new Error('snapshot unavailable');
        };
        options.documentSessionsByTabId.value['tab-a'].attachWorkspace(workspace);

        let error: unknown;
        try {
            buildWorkspaceCheckpoint(options);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(WorkspaceCheckpointCaptureError);
        expect(error).toHaveProperty('message', expect.stringContaining('tab tab-a'));
    });
});
