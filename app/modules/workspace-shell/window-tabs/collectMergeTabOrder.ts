import type {TEditorLayoutNode} from '@contracts/editorPanes';
import type {ITab} from '@app/types/tabs';
import {uniq} from 'es-toolkit/array';
import {collectLayoutPaneOrder} from '@app/modules/workspace-shell/window-tabs/collectLayoutPaneOrder';

export function collectMergeTabOrder(
    layout: TEditorLayoutNode | null,
    panes: ReadonlyArray<{
        paneId: string;
        tabIds: readonly string[];
    }>,
    tabs: ITab[],
) {
    const orderedPaneIds = collectLayoutPaneOrder(layout);
    const orderedTabIds = orderedPaneIds.flatMap((paneId) => {
        const pane = panes.find((candidate) => candidate.paneId === paneId);
        return pane?.tabIds ?? [];
    });

    return uniq([...orderedTabIds, ...tabs.map((tab) => tab.id)]);
}
