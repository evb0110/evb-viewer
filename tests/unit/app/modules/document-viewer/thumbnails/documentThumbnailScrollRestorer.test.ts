// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {nextTick} from 'vue';
import {createDocumentThumbnailScrollRestorer} from '@app/modules/document-viewer/thumbnails/createDocumentThumbnailScrollRestorer';

interface IClampedContainer {
    container: HTMLElement;
    setMaxScrollTop: (value: number) => void;
}

const pendingFrames: FrameRequestCallback[] = [];

function createClampedContainer(): IClampedContainer {
    const container = document.createElement('div');
    let maxScrollTop = 100;
    let scrollTop = 0;
    Object.defineProperty(container, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = Math.min(Math.max(0, value), maxScrollTop);
        },
    });
    return {
        container,
        setMaxScrollTop: value => {
            maxScrollTop = value;
        },
    };
}

function flushFrame() {
    const callbacks = pendingFrames.splice(0);
    callbacks.forEach(callback => callback(0));
}

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        pendingFrames.push(callback);
        return pendingFrames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
    pendingFrames.splice(0);
    vi.unstubAllGlobals();
});

describe('document thumbnail scroll restoration', () => {
    it.each([
        'source',
        'pdf',
    ])('retries the %s rail after an initial scrollTop clamp and later geometry growth', async (_rail) => {
        const {
            container,
            setMaxScrollTop,
        } = createClampedContainer();
        const applied: number[] = [];
        const restorer = createDocumentThumbnailScrollRestorer({
            applyScrollTop: (currentContainer, target) => {
                applied.push(target);
                currentContainer.scrollTop = target;
            },
            getContainer: () => container,
        });

        container.scrollTop = 500;
        restorer.schedule(500);
        expect(container.scrollTop).toBe(100);
        await nextTick();
        expect(container.scrollTop).toBe(100);

        setMaxScrollTop(600);
        flushFrame();
        await nextTick();

        expect(container.scrollTop).toBe(500);
        expect(applied).toEqual([500]);
        restorer.cancel();
    });

    it('retries while the rail is detached and restores after it remounts', async () => {
        const {
            container,
            setMaxScrollTop,
        } = createClampedContainer();
        setMaxScrollTop(600);
        let containerReads = 0;
        const restorer = createDocumentThumbnailScrollRestorer({
            applyScrollTop: (targetContainer, target) => {
                targetContainer.scrollTop = target;
            },
            getContainer: () => containerReads++ === 0 ? null : container,
        });

        restorer.schedule(500);
        await nextTick();
        await nextTick();
        flushFrame();
        await nextTick();
        await nextTick();
        flushFrame();
        await nextTick();
        await nextTick();
        flushFrame();
        await nextTick();

        expect(container.scrollTop).toBe(500);
        restorer.cancel();
    });
});
