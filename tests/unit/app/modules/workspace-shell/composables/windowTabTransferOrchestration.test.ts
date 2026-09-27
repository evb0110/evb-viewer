import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import { requirePaneId } from '@contracts/editorPanes';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireTabId } from '@contracts/windowTabs';
import type { IWindowTabIncomingTransfer } from '@contracts/windowTabs';
import type { ITab } from '@app/types/tabs';
import { collectLayoutPaneOrder } from '@app/modules/workspace-shell/window-tabs/collectLayoutPaneOrder';
import { collectMergeTabOrder } from '@app/modules/workspace-shell/window-tabs/collectMergeTabOrder';
import { shouldCloseSourceWindowAfterTransfer } from '@app/modules/workspace-shell/window-tabs/shouldCloseSourceWindowAfterTransfer';
import { useWindowTabTransfers } from '@app/modules/workspace-shell/composables/useWindowTabTransfers';
import {
    createWorkspaceDocumentController,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { TWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import { cast } from '@tests/helpers/cast';

const transferAckMock = vi.hoisted(() => vi.fn(async (_ack: {
    transferId: string;
    success: boolean;
    error?: string
}) => true));
vi.mock('@app/utils/platformWindowTabs', () => ({
    canUseNativeWindowTabTransfers: () => true,
    getWindowTabsCapability: () => ({transferAck: transferAckMock}),
}));

function createTab(id: string): ITab {
    return {id};
}

describe('window tab transfer orchestration helpers', () => {
    it('collects pane order by stable layout traversal', () => {
        const layout: TEditorLayoutNode = {
            type: 'split',
            id: 'root',
            orientation: 'horizontal',
            ratio: 0.6,
            first: {
                type: 'leaf',
                paneId: requirePaneId('pane-left'),
            },
            second: {
                type: 'split',
                id: 'nested',
                orientation: 'vertical',
                ratio: 0.5,
                first: {
                    type: 'leaf',
                    paneId: requirePaneId('pane-top-right'),
                },
                second: {
                    type: 'leaf',
                    paneId: requirePaneId('pane-bottom-right'),
                },
            },
        };

        expect(collectLayoutPaneOrder(layout)).toEqual([
            'pane-left',
            'pane-top-right',
            'pane-bottom-right',
        ]);
    });

    it('collects merge tab order by layout order and tab order inside each pane', () => {
        const layout: TEditorLayoutNode = {
            type: 'split',
            id: 'root',
            orientation: 'horizontal',
            ratio: 0.5,
            first: {
                type: 'leaf',
                paneId: requirePaneId('pane-a'),
            },
            second: {
                type: 'leaf',
                paneId: requirePaneId('pane-b'),
            },
        };

        const panes: IEditorPaneState[] = [
            {
                paneId: requirePaneId('pane-a'),
                tabIds: [
                    requireTabId('tab-1'),
                    requireTabId('tab-2'),
                ],
                activeTabId: requireTabId('tab-1'),
            },
            {
                paneId: requirePaneId('pane-b'),
                tabIds: [requireTabId('tab-3')],
                activeTabId: requireTabId('tab-3'),
            },
        ];

        const tabs: ITab[] = [
            createTab('tab-1'),
            createTab('tab-2'),
            createTab('tab-3'),
            createTab('tab-detached'),
        ];

        expect(collectMergeTabOrder(layout, panes, tabs)).toEqual([
            'tab-1',
            'tab-2',
            'tab-3',
            'tab-detached',
        ]);
    });

    it('requires electron bridge and empty-source state before closing source window', () => {
        expect(shouldCloseSourceWindowAfterTransfer(1, true)).toBe(true);
        expect(shouldCloseSourceWindowAfterTransfer(0, true)).toBe(true);
        expect(shouldCloseSourceWindowAfterTransfer(2, true)).toBe(false);
        expect(shouldCloseSourceWindowAfterTransfer(1, false)).toBe(false);
    });

    it('rejects a transfer after its workspace mount fails and proceeds to the next queued transfer', async () => {
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        onTestFinished(() => {
            vi.unstubAllGlobals();
        });
        transferAckMock.mockClear();
        const pane = {
            paneId: requirePaneId('pane-target'),
            activeTabId: null as string | null,
            tabIds: [] as string[],
        };
        const panes = ref([pane]);
        const tabs = ref<ITab[]>([]);
        const activePaneId = ref<string | null>(pane.paneId);
        const sessions = new Map<string, IWorkspaceDocumentController>();
        const mountWaiterStarted = Promise.withResolvers<undefined>();
        let createdTabs = 0;
        const transfers = useWindowTabTransfers({
            activePaneId,
            panes,
            tabs,
            layout: ref<TEditorLayoutNode | null>({
                type: 'leaf',
                paneId: pane.paneId,
            }),
            createTab: () => {
                createdTabs += 1;
                const tab = {id: `incoming-${createdTabs}`};
                tabs.value = [
                    ...tabs.value,
                    tab,
                ];
                pane.tabIds.push(tab.id);
                pane.activeTabId = tab.id;
                const session = createWorkspaceDocumentController({tabId: tab.id});
                sessions.set(tab.id, session);
                if (createdTabs === 1) {
                    const whenMounted = session.whenMounted.bind(session);
                    session.whenMounted = () => {
                        const pending = whenMounted();
                        mountWaiterStarted.resolve(undefined);
                        return pending;
                    };
                } else {
                    session.attachWorkspace(createWorkspaceExposeFixture({restoreSplitPayload: async () => ({status: 'cancelled'})}));
                }
                return tab;
            },
            getPaneById: paneId => panes.value.find(candidate => candidate.paneId === paneId) ?? null,
            getTabById: tabId => tabs.value.find(tab => tab.id === tabId) ?? null,
            getPaneByTabId: tabId => panes.value.find(candidate => candidate.tabIds.includes(tabId)) ?? null,
            activatePane: paneId => {
                activePaneId.value = paneId;
            },
            activateTab: (paneId, tabId) => {
                const targetPane = panes.value.find(candidate => candidate.paneId === paneId);
                if (targetPane) targetPane.activeTabId = tabId;
            },
            removeTabFromState: tabId => {
                tabs.value = tabs.value.filter(tab => tab.id !== tabId);
                pane.tabIds = pane.tabIds.filter(id => id !== tabId);
                pane.activeTabId = pane.tabIds[0] ?? null;
            },
            cleanupEmptyPanes: () => undefined,
            closeTabInState: () => undefined,
            documentSessions: cast<TWorkspaceDocumentSessions>({getSession: (tabId: string | null | undefined) => tabId ? sessions.get(tabId) ?? null : null}),
            workspaceRestoreTracker: {
                start: () => undefined,
                finish: () => undefined,
            },
            handleCloseTab: async () => undefined,
            handoffActiveTabBeforeClose: async () => undefined,
        });

        const sourcePath = requireDocumentRef('/source/transfer.djvu');
        const makeTransfer = (transferId: string): IWindowTabIncomingTransfer => ({
            transferId,
            sourceWindowId: 2,
            targetWindowId: 1,
            tab: {
                fileName: 'transfer.djvu',
                originalPath: sourcePath,
                isDirty: false,
                isDjvu: true,
            },
            payload: {
                kind: 'djvu',
                sourcePath,
            },
        });
        const firstTransfer = transfers.handleIncomingTabTransfer(makeTransfer('transfer-failed-mount'));
        await mountWaiterStarted.promise;
        const secondTransfer = transfers.handleIncomingTabTransfer(makeTransfer('transfer-next'));
        sessions.get('incoming-1')?.markFailed({
            message: 'Workspace chunk failed',
            failure: null,
        });

        await Promise.all([
            firstTransfer,
            secondTransfer,
        ]);

        expect(transferAckMock).toHaveBeenCalledTimes(2);
        expect(transferAckMock.mock.calls.map(([ack]) => [
            ack.transferId,
            ack.success,
        ])).toEqual([
            [
                'transfer-failed-mount',
                false,
            ],
            [
                'transfer-next',
                false,
            ],
        ]);
        expect(createdTabs).toBe(2);
    });
});
