import {describe, expect, it} from 'vitest';
import {safeJsonParse} from '@contracts/safeJsonParse';

describe('safeJsonParse', () => {
    it('parses valid JSON values', () => {
        expect(safeJsonParse('{"version":2}')).toEqual({version: 2});
        expect(safeJsonParse('[1,2,3]')).toEqual([1, 2, 3]);
        expect(safeJsonParse('"plain"')).toBe('plain');
    });

    it.each([['[foo'], ['undefined'], ['NaN'], ['Infinity']])('rejects invalid JSON input %s', (source) => {
        expect(() => safeJsonParse(source)).toThrow(SyntaxError);
    });

    it.each([
        ['{"__proto__":{"polluted":true}}'],
        ['{"\\u005f\\u005fproto\\u005f\\u005f":{"polluted":true}}'],
        ['{"constructor":{"prototype":{"polluted":true}}}'],
    ])('rejects unsafe JSON key payload %s', (source) => {
        expect(() => safeJsonParse(source)).toThrow(SyntaxError);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('allows plain constructor data without a prototype payload', () => {
        expect(safeJsonParse('{"constructor":"plain"}')).toEqual({constructor: 'plain'});
    });

    it('narrows parsed values with a validator overload', () => {
        const isVersionPayload = (value: unknown): value is {version: number} =>
            typeof value === 'object' && value !== null && 'version' in value && typeof value.version === 'number';

        expect(safeJsonParse('{"version":2}', isVersionPayload).version).toBe(2);
        expect(() => safeJsonParse('{"version":"2"}', isVersionPayload)).toThrow(SyntaxError);
    });
});
