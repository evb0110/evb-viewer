import {
    describe,
    expect,
    it,
} from 'vitest';
import {withOriginalPathMutationLock} from '@electron/file-access/withOriginalPathMutationLock';

describe('withOriginalPathMutationLock', () => {
    it('serializes distinct working-copy saves targeting the same original', async () => {
        const order: string[] = [];
        let releaseFirst!: () => void;
        const gate = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        const first = withOriginalPathMutationLock('/tmp/shared.pdf', async () => {
            order.push('first:start');
            await gate;
            order.push('first:end');
        });
        const second = withOriginalPathMutationLock('/tmp/shared.pdf', async () => {
            order.push('second:start');
            order.push('second:end');
        });
        await Promise.resolve();
        expect(order).toEqual(['first:start']);
        releaseFirst();
        await Promise.all([
            first,
            second,
        ]);
        expect(order).toEqual([
            'first:start',
            'first:end',
            'second:start',
            'second:end',
        ]);
    });

    it('does not serialize unrelated originals', async () => {
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const first = withOriginalPathMutationLock('/tmp/a.pdf', async () => {
            order.push('a');
            await gate;
        });
        const second = withOriginalPathMutationLock('/tmp/b.pdf', async () => {
            order.push('b');
        });
        await second;
        expect(order).toEqual([
            'a',
            'b',
        ]);
        release();
        await first;
    });
});
