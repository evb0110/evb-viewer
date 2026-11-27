import {describe, expect, it} from 'vitest';
import {parseMarkupSubtype} from '@contracts/annotations';

describe('annotation contracts', () => {
    it('normalizes supported markup aliases and rejects non-string boundary values', () => {
        expect(parseMarkupSubtype(' strikethrough ')).toBe('StrikeOut');
        expect(parseMarkupSubtype('unknown')).toBeNull();
        expect(parseMarkupSubtype({subtype: 'Highlight'})).toBeNull();
    });
});
