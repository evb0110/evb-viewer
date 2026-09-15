import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createDocumentTransitionChannel,
    type IDocumentTransition,
} from '@app/modules/document-viewer/lifecycle/createDocumentTransitionChannel';

interface ITestTransition extends IDocumentTransition<number> {readonly kind: 'open';}

describe('createDocumentTransitionChannel', () => {
    it('rechecks the owner fence between serial subscribers', async () => {
        let currentFence = 1;
        const channel = createDocumentTransitionChannel<number, ITestTransition>(
            fence => fence === currentFence,
        );
        const order: string[] = [];
        channel.subscribe(async (transition) => {
            order.push('first:start');
            await Promise.resolve();
            order.push('first:end');
            currentFence = 2;
            expect(transition.isCurrent()).toBe(false);
        });
        channel.subscribe(() => {
            order.push('second');
        });

        await expect(channel.publish({
            kind: 'open',
            fence: 1,
        })).resolves.toBe(false);
        expect(order).toEqual([
            'first:start',
            'first:end',
        ]);
    });

    it('treats disposal as cancellation for pending transitions', async () => {
        const channel = createDocumentTransitionChannel<number, ITestTransition>(() => true);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        channel.subscribe(() => gate);

        const committed = channel.publish({
            kind: 'open',
            fence: 1,
        });
        channel.dispose();
        release();
        await expect(committed).resolves.toBe(false);
    });
});
