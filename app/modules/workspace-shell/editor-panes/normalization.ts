import type {ITab} from '@app/types/tabs';
import {uniq, uniqBy} from 'es-toolkit/array';
import type {IEditorPaneState, TPaneId, TEditorLayoutNode} from '@contracts/editorPanes';
import {parsePaneId} from '@contracts/editorPanes';
import {parseTabId, type TTabId} from '@contracts/windowTabs';
import {appendPaneToLayout, collectLayoutPaneIds, pruneLayoutToExistingPanes} from '@app/modules/workspace-shell/editor-panes/layoutTree';

interface IEditorPanesStateSnapshot {
    panes: IEditorPaneState[];
    tabs: ITab[];
    layout: TEditorLayoutNode | null;
    activePaneId: string | null;
    paneMru: string[];
}

interface INormalizeEditorPanesStateParams extends IEditorPanesStateSnapshot {
    createPane: () => IEditorPaneState;
}

function readPaneId(pane: IEditorPaneState): TPaneId | null {
    const rawPane = pane as IEditorPaneState & {id?: unknown};
    return parsePaneId(rawPane.paneId) ?? parsePaneId(rawPane.id);
}

export function arraysEqual<T>(left: T[], right: T[]) {
    if (left === right) {
        return true;
    }
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function buildNormalizedPaneMru(currentActivePaneId: string | null, currentMru: string[], panesOrder: string[], validPaneIds: Set<string>) {
    const preferredPaneIds = [currentActivePaneId, ...currentMru, ...panesOrder];
    return uniq(
        preferredPaneIds.flatMap((paneId): TPaneId[] => {
            const parsedPaneId = parsePaneId(paneId);
            if (parsedPaneId === null) {
                return [];
            }
            return validPaneIds.has(parsedPaneId) ? [parsedPaneId] : [];
        }),
    );
}

function collectUniqueTabs(tabs: ITab[]) {
    const uniqueTabs = uniqBy(
        tabs.filter((tab) => tab.id),
        (tab) => tab.id,
    );
    const validTabIds = new Set<TTabId>();
    for (const tab of uniqueTabs) {
        const tabId = parseTabId(tab.id);
        if (tabId !== null) {
            validTabIds.add(tabId);
        }
    }

    return {
        tabs: uniqueTabs,
        tabIds: validTabIds,
        hasInvalidTabs: uniqueTabs.length !== tabs.length || validTabIds.size !== uniqueTabs.length,
    };
}

function normalizePaneTabIds(panes: IEditorPaneState[], validTabIds: Set<TTabId>) {
    const normalizedPanes: IEditorPaneState[] = [];
    const validPaneIds = new Set<string>();
    const assignedTabIds = new Set<TTabId>();
    let hasInvalidPanes = false;

    for (const pane of panes) {
        const paneId = readPaneId(pane);
        if (!paneId || validPaneIds.has(paneId)) {
            hasInvalidPanes = true;
            continue;
        }
        hasInvalidPanes ||= pane.paneId !== paneId;
        validPaneIds.add(paneId);

        const nextTabIds: TTabId[] = [];
        for (const tabId of pane.tabIds) {
            const parsedTabId = parseTabId(tabId);
            if (parsedTabId === null || !validTabIds.has(parsedTabId) || assignedTabIds.has(parsedTabId)) {
                hasInvalidPanes = true;
                continue;
            }
            assignedTabIds.add(parsedTabId);
            nextTabIds.push(parsedTabId);
        }

        const activeTabId = pane.activeTabId && nextTabIds.includes(pane.activeTabId) ? pane.activeTabId : (nextTabIds[0] ?? null);
        hasInvalidPanes ||= pane.activeTabId !== activeTabId;
        normalizedPanes.push({
            paneId,
            tabIds: nextTabIds,
            activeTabId,
        });
    }

    return {
        panes: normalizedPanes,
        paneIds: validPaneIds,
        assignedTabIds,
        hasInvalidPanes,
    };
}

function normalizeLayoutForPanes(
    layout: TEditorLayoutNode | null,
    panes: IEditorPaneState[],
    validPaneIds: Set<string>,
): TEditorLayoutNode {
    let nextLayout = layout ? pruneLayoutToExistingPanes(layout, validPaneIds) : null;
    const firstPane = panes[0];
    if (!firstPane) {
        throw new Error('Cannot normalize an editor layout without a pane');
    }
    nextLayout ??= {
        type: 'leaf',
        paneId: firstPane.paneId,
    };

    const layoutPaneIds = new Set<string>();
    collectLayoutPaneIds(nextLayout, layoutPaneIds);
    for (const pane of panes) {
        if (layoutPaneIds.has(pane.paneId)) {
            continue;
        }
        nextLayout = appendPaneToLayout(nextLayout, pane.paneId);
        layoutPaneIds.add(pane.paneId);
    }

    return nextLayout;
}

function layoutMatchesPanes(layout: TEditorLayoutNode | null, validPaneIds: Set<string>) {
    if (!layout) {
        return false;
    }
    const layoutPaneIds = new Set<string>();
    collectLayoutPaneIds(layout, layoutPaneIds);
    for (const paneId of layoutPaneIds) {
        if (!validPaneIds.has(paneId)) {
            return false;
        }
    }
    for (const paneId of validPaneIds) {
        if (!layoutPaneIds.has(paneId)) {
            return false;
        }
    }

    return true;
}

function normalizeActivePaneAndMru(activePaneId: string | null, paneMru: string[], panes: IEditorPaneState[], validPaneIds: Set<string>) {
    const nextActivePaneId = activePaneId && validPaneIds.has(activePaneId) ? activePaneId : (panes[0]?.paneId ?? null);
    const nextMru = buildNormalizedPaneMru(
        nextActivePaneId,
        paneMru,
        panes.map((pane) => pane.paneId),
        validPaneIds,
    );

    return {
        activePaneId: nextActivePaneId,
        paneMru: nextMru,
    };
}

function clonePanesWithUnassignedTabs(panes: IEditorPaneState[], tabs: ITab[], assignedTabIds: Set<TTabId>) {
    const nextPanes = panes.map((pane) => ({
        ...pane,
        tabIds: [...pane.tabIds],
    }));
    const fallbackPane = nextPanes[0];
    if (!fallbackPane) {
        return nextPanes;
    }

    for (const tab of tabs) {
        const tabId = parseTabId(tab.id);
        if (tabId === null || assignedTabIds.has(tabId)) {
            continue;
        }
        fallbackPane.tabIds.push(tabId);
        assignedTabIds.add(tabId);
    }

    for (const pane of nextPanes) {
        pane.activeTabId = pane.activeTabId && pane.tabIds.includes(pane.activeTabId) ? pane.activeTabId : (pane.tabIds[0] ?? null);
    }

    return nextPanes;
}

export function isEditorPanesStateNormalized(state: IEditorPanesStateSnapshot) {
    const tabs = collectUniqueTabs(state.tabs);
    if (tabs.hasInvalidTabs || tabs.tabs.length !== state.tabs.length) {
        return false;
    }

    if (state.panes.length === 0) {
        return false;
    }

    const panes = normalizePaneTabIds(state.panes, tabs.tabIds);
    if (panes.hasInvalidPanes || panes.assignedTabIds.size !== tabs.tabIds.size || panes.panes.length !== state.panes.length) {
        return false;
    }

    if (!layoutMatchesPanes(state.layout, panes.paneIds)) {
        return false;
    }

    if (!state.activePaneId || !panes.paneIds.has(state.activePaneId)) {
        return false;
    }

    const nextMru = normalizeActivePaneAndMru(state.activePaneId, state.paneMru, panes.panes, panes.paneIds).paneMru;
    return arraysEqual(state.paneMru, nextMru);
}

export function normalizeEditorPanesState({
    panes,
    tabs,
    layout,
    activePaneId,
    paneMru,
    createPane,
}: INormalizeEditorPanesStateParams): IEditorPanesStateSnapshot {
    const uniqueTabs = collectUniqueTabs(tabs);
    const normalizedPanes = normalizePaneTabIds(panes, uniqueTabs.tabIds);

    if (normalizedPanes.panes.length === 0) {
        const fallbackPane = createPane();
        normalizedPanes.panes.push(fallbackPane);
        normalizedPanes.paneIds.add(fallbackPane.paneId);
    }

    const nextPanes = clonePanesWithUnassignedTabs(normalizedPanes.panes, uniqueTabs.tabs, normalizedPanes.assignedTabIds);
    const freshPaneIds = new Set(nextPanes.map((pane) => pane.paneId));
    const nextLayout = normalizeLayoutForPanes(layout, nextPanes, freshPaneIds);
    const activePaneMru = normalizeActivePaneAndMru(activePaneId, paneMru, nextPanes, freshPaneIds);

    return {
        panes: nextPanes,
        tabs: uniqueTabs.tabs,
        layout: nextLayout,
        activePaneId: activePaneMru.activePaneId,
        paneMru: activePaneMru.paneMru,
    };
}
