import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import { requirePaneId } from '@contracts/editorPanes';
import { requireTabId } from '@contracts/windowTabs';
import type { ITab } from '@app/types/tabs';
import { collectLayoutPaneOrder } from '@app/modules/workspace-shell/window-tabs/collectLayoutPaneOrder';
import { collectMergeTabOrder } from '@app/modules/workspace-shell/window-tabs/collectMergeTabOrder';
import { shouldCloseSourceWindowAfterTransfer } from '@app/modules/workspace-shell/window-tabs/shouldCloseSourceWindowAfterTransfer';

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
});
