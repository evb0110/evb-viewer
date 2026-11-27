import {describe, expect, it} from 'vitest';
import {withNodeHeap, withTypecheckNodeHeap} from '@scripts/typecheckNodeEnv.mjs';

describe('withTypecheckNodeHeap', () => {
    it('adds a repository default heap ceiling for typecheck child processes', () => {
        expect(withTypecheckNodeHeap({PATH: '/bin'})).toEqual({
            PATH: '/bin',
            NODE_OPTIONS: '--max-old-space-size=4096',
        });
    });

    it('preserves caller Node options and an explicit heap ceiling', () => {
        expect(withTypecheckNodeHeap({NODE_OPTIONS: '--trace-warnings'}).NODE_OPTIONS).toBe('--trace-warnings --max-old-space-size=4096');
        expect(withTypecheckNodeHeap({NODE_OPTIONS: '--max-old-space-size=6144 --trace-warnings'}).NODE_OPTIONS).toBe(
            '--max-old-space-size=6144 --trace-warnings',
        );
    });

    it('exposes the same heap policy to other Node-heavy validation tools', () => {
        expect(withNodeHeap({PATH: '/bin'})).toEqual({
            NODE_OPTIONS: '--max-old-space-size=4096',
            PATH: '/bin',
        });
        expect(withNodeHeap({}, 6144).NODE_OPTIONS).toBe('--max-old-space-size=6144');
    });
});
