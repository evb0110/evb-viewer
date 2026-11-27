import {describe, expect, it} from 'vitest';
import {pruneStartSectionByTabId} from '@app/modules/workspace-shell/tabs/pruneStartSectionByTabId';

describe('pruneStartSectionByTabId', () => {
    it('removes entries for tabs that no longer exist', () => {
        const current = {
            'tab-1': 'recent',
            'tab-2': 'settings',
            'tab-closed': 'combine',
        } as const;

        expect(pruneStartSectionByTabId(current, [{id: 'tab-1'}, {id: 'tab-2'}])).toEqual({
            'tab-1': 'recent',
            'tab-2': 'settings',
        });
    });

    it('returns the original object when no pruning is needed', () => {
        const current = {
            'tab-1': 'recent',
            'tab-2': 'settings',
        } as const;

        expect(pruneStartSectionByTabId(current, [{id: 'tab-1'}, {id: 'tab-2'}])).toBe(current);
    });
});
