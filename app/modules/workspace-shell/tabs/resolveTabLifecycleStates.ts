import type { TTabMemoryPolicy } from '@contracts/shared';
import type { IEditorPaneState } from '@contracts/editorPanes';
import { parseTabId } from '@contracts/windowTabs';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import type { ITab } from '@app/types/tabs';
import type {
    ITabLifecycleState,
    TTabTemperature,
} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import {
    isTabTemperatureReclaimCandidate,
    resolveTabTemperatureResidency,
} from '@app/modules/workspace-shell/memory/viewerResidencyPolicy';

export function resolveTabLifecycleStates(options: {
    tabs: ITab[];
    /** Tabs with unsaved changes stay mounted so they can be saved. */
    dirtyTabIds: ReadonlySet<string>;
    panes: IEditorPaneState[];
    activationOrder: string[];
    policy: TTabMemoryPolicy;
    tier: THostResourceTier;
    targetWarmViewers: number;
}): ITabLifecycleState[] {
    const tierWarmCap = options.tier === 'low' ? 1 : Number.POSITIVE_INFINITY;
    const warmCount = options.policy === 'conservative'
        ? Math.min(options.targetWarmViewers, tierWarmCap)
        : 0;
    const tabIds = new Set(options.tabs.flatMap((tab) => {
        const tabId = parseTabId(tab.id);
        return tabId === null ? [] : [tabId];
    }));
    const visibleTabIds = new Set(
        options.panes.flatMap(pane => pane.activeTabId ? [pane.activeTabId] : []),
    );
    const recentWarmTabIds = options.activationOrder
        .flatMap((tabId) => {
            const parsedTabId = parseTabId(tabId);
            return parsedTabId !== null ? [parsedTabId] : [];
        })
        .filter(tabId => tabIds.has(tabId) && !visibleTabIds.has(tabId))
        .slice(0, warmCount);
    const warmTabIds = new Set([...recentWarmTabIds]);

    return options.tabs.map((tab) => {
        const tabId = parseTabId(tab.id);
        const isHot = tabId !== null && visibleTabIds.has(tabId);
        const isSaveProtected = options.dirtyTabIds.has(tab.id);
        const isWarm = !isHot && (tabId !== null && warmTabIds.has(tabId) || isSaveProtected);
        const temperature: TTabTemperature = isHot ? 'hot' : isWarm ? 'warm' : 'cold';

        return {
            tabId: tab.id,
            temperature,
            viewerResidency: resolveTabTemperatureResidency(temperature),
            isReclaimCandidate: isTabTemperatureReclaimCandidate(temperature, { isSaveProtected }),
            shouldMountHost: temperature !== 'cold',
        };
    });
}
