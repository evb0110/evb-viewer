import {
    describe,
    expect,
    it,
} from 'vitest';

describe('vitest smoke test', () => {
    it('can run a basic assertion', () => {
        expect(1 + 1).toBe(2);
    });
});
