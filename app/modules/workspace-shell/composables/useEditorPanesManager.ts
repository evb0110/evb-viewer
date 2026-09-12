import type { ITab } from '@app/types/tabs';
import { clamp } from 'es-toolkit/math';
import type {
    IEditorLayoutLeafNode,
    IEditorLayoutSplitNode,
    IEditorPaneState,
    TEditorLayoutNode,
    TPaneDirection,
} from '@contracts/editorPanes';
import {
    createPaneId,
    parsePaneId,
} from '@contracts/editorPanes';
import {
    createTabId,
    parseTabId,
    type TTabId,
} from '@contracts/windowTabs';
import {parseDocumentInstanceId} from '@contracts/documentInstanceId';
import {
    removeLeafNode,
    replaceLeafWithSplit,
    updateLayoutSplitRatio,
} from '@app/modules/workspace-shell/editor-panes/layoutTree';
import { findDirectionalPaneId } from '@app/modules/workspace-shell/editor-panes/findDirectionalPaneId';
import {
    arraysEqual,
    isEditorPanesStateNormalized,
    normalizeEditorPanesState,
} from '@app/modules/workspace-shell/editor-panes/normalization';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';

interface ICreateTabOptions {
    paneId?: string | null;
    initial?: Partial<Pick<ITab, 'fileName' | 'originalPath' | 'documentInstanceId' | 'isDirty' | 'isDjvu'>>;
    activate?: boolean;
}

export const useEditorPanesManager = () => {
    const panes = useState<IEditorPaneState[]>(
        'editorPanes:panes',
        () => [],
    );
    const tabs = useState<ITab[]>(
        'editorPanes:tabs',
        () => [],
    );
    const layout = useState<TEditorLayoutNode | null>(
        'editorPanes:layout',
        () => null,
    );
    const activePaneId = useState<string | null>(
        'editorPanes:active-pane-id',
        () => null,
    );
    const paneMru = useState<string[]>(
        'editorPanes:pane-mru',
        () => [],
    );
    const nextEntityId = useState<number>(
        'editorPanes:entity-id',
        () => 0,
    );

    function allocateEntityId(prefix: 'pane' | 'tab' | 'split') {
        nextEntityId.value += 1;
        return `${prefix}-${nextEntityId.value.toString(36)}`;
    }

    const paneLookup = computed<Map<string, IEditorPaneState>>(() => {
        return new Map(panes.value.map(pane => [
            pane.paneId,
            pane,
        ]));
    });
    const tabLookup = computed<Map<string, ITab>>(() => {
        return new Map(tabs.value.map(tab => [
            tab.id,
            tab,
        ]));
    });
    const tabPaneLookup = computed<Map<string, string>>(() => {
        return new Map(panes.value.flatMap((pane: IEditorPaneState) => pane.tabIds.map(tabId => [
            tabId,
            pane.paneId,
        ] as const)));
    });

    function createPane(): IEditorPaneState {
        return {
            paneId: createPaneId(),
            tabIds: [],
            activeTabId: null,
        };
    }

    function withPaneUpdate(
        paneId: string,
        update: (pane: IEditorPaneState) => IEditorPaneState,
    ) {
        panes.value = panes.value.map(pane => (
            pane.paneId === paneId ? update(pane) : pane
        ));
        return getPaneById(paneId);
    }

    function setPaneActiveTab(paneId: string, activeTabIdValue: string | null) {
        const activeTabId = activeTabIdValue === null ? null : parseTabId(activeTabIdValue);
        if (activeTabIdValue !== null && activeTabId === null) {
            return null;
        }
        return withPaneUpdate(paneId, pane => ({
            ...pane,
            activeTabId,
        }));
    }

    function updatePaneTabIds(
        paneId: string,
        update: (tabIds: TTabId[]) => TTabId[],
        activeTabIdUpdate?: (pane: IEditorPaneState, nextTabIds: TTabId[]) => TTabId | null,
    ) {
        return withPaneUpdate(paneId, (pane) => {
            const nextTabIds = update(pane.tabIds);
            return {
                ...pane,
                tabIds: nextTabIds,
                activeTabId: activeTabIdUpdate
                    ? activeTabIdUpdate(pane, nextTabIds)
                    : pane.activeTabId,
            };
        });
    }

    function isManagerStateNormalized() {
        return isEditorPanesStateNormalized({
            panes: panes.value,
            tabs: tabs.value,
            layout: layout.value,
            activePaneId: activePaneId.value,
            paneMru: paneMru.value,
        });
    }

    function normalizeManagerState() {
        if (isManagerStateNormalized()) {
            return;
        }
        const nextState = normalizeEditorPanesState({
            panes: panes.value,
            tabs: tabs.value,
            layout: layout.value,
            activePaneId: activePaneId.value,
            paneMru: paneMru.value,
            createPane,
        });
        tabs.value = nextState.tabs;
        panes.value = nextState.panes;
        layout.value = nextState.layout;
        activePaneId.value = nextState.activePaneId;
        paneMru.value = nextState.paneMru;
    }

    function restoreWorkspaceCheckpointGraph(checkpoint: IWorkspaceCheckpoint) {
        tabs.value = checkpoint.tabs.map((tab) => {
            const documentInstanceId = parseDocumentInstanceId(tab.annotationRecovery?.documentInstanceId);
            return {
                id: tab.tabId,
                fileName: tab.fileName,
                originalPath: tab.sourceRef,
                isDirty: tab.isDirty,
                isDjvu: tab.isDjvu,
                ...(documentInstanceId === null ? {} : {documentInstanceId}),
                ...(tab.isDirty && tab.workingCopyRef
                    ? {recoveryWorkingCopyPath: tab.workingCopyRef}
                    : {}),
            };
        });
        panes.value = checkpoint.panes.map(pane => ({
            paneId: pane.paneId,
            tabIds: [...pane.tabIds],
            activeTabId: pane.activeTabId,
        }));
        layout.value = checkpoint.layout;
        activePaneId.value = checkpoint.activePaneId;
        paneMru.value = checkpoint.activePaneId ? [checkpoint.activePaneId] : [];

        const numericSuffixes = [
            ...checkpoint.tabs.map(tab => tab.tabId),
            ...checkpoint.panes.map(pane => pane.paneId),
        ].map((id) => {
            const suffix = id.split('-').at(-1);
            return suffix ? Number.parseInt(suffix, 36) : 0;
        }).filter(Number.isFinite);
        nextEntityId.value = Math.max(nextEntityId.value, ...numericSuffixes, checkpoint.tabs.length + checkpoint.panes.length);
        normalizeManagerState();
    }

    function createEmptyTab(initial?: ICreateTabOptions['initial']): ITab {
        return {
            id: createTabId(),
            fileName: initial?.fileName ?? null,
            originalPath: initial?.originalPath ?? null,
            ...(initial?.documentInstanceId === undefined ? {} : {documentInstanceId: initial.documentInstanceId}),
            isDirty: initial?.isDirty ?? false,
            isDjvu: initial?.isDjvu ?? false,
        };
    }

    function touchPaneMru(paneId: string) {
        if (
            paneMru.value[0] === paneId
            && paneMru.value.indexOf(paneId, 1) === -1
        ) {
            return;
        }
        const next = paneMru.value.filter((candidate: string) => candidate !== paneId);
        next.unshift(paneId);
        if (!arraysEqual(paneMru.value, next)) {
            paneMru.value = next;
        }
    }

    function getPaneById(id: string | null | undefined): IEditorPaneState | null {
        if (!id) {
            return null;
        }
        return paneLookup.value.get(id) ?? null;
    }

    function getTabById(id: string | null | undefined): ITab | null {
        if (!id) {
            return null;
        }
        return tabLookup.value.get(id) ?? null;
    }

    function getPaneByTabId(tabId: string) {
        const paneId = tabPaneLookup.value.get(tabId);
        return paneId ? getPaneById(paneId) : null;
    }

    function getPaneTabs(paneId: string): ITab[] {
        const pane = getPaneById(paneId);
        if (!pane) {
            return [];
        }
        return pane.tabIds.flatMap((tabId: string) => {
            const tab = getTabById(tabId);
            return tab ? [tab] : [];
        });
    }

    function isPlaceholderTab(tab: ITab | null | undefined) {
        return Boolean(tab && !tabHasDocumentHint(tab) && !tab.isDirty);
    }

    function insertTabId(
        tabIds: TTabId[],
        tabId: TTabId,
        targetIndex: number | null | undefined,
    ) {
        const insertionIndex = targetIndex === null || targetIndex === undefined
            ? tabIds.length
            : clamp(targetIndex, 0, tabIds.length);

        return [
            ...tabIds.slice(0, insertionIndex),
            tabId,
            ...tabIds.slice(insertionIndex),
        ];
    }

    function resolveTargetTabIdsForMove(
        targetPane: IEditorPaneState,
        tabId: string,
        targetIndex: number | null | undefined,
    ) {
        const resolvedTabId = parseTabId(tabId);
        if (resolvedTabId === null) {
            return targetPane.tabIds;
        }
        const placeholderTabId = targetPane.tabIds.length === 1 ? targetPane.tabIds[0] : null;
        if (!placeholderTabId || placeholderTabId === resolvedTabId) {
            return insertTabId(targetPane.tabIds, resolvedTabId, targetIndex);
        }

        if (!isPlaceholderTab(getTabById(placeholderTabId))) {
            return insertTabId(targetPane.tabIds, resolvedTabId, targetIndex);
        }

        tabs.value = tabs.value.filter(candidate => candidate.id !== placeholderTabId);
        return [resolvedTabId];
    }

    function ensureLayoutInitialized() {
        if (layout.value && panes.value.length > 0) {
            return;
        }

        const pane = createPane();
        panes.value = [pane];
        activePaneId.value = pane.paneId;
        paneMru.value = [pane.paneId];
        layout.value = {
            type: 'leaf',
            paneId: pane.paneId,
        };
        normalizeManagerState();
    }

    function ensureAtLeastOneTab() {
        normalizeManagerState();
        ensureLayoutInitialized();

        const hasAnyTab = panes.value.some(pane => pane.tabIds.length > 0);
        if (hasAnyTab) {
            const activePane = getPaneById(activePaneId.value) ?? panes.value[0] ?? null;
            if (activePane) {
                activePaneId.value = activePane.paneId;
                touchPaneMru(activePane.paneId);
                if (!activePane.activeTabId && activePane.tabIds.length > 0) {
                    setPaneActiveTab(activePane.paneId, activePane.tabIds[0] ?? null);
                }
            }
            normalizeManagerState();
            return;
        }

        createTab({
            paneId: activePaneId.value,
            activate: true,
        });
        normalizeManagerState();
    }

    function activatePane(paneId: string) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return;
        }

        activePaneId.value = pane.paneId;
        touchPaneMru(pane.paneId);

        if (!pane.activeTabId && pane.tabIds.length > 0) {
            setPaneActiveTab(pane.paneId, pane.tabIds[0] ?? null);
        }
        normalizeManagerState();
    }

    function activateTab(paneId: string, tabId: string) {
        const pane = getPaneById(paneId);
        const parsedTabId = parseTabId(tabId);
        if (!pane || parsedTabId === null || !pane.tabIds.includes(parsedTabId)) {
            return;
        }

        setPaneActiveTab(paneId, tabId);
        activatePane(paneId);
        normalizeManagerState();
    }

    function createTab(options: ICreateTabOptions = {}) {
        normalizeManagerState();
        ensureLayoutInitialized();

        let pane = getPaneById(options.paneId ?? activePaneId.value);
        pane ??= panes.value[0] ?? null;
        if (!pane) {
            pane = createPane();
            panes.value = [
                ...panes.value,
                pane,
            ];
            layout.value ??= {
                type: 'leaf',
                paneId: pane.paneId,
            };
        }

        const tab = createEmptyTab(options.initial);
        const tabId = parseTabId(tab.id);
        if (tabId === null) {
            throw new TypeError('Created tab ID is invalid');
        }
        tabs.value = [
            ...tabs.value,
            tab,
        ];

        updatePaneTabIds(
            pane.paneId,
            tabIds => [
                ...tabIds,
                tabId,
            ],
            currentPane => options.activate !== false || !currentPane.activeTabId
                ? tabId
                : currentPane.activeTabId,
        );

        if (options.activate !== false) {
            activatePane(pane.paneId);
        }

        normalizeManagerState();
        return tab;
    }

    function moveTabWithinPane(paneId: string, fromIndex: number, toIndex: number) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return;
        }

        if (
            fromIndex < 0
            || fromIndex >= pane.tabIds.length
            || toIndex < 0
            || toIndex >= pane.tabIds.length
            || fromIndex === toIndex
        ) {
            return;
        }

        const tabId = pane.tabIds[fromIndex];
        if (!tabId) {
            return;
        }
        updatePaneTabIds(paneId, (tabIds) => {
            const withoutMoved = tabIds.filter((_, index) => index !== fromIndex);
            return [
                ...withoutMoved.slice(0, toIndex),
                tabId,
                ...withoutMoved.slice(toIndex),
            ];
        });
        normalizeManagerState();
    }

    function closePane(paneId: string) {
        if (panes.value.length <= 1) {
            return false;
        }

        const pane = getPaneById(paneId);
        if (!pane) {
            return false;
        }

        panes.value = panes.value.filter(candidate => candidate.paneId !== pane.paneId);
        paneMru.value = paneMru.value.filter((candidate: string) => candidate !== pane.paneId);

        if (layout.value) {
            layout.value = removeLeafNode(layout.value, pane.paneId);
        }

        const nextActivePane = getPaneById(activePaneId.value)
            ?? paneMru.value
                .flatMap((id: string) => {
                    const pane = getPaneById(id);
                    return pane ? [pane] : [];
                })
                .at(0)
            ?? panes.value[0]
            ?? null;

        activePaneId.value = nextActivePane?.paneId ?? null;
        if (nextActivePane) {
            touchPaneMru(nextActivePane.paneId);
            if (!nextActivePane.activeTabId && nextActivePane.tabIds.length > 0) {
                setPaneActiveTab(nextActivePane.paneId, nextActivePane.tabIds[0] ?? null);
            }
        }

        normalizeManagerState();
        return true;
    }

    function closeTab(paneId: string, tabId: string) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return {
                tab: null,
                removedPaneId: null,
            };
        }

        const tabIndex = pane.tabIds.findIndex((candidate: string) => candidate === tabId);
        if (tabIndex === -1) {
            return {
                tab: null,
                removedPaneId: null,
            };
        }

        const tab = getTabById(tabId);
        const nextTabIds = pane.tabIds.filter((candidate: string) => candidate !== tabId);
        tabs.value = tabs.value.filter(candidate => candidate.id !== tabId);

        const replacement = nextTabIds[tabIndex] ?? nextTabIds[tabIndex - 1] ?? null;
        updatePaneTabIds(
            pane.paneId,
            () => nextTabIds,
            currentPane => currentPane.activeTabId === tabId ? replacement : currentPane.activeTabId,
        );

        let removedPaneId: string | null = null;
        if (nextTabIds.length === 0) {
            if (panes.value.length > 1) {
                removedPaneId = pane.paneId;
                closePane(pane.paneId);
            } else {
                const replacement = createTab({
                    paneId: pane.paneId,
                    activate: true,
                });
                setPaneActiveTab(pane.paneId, replacement.id);
            }
        }

        normalizeManagerState();
        return {
            tab,
            removedPaneId,
        };
    }

    function findDirectionalPane(
        sourcePaneId: string,
        direction: TPaneDirection,
        wrap = true,
    ) {
        const resolvedSourcePaneId = parsePaneId(sourcePaneId);
        if (resolvedSourcePaneId === null) {
            return null;
        }
        const targetPaneId = findDirectionalPaneId({
            layout: layout.value,
            sourcePaneId: resolvedSourcePaneId,
            direction,
            paneMru: paneMru.value,
            wrap,
        });
        return targetPaneId ? getPaneById(targetPaneId) : null;
    }

    function splitPane(sourcePaneId: string, direction: TPaneDirection) {
        const resolvedSourcePaneId = parsePaneId(sourcePaneId);
        if (resolvedSourcePaneId === null) {
            return null;
        }
        const sourcePane = getPaneById(resolvedSourcePaneId);
        if (!sourcePane || !layout.value) {
            return null;
        }

        const newPane = createPane();
        panes.value = [
            ...panes.value,
            newPane,
        ];

        const sourceLeaf: IEditorLayoutLeafNode = {
            type: 'leaf',
            paneId: resolvedSourcePaneId,
        };
        const newLeaf: IEditorLayoutLeafNode = {
            type: 'leaf',
            paneId: newPane.paneId,
        };

        const horizontal = direction === 'left' || direction === 'right';
        const beforeSource = direction === 'left' || direction === 'up';

        const splitNode: IEditorLayoutSplitNode = {
            type: 'split',
            id: allocateEntityId('split'),
            orientation: horizontal ? 'horizontal' : 'vertical',
            ratio: 0.5,
            first: beforeSource ? newLeaf : sourceLeaf,
            second: beforeSource ? sourceLeaf : newLeaf,
        };

        layout.value = replaceLeafWithSplit(layout.value, resolvedSourcePaneId, splitNode);
        touchPaneMru(newPane.paneId);
        normalizeManagerState();

        return newPane.paneId;
    }

    function setSplitRatio(splitId: string, nextRatio: number) {
        const clamped = clamp(nextRatio, 0.15, 0.85);

        if (!layout.value) {
            return;
        }

        layout.value = updateLayoutSplitRatio(layout.value, splitId, clamped);
        normalizeManagerState();
    }

    function focusPane(direction: TPaneDirection, wrap = true) {
        const sourcePane = getPaneById(activePaneId.value) ?? panes.value[0] ?? null;
        if (!sourcePane) {
            return null;
        }

        const target = findDirectionalPane(sourcePane.paneId, direction, wrap);
        if (!target) {
            return null;
        }

        activatePane(target.paneId);
        return target.paneId;
    }

    function moveTabToPane(
        tabId: string,
        targetPaneId: string,
        activate = true,
        targetIndex?: number | null,
    ) {
        const sourcePane = getPaneByTabId(tabId);
        const targetPane = getPaneById(targetPaneId);
        const parsedTabId = parseTabId(tabId);
        if (!sourcePane || !targetPane || parsedTabId === null) {
            return false;
        }

        if (sourcePane.paneId === targetPane.paneId) {
            if (activate) {
                activateTab(targetPane.paneId, tabId);
            }
            normalizeManagerState();
            return true;
        }

        const sourceTabIndex = sourcePane.tabIds.indexOf(parsedTabId);
        const nextSourceTabIds = sourcePane.tabIds.filter(candidate => candidate !== parsedTabId);
        const sourceReplacementTabId = nextSourceTabIds[sourceTabIndex] ?? nextSourceTabIds[sourceTabIndex - 1] ?? null;
        updatePaneTabIds(
            sourcePane.paneId,
            () => nextSourceTabIds,
            currentPane => currentPane.activeTabId === parsedTabId
                ? sourceReplacementTabId
                : currentPane.activeTabId,
        );
        updatePaneTabIds(
            targetPane.paneId,
            () => resolveTargetTabIdsForMove(targetPane, parsedTabId, targetIndex),
            () => parsedTabId,
        );

        if (nextSourceTabIds.length === 0) {
            closePane(sourcePane.paneId);
        }

        if (activate) {
            activateTab(targetPane.paneId, tabId);
        }

        normalizeManagerState();
        return true;
    }

    function copyTabToPane(tabId: string, targetPaneId: string, activate = true) {
        const sourceTab = getTabById(tabId);
        const targetPane = getPaneById(targetPaneId);
        if (!sourceTab || !targetPane) {
            return null;
        }

        const copied = createTab({
            paneId: targetPane.paneId,
            activate,
            initial: {
                fileName: sourceTab.fileName,
                originalPath: sourceTab.originalPath,
                isDirty: sourceTab.isDirty,
                isDjvu: sourceTab.isDjvu,
            },
        });

        return copied;
    }

    function ensureTargetPaneForDirection(sourcePaneId: string, direction: TPaneDirection) {
        const existing = findDirectionalPane(sourcePaneId, direction, false);
        if (existing) {
            return {
                pane: existing,
                created: false,
            };
        }

        const paneId = splitPane(sourcePaneId, direction);
        const pane = getPaneById(paneId);
        if (!pane) {
            return null;
        }

        return {
            pane,
            created: true,
        };
    }

    function moveActiveTabToDirection(direction: TPaneDirection) {
        const sourcePane = getPaneById(activePaneId.value);
        if (!sourcePane || !sourcePane.activeTabId) {
            return null;
        }
        const sourceTabId = sourcePane.activeTabId;

        const target = ensureTargetPaneForDirection(sourcePane.paneId, direction);
        if (!target) {
            return null;
        }

        const moved = moveTabToPane(sourceTabId, target.pane.paneId, true);
        if (!moved) {
            return null;
        }

        return {
            tabId: sourceTabId,
            targetPaneId: target.pane.paneId,
            createdPane: target.created,
        };
    }

    function copyActiveTabToDirection(direction: TPaneDirection) {
        const sourcePane = getPaneById(activePaneId.value);
        if (!sourcePane || !sourcePane.activeTabId) {
            return null;
        }

        const target = ensureTargetPaneForDirection(sourcePane.paneId, direction);
        if (!target) {
            return null;
        }

        const copied = copyTabToPane(sourcePane.activeTabId, target.pane.paneId, true);
        if (!copied) {
            return null;
        }

        return {
            sourceTabId: sourcePane.activeTabId,
            targetTabId: copied.id,
            targetPaneId: target.pane.paneId,
            createdPane: target.created,
        };
    }

    const activePane = computed(() => getPaneById(activePaneId.value));
    const activeTabId = computed(() => activePane.value?.activeTabId ?? null);

    return {
        panes,
        tabs,
        layout,
        activePaneId,
        activePane,
        activeTabId,
        restoreWorkspaceCheckpointGraph,
        ensureAtLeastOneTab,
        getPaneById,
        getTabById,
        getPaneByTabId,
        getPaneTabs,
        activatePane,
        activateTab,
        createTab,
        closeTab,
        moveTabWithinPane,
        splitPane,
        closePane,
        setSplitRatio,
        focusPane,
        findDirectionalPane,
        moveTabToPane,
        copyTabToPane,
        moveActiveTabToDirection,
        copyActiveTabToDirection,
    };
};
