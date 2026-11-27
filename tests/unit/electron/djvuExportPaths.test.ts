import {EventEmitter} from 'node:events';
import {describe, expect, it} from 'vitest';
import {resolve} from 'path';
import {allowDjvuWritePath, consumeAllowedDjvuWritePath} from '@electron/features/djvu/main/exportPaths';

describe('djvu/exportPaths', () => {
    it('allows consuming a sender-owned PDF path', () => {
        const filePath = './tmp-djvu-export.pdf';
        const absolutePath = resolve(filePath);

        allowDjvuWritePath(filePath, 10);

        expect(consumeAllowedDjvuWritePath(absolutePath, 10)).toBe(absolutePath);
        expect(consumeAllowedDjvuWritePath(absolutePath, 10)).toBeNull();
    });

    it('keeps sender-owned grants scoped to the creating sender', () => {
        const filePath = './tmp-djvu-cross-sender-export.pdf';
        const absolutePath = resolve(filePath);

        allowDjvuWritePath(filePath, 10);

        expect(consumeAllowedDjvuWritePath(absolutePath, 11)).toBeNull();
        expect(consumeAllowedDjvuWritePath(absolutePath, 10)).toBe(absolutePath);
    });

    it('preserves shared grants for existing callers without an owner', () => {
        const filePath = './tmp-djvu-shared-export.pdf';
        const absolutePath = resolve(filePath);

        allowDjvuWritePath(filePath);

        expect(consumeAllowedDjvuWritePath(absolutePath, 10)).toBe(absolutePath);
    });

    it('removes sender-owned grants when the sender is destroyed', () => {
        const filePath = './tmp-djvu-destroyed-sender-export.pdf';
        const absolutePath = resolve(filePath);
        const sender = new EventEmitter() as EventEmitter & {id: number};
        sender.id = 12;

        allowDjvuWritePath(filePath, sender as never);
        sender.emit('destroyed');

        expect(consumeAllowedDjvuWritePath(absolutePath, 12)).toBeNull();
    });

    it('removes sender-owned grants on main-frame navigation', () => {
        const filePath = './tmp-djvu-navigated-sender-export.pdf';
        const absolutePath = resolve(filePath);
        const sender = new EventEmitter() as EventEmitter & {id: number};
        sender.id = 13;

        allowDjvuWritePath(filePath, sender as never);
        sender.emit('did-start-navigation', {}, 'https://example.test/', false, true);

        expect(consumeAllowedDjvuWritePath(absolutePath, 13)).toBeNull();
    });
});
