import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IEditorGroupState,
    TEditorLayoutNode,
} from '@app/types/editor-groups';
import type { ITab } from '@app/types/tabs';
import {
    collectLayoutGroupOrder,
    collectMergeTabOrder,
    shouldCloseSourceWindowAfterTransfer,
} from '@app/composables/page/window-tab-transfer-orchestration';

function createTab(id: string): ITab {
    return {
        id,
        fileName: `${id}.pdf`,
        originalPath: `/tmp/${id}.pdf`,
        isDirty: false,
        isDjvu: false,
    };
}

describe('window tab transfer orchestration helpers', () => {
    it('collects group order by stable layout traversal', () => {
        const layout: TEditorLayoutNode = {
            type: 'split',
            id: 'root',
            orientation: 'horizontal',
            ratio: 0.6,
            first: {
                type: 'leaf',
                groupId: 'group-left',
            },
            second: {
                type: 'split',
                id: 'nested',
                orientation: 'vertical',
                ratio: 0.5,
                first: {
                    type: 'leaf',
                    groupId: 'group-top-right',
                },
                second: {
                    type: 'leaf',
                    groupId: 'group-bottom-right',
                },
            },
        };

        expect(collectLayoutGroupOrder(layout)).toEqual([
            'group-left',
            'group-top-right',
            'group-bottom-right',
        ]);
    });

    it('collects merge tab order by layout order and tab order inside each group', () => {
        const layout: TEditorLayoutNode = {
            type: 'split',
            id: 'root',
            orientation: 'horizontal',
            ratio: 0.5,
            first: {
                type: 'leaf',
                groupId: 'group-a',
            },
            second: {
                type: 'leaf',
                groupId: 'group-b',
            },
        };

        const groups: IEditorGroupState[] = [
            {
                id: 'group-a',
                tabIds: [
                    'tab-1',
                    'tab-2',
                ],
                activeTabId: 'tab-1',
            },
            {
                id: 'group-b',
                tabIds: ['tab-3'],
                activeTabId: 'tab-3',
            },
        ];

        const tabs: ITab[] = [
            createTab('tab-1'),
            createTab('tab-2'),
            createTab('tab-3'),
            createTab('tab-detached'),
        ];

        expect(collectMergeTabOrder(layout, groups, tabs)).toEqual([
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
