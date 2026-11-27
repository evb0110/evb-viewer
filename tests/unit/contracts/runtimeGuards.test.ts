import {describe, expect, it} from 'vitest';
import {isErrnoException} from '@contracts/runtimeGuards';

describe('isErrnoException', () => {
    it('accepts native errors and serialized errno records with typed fields', () => {
        expect(isErrnoException(Object.assign(new Error('missing'), {code: 'ENOENT'}))).toBe(true);
        expect(
            isErrnoException({
                code: 'ENOENT',
                errno: -2,
                path: '/tmp/missing.pdf',
                syscall: 'open',
            }),
        ).toBe(true);
        expect(isErrnoException({code: 2})).toBe(true);
    });

    it.each([
        null,
        {},
        {code: null},
        {code: {}},
        {
            code: 'ENOENT',
            errno: '2',
        },
        {
            code: 'ENOENT',
            path: 42,
        },
        {
            code: 'ENOENT',
            syscall: false,
        },
    ])('rejects malformed errno-like values (%j)', (value) => {
        expect(isErrnoException(value)).toBe(false);
    });
});
