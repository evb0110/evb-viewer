import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import { requirePaneId } from '@contracts/editorPanes';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireDocumentInstanceId } from '@contracts/documentInstanceId';
import { requireEpochMs } from '@contracts/timestamps';
import { requireTabId } from '@contracts/windowTabs';
import { useEditorPanesManager } from '@app/modules/workspace-shell/composables/useEditorPanesManager';

const stateStore = new Map<string, ReturnType<typeof ref>>();

interface ILegacyEditorPaneState {
    id: string;
    tabIds: string[];
    activeTabId: string | null;
}

function installUseStateStub() {
    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
        const existing = stateStore.get(key);
        if (existing) {
            return existing;
        }
        const state = ref(init());
        stateStore.set(key, state);
        return state;
    });
}

function collectLeafPaneIds(node: TEditorLayoutNode | null, target: Set<string>) {
    if (!node) {
        return;
    }
    if (node.type === 'leaf') {
        target.add(node.paneId);
        return;
    }
    collectLeafPaneIds(node.first, target);
    collectLeafPaneIds(node.second, target);
}

describe('useEditorPanesManager', () => {
    beforeEach(() => {
        stateStore.clear();
        installUseStateStub();
    });

    it('repairs duplicate tab assignment and invalid active tab references', async () => {
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const firstPane = manager.panes.value[0]!;
        const firstTab = manager.createTab({
            paneId: firstPane.paneId,
            activate: true,
        });
        const secondPaneId = manager.splitPane(firstPane.paneId, 'right');
        expect(secondPaneId).toBeTruthy();
        const secondPane = manager.getPaneById(secondPaneId);
        expect(secondPane).not.toBeNull();

        if (secondPane) {
            secondPane.tabIds.push(requireTabId(firstTab.id));
            secondPane.tabIds.push(requireTabId('missing-tab-id'));
            secondPane.activeTabId = requireTabId('missing-tab-id');
        }
        firstPane.activeTabId = requireTabId('missing-tab-id');
        manager.tabs.value.push({
            ...firstTab,
            fileName: 'duplicate-id',
        });
        const panesWithLegacyState = manager.panes.value as Array<IEditorPaneState | ILegacyEditorPaneState>;
        panesWithLegacyState.push({
            id: firstPane.paneId,
            tabIds: [firstTab.id],
            activeTabId: firstTab.id,
        });

        manager.ensureAtLeastOneTab();

        const tabIds = manager.tabs.value.map(tab => tab.id);
        expect(new Set(tabIds).size).toBe(tabIds.length);

        const occurrences = manager.panes.value.reduce((count, pane) => (
            count + pane.tabIds.filter(tabId => tabId === firstTab.id).length
        ), 0);
        expect(occurrences).toBe(1);

        const uniquePaneIds = new Set(manager.panes.value.map(pane => pane.paneId));
        expect(uniquePaneIds.size).toBe(manager.panes.value.length);

        for (const pane of manager.panes.value) {
            expect(pane.tabIds).not.toContain('missing-tab-id');
            if (pane.tabIds.length === 0) {
                expect(pane.activeTabId).toBeNull();
                continue;
            }
            expect(pane.tabIds).toContain(pane.activeTabId);
        }
    });

    it('repairs layout leaves that reference removed panes', async () => {
        const manager = useEditorPanesManager();

        manager.layout.value = {
            type: 'leaf',
            paneId: requirePaneId('missing-pane-id'),
        };
        manager.activePaneId.value = requirePaneId('missing-pane-id');

        manager.ensureAtLeastOneTab();

        const validPaneIds = new Set(manager.panes.value.map(pane => pane.paneId));
        const layoutPaneIds = new Set<string>();
        collectLeafPaneIds(manager.layout.value, layoutPaneIds);

        expect(layoutPaneIds.size).toBeGreaterThan(0);
        for (const paneId of layoutPaneIds) {
            expect(validPaneIds.has(requirePaneId(paneId))).toBe(true);
        }
        expect(manager.activePaneId.value).not.toBe('missing-pane-id');
        expect(manager.activePaneId.value).not.toBeNull();
    });

    it('keeps key refs stable when normalization is a no-op', async () => {
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const panesRef = manager.panes.value;
        const tabsRef = manager.tabs.value;
        const layoutRef = manager.layout.value;
        const firstPaneRef = manager.panes.value[0];
        const firstPaneTabIdsRef = manager.panes.value[0]?.tabIds;

        manager.ensureAtLeastOneTab();

        expect(manager.panes.value).toBe(panesRef);
        expect(manager.tabs.value).toBe(tabsRef);
        expect(manager.layout.value).toBe(layoutRef);
        expect(manager.panes.value[0]).toBe(firstPaneRef);
        expect(manager.panes.value[0]?.tabIds).toBe(firstPaneTabIdsRef);
    });

    it('selects the adjacent source tab after moving the active tab to another pane', async () => {
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const sourcePane = manager.activePane.value!;
        const firstTabId = sourcePane.activeTabId!;
        const secondTab = manager.createTab({
            paneId: sourcePane.paneId,
            activate: true,
        });
        const thirdTab = manager.createTab({
            paneId: sourcePane.paneId,
            activate: true,
        });
        const targetPaneId = manager.splitPane(sourcePane.paneId, 'right');
        expect(targetPaneId).toBeTruthy();

        manager.activateTab(sourcePane.paneId, secondTab.id);
        expect(manager.moveTabToPane(secondTab.id, targetPaneId!, false)).toBe(true);
        expect(manager.getPaneById(sourcePane.paneId)?.activeTabId).toBe(thirdTab.id);

        manager.activateTab(sourcePane.paneId, thirdTab.id);
        expect(manager.moveTabToPane(thirdTab.id, targetPaneId!, false)).toBe(true);
        expect(manager.getPaneById(sourcePane.paneId)?.activeTabId).toBe(firstTabId);
    });

    it('replaces a singleton destination placeholder when moving a tab between panes', async () => {
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const sourcePane = manager.activePane.value!;
        const movedTabId = sourcePane.activeTabId!;
        Object.assign(manager.getTabById(movedTabId)!, {
            fileName: 'moved.pdf',
            originalPath: requireDocumentRef('/tmp/moved.pdf'),
        });
        const remainingTab = manager.createTab({
            paneId: sourcePane.paneId,
            activate: false,
            initial: {
                fileName: 'remaining.pdf',
                originalPath: requireDocumentRef('/tmp/remaining.pdf'),
            },
        });
        const targetPaneId = manager.splitPane(sourcePane.paneId, 'right');
        expect(targetPaneId).toBeTruthy();
        const placeholder = manager.createTab({
            paneId: targetPaneId,
            activate: true,
        });
        manager.activateTab(sourcePane.paneId, movedTabId);

        expect(manager.moveTabToPane(movedTabId, targetPaneId!, true)).toBe(true);

        expect(manager.getPaneById(sourcePane.paneId)?.activeTabId).toBe(remainingTab.id);
        expect(manager.getPaneById(targetPaneId)?.tabIds).toEqual([movedTabId]);
        expect(manager.getPaneById(targetPaneId)?.activeTabId).toBe(movedTabId);
        expect(manager.getTabById(placeholder.id)).toBeNull();
        expect(manager.tabs.value.map(tab => tab.id)).not.toContain(placeholder.id);
        expect(manager.activePaneId.value).toBe(targetPaneId);
    });

    it('inserts a moved tab at the requested destination index', async () => {
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const sourcePane = manager.activePane.value!;
        const movedTabId = sourcePane.activeTabId!;
        const sourceRemainingTab = manager.createTab({
            paneId: sourcePane.paneId,
            activate: false,
        });
        const targetPaneId = manager.splitPane(sourcePane.paneId, 'right');
        expect(targetPaneId).toBeTruthy();
        const targetFirstTab = manager.createTab({
            paneId: targetPaneId,
            activate: true,
            initial: {
                fileName: 'target-1.pdf',
                originalPath: requireDocumentRef('/tmp/target-1.pdf'),
            },
        });
        const targetSecondTab = manager.createTab({
            paneId: targetPaneId,
            activate: false,
            initial: {
                fileName: 'target-2.pdf',
                originalPath: requireDocumentRef('/tmp/target-2.pdf'),
            },
        });
        manager.activateTab(sourcePane.paneId, movedTabId);

        expect(manager.moveTabToPane(movedTabId, targetPaneId!, true, 0)).toBe(true);

        expect(manager.getPaneById(sourcePane.paneId)?.activeTabId).toBe(sourceRemainingTab.id);
        expect(manager.getPaneById(targetPaneId)?.tabIds).toEqual([
            movedTabId,
            targetFirstTab.id,
            targetSecondTab.id,
        ]);
        expect(manager.getPaneById(targetPaneId)?.activeTabId).toBe(movedTabId);
    });

    it('reorders tabs within a pane without changing the active tab', async () => {
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const pane = manager.activePane.value!;
        const firstTabId = pane.activeTabId!;
        const secondTab = manager.createTab({
            paneId: pane.paneId,
            activate: true,
        });
        const thirdTab = manager.createTab({
            paneId: pane.paneId,
            activate: true,
        });
        manager.activateTab(pane.paneId, secondTab.id);

        manager.moveTabWithinPane(pane.paneId, 2, 0);

        expect(manager.getPaneById(pane.paneId)?.tabIds).toEqual([
            thirdTab.id,
            firstTabId,
            secondTab.id,
        ]);
        expect(manager.getPaneById(pane.paneId)?.activeTabId).toBe(secondTab.id);
    });

    it('closes active tabs by selecting the next neighbor and removes empty panes', async () => {
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const sourcePane = manager.activePane.value!;
        const firstTabId = sourcePane.activeTabId!;
        const secondTab = manager.createTab({
            paneId: sourcePane.paneId,
            activate: true,
        });
        const thirdTab = manager.createTab({
            paneId: sourcePane.paneId,
            activate: true,
        });
        manager.activateTab(sourcePane.paneId, secondTab.id);

        const closedActive = manager.closeTab(sourcePane.paneId, secondTab.id);

        expect(closedActive.tab?.id).toBe(secondTab.id);
        expect(closedActive.removedPaneId).toBeNull();
        expect(manager.getPaneById(sourcePane.paneId)?.tabIds).toEqual([
            firstTabId,
            thirdTab.id,
        ]);
        expect(manager.getPaneById(sourcePane.paneId)?.activeTabId).toBe(thirdTab.id);

        const targetPaneId = manager.splitPane(sourcePane.paneId, 'right');
        expect(targetPaneId).toBeTruthy();
        const targetTab = manager.createTab({
            paneId: targetPaneId,
            activate: true,
        });

        const closedOnlyTarget = manager.closeTab(targetPaneId!, targetTab.id);

        expect(closedOnlyTarget.tab?.id).toBe(targetTab.id);
        expect(closedOnlyTarget.removedPaneId).toBe(targetPaneId);
        expect(manager.getPaneById(targetPaneId)).toBeNull();
        expect(manager.panes.value.map(pane => pane.paneId)).toContain(sourcePane.paneId);
    });

    it('moves and copies active tabs by direction while updating pane focus', async () => {
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const sourcePane = manager.activePane.value!;
        const firstTabId = sourcePane.activeTabId!;
        const secondTab = manager.createTab({
            paneId: sourcePane.paneId,
            activate: true,
        });
        manager.activateTab(sourcePane.paneId, firstTabId);
        const targetPaneId = manager.splitPane(sourcePane.paneId, 'right');
        expect(targetPaneId).toBeTruthy();

        const moved = manager.moveActiveTabToDirection('right');

        expect(moved).toEqual({
            tabId: firstTabId,
            targetPaneId,
            createdPane: false,
        });
        expect(manager.getPaneById(sourcePane.paneId)?.activeTabId).toBe(secondTab.id);
        expect(manager.getPaneById(targetPaneId)?.activeTabId).toBe(firstTabId);
        expect(manager.activePaneId.value).toBe(targetPaneId);

        manager.activatePane(sourcePane.paneId);
        manager.activateTab(sourcePane.paneId, secondTab.id);
        const copied = manager.copyActiveTabToDirection('down');

        expect(copied?.sourceTabId).toBe(secondTab.id);
        expect(copied?.createdPane).toBe(true);
        expect(copied?.targetPaneId).not.toBe(sourcePane.paneId);
        expect(manager.getPaneById(copied!.targetPaneId)?.activeTabId).toBe(copied?.targetTabId);
        expect(manager.getTabById(copied!.targetTabId)?.fileName).toBe(secondTab.fileName);
        expect(manager.activePaneId.value).toBe(copied?.targetPaneId);
    });

    it('clamps split ratios and focuses directional panes', async () => {
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        const sourcePane = manager.activePane.value!;
        const targetPaneId = manager.splitPane(sourcePane.paneId, 'right');
        expect(targetPaneId).toBeTruthy();
        const splitNode = manager.layout.value?.type === 'split' ? manager.layout.value : null;
        expect(splitNode).not.toBeNull();

        manager.setSplitRatio(splitNode!.id, 0.95);
        expect((manager.layout.value as Extract<TEditorLayoutNode, { type: 'split' }>).ratio).toBe(0.85);

        manager.setSplitRatio(splitNode!.id, 0.01);
        expect((manager.layout.value as Extract<TEditorLayoutNode, { type: 'split' }>).ratio).toBe(0.15);

        const focusedPaneId = manager.focusPane('right');

        expect(focusedPaneId).toBe(targetPaneId);
        expect(manager.activePaneId.value).toBe(targetPaneId);
    });

    it('restores the exact checkpoint pane, tab, layout, and active graph', async () => {
        const manager = useEditorPanesManager();
        manager.ensureAtLeastOneTab();

        manager.restoreWorkspaceCheckpointGraph({
            version: 1,
            capturedAt: requireEpochMs(123),
            activePaneId: requirePaneId('pane-b'),
            activeTabId: requireTabId('tab-b'),
            layout: {
                type: 'split',
                id: 'split-a',
                orientation: 'horizontal',
                ratio: 0.4,
                first: {
                    type: 'leaf',
                    paneId: requirePaneId('pane-a'),
                },
                second: {
                    type: 'leaf',
                    paneId: requirePaneId('pane-b'),
                },
            },
            panes: [
                {
                    paneId: requirePaneId('pane-a'),
                    tabIds: [requireTabId('tab-a')],
                    activeTabId: requireTabId('tab-a'),
                },
                {
                    paneId: requirePaneId('pane-b'),
                    tabIds: [requireTabId('tab-b')],
                    activeTabId: requireTabId('tab-b'),
                },
            ],
            tabs: [
                {
                    tabId: requireTabId('tab-a'),
                    paneId: requirePaneId('pane-a'),
                    fileName: 'a.pdf',
                    sourceRef: requireDocumentRef('/documents/a.pdf'),
                    workingCopyRef: null,
                    isDirty: false,
                    isDjvu: false,
                    currentPage: 1,
                    zoom: 1,
                    zoomMode: 'fit-width',
                },
                {
                    tabId: requireTabId('tab-b'),
                    paneId: requirePaneId('pane-b'),
                    fileName: 'b.pdf',
                    sourceRef: requireDocumentRef('/documents/b.pdf'),
                    workingCopyRef: null,
                    isDirty: true,
                    isDjvu: false,
                    currentPage: 2,
                    zoom: 1.25,
                    zoomMode: 'custom',
                    annotationRecovery: {
                        artifactId: 'recovery-b',
                        documentInstanceId: 'document-b',
                        workingCopyRef: null,
                        workingByteRevision: 'revision-b',
                        annotationMutationGeneration: 1,
                    },
                },
            ],
        });

        expect(manager.panes.value).toEqual([
            {
                paneId: 'pane-a',
                tabIds: ['tab-a'],
                activeTabId: 'tab-a',
            },
            {
                paneId: 'pane-b',
                tabIds: ['tab-b'],
                activeTabId: 'tab-b',
            },
        ]);
        expect(manager.tabs.value.map(tab => tab.id)).toEqual([
            'tab-a',
            'tab-b',
        ]);
        expect(manager.getTabById('tab-b')).toMatchObject({
            fileName: 'b.pdf',
            originalPath: '/documents/b.pdf',
            documentInstanceId: requireDocumentInstanceId('document-b'),
            isDirty: true,
        });
        expect(manager.layout.value).toMatchObject({
            type: 'split',
            id: 'split-a',
            ratio: 0.4,
        });
        expect(manager.activePaneId.value).toBe('pane-b');
        expect(manager.activeTabId.value).toBe('tab-b');
    });
});
