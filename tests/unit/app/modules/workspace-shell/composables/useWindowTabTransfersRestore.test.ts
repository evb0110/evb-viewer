import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TSplitPayload } from '@contracts/windowTabs';
import { requireDocumentRef } from '@contracts/documentRef';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { useWindowTabTransfers } from '@app/modules/workspace-shell/composables/useWindowTabTransfers';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import type { ITab } from '@app/types/tabs';

const mocks = vi.hoisted(() => ({cleanupSplitPayloadSnapshot: vi.fn(async () => undefined)}));
vi.mock('@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot', () => ({cleanupSplitPayloadSnapshot: mocks.cleanupSplitPayloadSnapshot}));
vi.mock('@app/utils/platformWindowTabs', () => ({getWindowTabsCapability: () => ({
    transfer: vi.fn(),
    transferAck: vi.fn(async () => true),
    closeCurrentWindow: vi.fn(async () => false),
})}));

function createPayload(): Extract<TSplitPayload, {kind: 'pdfSnapshot'}> {
    return {
        kind: 'pdfSnapshot',
        fileName: 'sample.pdf',
        originalPath: requireDocumentRef('/tmp/sample.pdf'),
        snapshotPath: requireDocumentRef('/tmp/snapshot.pdf'),
        isDirty: true,
    };
}

function createRestoreTransfers(workspace: IWorkspaceExpose) {
    const pane = {
        paneId: 'pane-1',
        activeTabId: 'tab-1',
        tabIds: ['tab-1'],
    };
    const tab: ITab = {
        id: 'tab-1',
        fileName: 'sample.pdf',
        originalPath: requireDocumentRef('/tmp/sample.pdf'),
        isDirty: true,
        isDjvu: false,
    };
    return useWindowTabTransfers({
        activePaneId: ref('pane-1'),
        panes: ref([pane]),
        tabs: ref([tab]),
        layout: ref(null),
        createTab: vi.fn(() => tab),
        getPaneById: vi.fn(() => pane),
        getTabById: vi.fn(() => tab),
        getPaneByTabId: vi.fn(() => pane),
        activatePane: vi.fn(),
        activateTab: vi.fn(),
        removeTabFromState: vi.fn(),
        updateTab: vi.fn(),
        cleanupEmptyPanes: vi.fn(),
        closeTabInState: vi.fn(),
        workspaceRefs: ref(new Map([[
            'tab-1',
            workspace,
        ]])),
        waitForWorkspace: vi.fn(async () => workspace),
        workspaceRestoreTracker: {
            start: vi.fn(),
            finish: vi.fn(),
        },
        handleCloseTab: vi.fn(),
        handoffActiveTabBeforeClose: vi.fn(),
    });
}

describe('useWindowTabTransfers restore outcomes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
    });

    it.each([
        {
            name: 'PDF',
            payload: createPayload() as TSplitPayload,
        },
        {
            name: 'DjVu',
            payload: {
                kind: 'djvu' as const,
                sourcePath: requireDocumentRef('/tmp/scan.djvu'),
            },
        },
    ])('rejects a failed $name restore without progressing transfer state', async ({payload}) => {
        const workspace = createWorkspaceExposeFixture({
            hasPdf: false,
            restoreSplitPayload: vi.fn(async () => ({
                status: 'failed' as const,
                error: 'restore failed',
            })),
        });
        const transfers = createRestoreTransfers(workspace);

        await expect(transfers.restoreWorkspacePayload('tab-1', payload)).resolves.toBe(false);
        expect(mocks.cleanupSplitPayloadSnapshot).toHaveBeenCalledWith(payload, expect.objectContaining({context: 'restore-workspace-payload'}));
    });

    it('continues only after the workspace reports an opened document', async () => {
        const payload = createPayload();
        const workspace = createWorkspaceExposeFixture({
            hasPdf: true,
            restoreSplitPayload: vi.fn(async () => ({
                status: 'opened' as const,
                result: {
                    kind: 'pdf' as const,
                    workingPath: payload.snapshotPath,
                    originalPath: payload.originalPath!,
                },
            })),
        });
        const transfers = createRestoreTransfers(workspace);

        await expect(transfers.restoreWorkspacePayload('tab-1', payload)).resolves.toBe(true);
        expect(mocks.cleanupSplitPayloadSnapshot).not.toHaveBeenCalled();
    });
});
