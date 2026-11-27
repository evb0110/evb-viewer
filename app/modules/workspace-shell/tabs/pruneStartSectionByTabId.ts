import type {ITab} from '@app/types/tabs';
import type {TStartSection} from '@app/types/startSection';

export function pruneStartSectionByTabId(startSectionByTabId: Record<string, TStartSection>, tabs: Array<Pick<ITab, 'id'>>) {
    const tabIds = new Set(tabs.map((tab) => tab.id));
    let pruned = false;
    const nextStartSectionByTabId: Record<string, TStartSection> = {};

    for (const [tabId, section] of Object.entries(startSectionByTabId)) {
        if (!tabIds.has(tabId)) {
            pruned = true;
            continue;
        }

        nextStartSectionByTabId[tabId] = section;
    }

    return pruned ? nextStartSectionByTabId : startSectionByTabId;
}
