import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveVirtualRowRevealScrollTop } from '@app/modules/document-viewer/virtualization/resolveVirtualRowRevealScrollTop';

const rowHeights = [
    36,
    84,
    36,
    84,
] as const;

describe('resolveVirtualRowRevealScrollTop', () => {
    it('moves only by the overflow when the requested span is below the viewport', () => {
        expect(resolveVirtualRowRevealScrollTop({
            rowHeights,
            startIndex: 2,
            endIndex: 3,
            scrollTop: 36,
            clientHeight: 120,
        })).toBe(120);
    });

    it('moves to the span start when it is above the viewport', () => {
        expect(resolveVirtualRowRevealScrollTop({
            rowHeights,
            startIndex: 0,
            endIndex: 1,
            scrollTop: 120,
            clientHeight: 120,
        })).toBe(0);
    });

    it('pins the first row when the requested span is taller than the viewport', () => {
        expect(resolveVirtualRowRevealScrollTop({
            rowHeights,
            startIndex: 1,
            endIndex: 3,
            scrollTop: 0,
            clientHeight: 120,
        })).toBe(36);
    });

    it('leaves a fully visible span in place', () => {
        expect(resolveVirtualRowRevealScrollTop({
            rowHeights,
            startIndex: 1,
            endIndex: 2,
            scrollTop: 20,
            clientHeight: 140,
        })).toBeNull();
    });

    it('normalizes reversed row bounds', () => {
        expect(resolveVirtualRowRevealScrollTop({
            rowHeights,
            startIndex: 3,
            endIndex: 2,
            scrollTop: 36,
            clientHeight: 120,
        })).toBe(120);
    });
});
