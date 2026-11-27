import {describe, expect, it} from 'vitest';
import {resolveEditorPaneSplitBounds} from '@app/modules/workspace-shell/layout/resolveEditorPaneSplitBounds';

describe('resolveEditorPaneSplitBounds', () => {
    it('uses pixel-derived ratio limits when both panes can remain usable', () => {
        const result = resolveEditorPaneSplitBounds(1000);
        expect(result.minRatio).toBeCloseTo(0.32);
        expect(result.maxRatio).toBeCloseTo(0.68);
        expect(result.ultraCompact).toBe(false);
    });

    it('enters an explicit equal-width ultra-compact mode below two pane minima', () => {
        expect(resolveEditorPaneSplitBounds(600)).toEqual({
            minRatio: 0.5,
            maxRatio: 0.5,
            ultraCompact: true,
        });
    });

    it('retains safe legacy bounds until a container has been measured', () => {
        expect(resolveEditorPaneSplitBounds(0)).toEqual({
            minRatio: 0.15,
            maxRatio: 0.85,
            ultraCompact: false,
        });
    });
});
