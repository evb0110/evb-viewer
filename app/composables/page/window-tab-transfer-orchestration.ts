import type {
    IEditorGroupState,
    TEditorLayoutNode,
} from '@app/types/editor-groups';
import type { ITab } from '@app/types/tabs';

export function collectLayoutGroupOrder(node: TEditorLayoutNode | null): string[] {
    if (!node) {
        return [];
    }

    if (node.type === 'leaf') {
        return [node.groupId];
    }

    return [
        ...collectLayoutGroupOrder(node.first),
        ...collectLayoutGroupOrder(node.second),
    ];
}

export function collectMergeTabOrder(
    layout: TEditorLayoutNode | null,
    groups: IEditorGroupState[],
    tabs: ITab[],
) {
    const orderedGroupIds = collectLayoutGroupOrder(layout);
    const seenTabIds = new Set<string>();
    const orderedTabIds: string[] = [];

    for (const groupId of orderedGroupIds) {
        const group = groups.find(candidate => candidate.id === groupId);
        if (!group) {
            continue;
        }

        for (const tabId of group.tabIds) {
            if (seenTabIds.has(tabId)) {
                continue;
            }
            seenTabIds.add(tabId);
            orderedTabIds.push(tabId);
        }
    }

    for (const tab of tabs) {
        if (seenTabIds.has(tab.id)) {
            continue;
        }

        seenTabIds.add(tab.id);
        orderedTabIds.push(tab.id);
    }

    return orderedTabIds;
}

export function shouldCloseSourceWindowAfterTransfer(
    tabCountBeforeTransfer: number,
    hasElectronBridge: boolean,
) {
    return hasElectronBridge && tabCountBeforeTransfer <= 1;
}
