// @vitest-environment happy-dom

import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDocumentViewportWritePort} from '@app/modules/document-viewer/runtime/documentViewportWritePort';
import {WHEEL_GESTURE_IDLE_MS} from '@app/modules/document-viewer/input/createWheelGestureStream';
import {createTestPdfViewportWritePort} from '@tests/helpers/createTestPdfViewportWritePort';

describe('PDF viewport write port ownership tags', () => {
    it('fences a synchronous scroll event raised by the DOM setter', () => {
        const port = createDocumentViewportWritePort();
        let scrollTop = 0;
        let consumedDuringSetter: boolean | null = null;
        // The port only observes scroll geometry and the scrollTop setter in
        // this unit. Keep the rest of HTMLElement out of the fixture.
        const container = {
            scrollLeft: 0,
            scrollHeight: 1_000,
            clientHeight: 100,
            get scrollTop() {
                return scrollTop;
            },
            set scrollTop(value: number) {
                scrollTop = value;
                consumedDuringSetter = port.consumeAuthorityScroll(container);
            },
        } as HTMLElement;
        const intent = port.beginIntent('synchronous-navigation');

        expect(
            port.apply(container, {
                intent,
                reason: 'test',
                top: 120,
            }),
        ).toBe(true);
        expect(consumedDuringSetter).toBe(true);
        expect(port.consumeAuthorityScroll(container)).toBe(true);

        const clampedIntent = port.beginIntent('clamped-navigation');
        expect(
            port.apply(container, {
                intent: clampedIntent,
                reason: 'test-clamped',
                top: 2_000,
            }),
        ).toBe(true);
        expect(scrollTop).toBe(900);
        expect(consumedDuringSetter).toBe(true);
        expect(port.consumeAuthorityScroll(container)).toBe(true);
    });

    it('consumes an authority-authored scroll burst and rejects drift as user input', () => {
        const container = {
            scrollLeft: 0,
            scrollTop: 0,
        } as HTMLElement;
        const port = createDocumentViewportWritePort();
        expect(port.getInteractionEpoch()).toBe(0);
        const firstIntent = port.beginIntent('navigation-1');
        port.apply(container, {
            intent: firstIntent,
            reason: 'test',
            top: 120,
        });
        expect(port.consumeAuthorityScroll(container)).toBe(true);
        expect(port.consumeAuthorityScroll(container)).toBe(true);

        const secondIntent = port.beginIntent('navigation-2');
        port.apply(container, {
            intent: secondIntent,
            reason: 'test',
            top: 180,
        });
        container.scrollTop = 181;
        expect(port.consumeAuthorityScroll(container)).toBe(false);
        port.observeUserScroll(container);
        expect(port.getInteractionEpoch()).toBe(1);

        const preWheelIntent = port.beginIntent('pre-wheel-layout-restore');
        port.observeUserInteraction(container);
        expect(port.getInteractionEpoch()).toBe(2);
        expect(port.consumeAuthorityScroll(container)).toBe(false);
        expect(
            port.apply(container, {
                intent: preWheelIntent,
                reason: 'stale-after-wheel',
                top: 220,
            }),
        ).toBe(false);
    });
});

function tailPacket(timeStamp: number, cancelable = false) {
    return {
        timeStamp,
        deltaX: 0,
        deltaY: 40,
        cancelable,
    };
}

function createScrollContainer() {
    return {
        scrollLeft: 0,
        scrollTop: 0,
    } as HTMLElement;
}

describe('PDF viewport write port retirement', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('stops the residue timer and the restore chain and settles when its view closes mid-fling', () => {
        vi.useFakeTimers();
        const port = createDocumentViewportWritePort();
        // Chromium sends a sequence's first packet cancelable, its tail not.
        port.observeWheelPacket(tailPacket(0, true));
        port.observeWheelPacket(tailPacket(16));
        port.fenceCommandAgainstLiveGesture(30);
        expect(port.userScrollSuppressed.value).toBe(true);
        // The idle timer restores scrolling and starts the settle chain; a
        // later tail packet suppresses again and re-arms the idle timer.
        vi.advanceTimersByTime(WHEEL_GESTURE_IDLE_MS);
        expect(port.userScrollSuppressed.value).toBe(false);
        port.observeWheelPacket(tailPacket(WHEEL_GESTURE_IDLE_MS + 40));
        expect(port.userScrollSuppressed.value).toBe(true);
        expect(port.isCommandResidueLive()).toBe(true);
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        port.retire();

        expect(vi.getTimerCount()).toBe(0);
        vi.runAllTimers();
        expect(vi.getTimerCount()).toBe(0);
        expect(port.userScrollSuppressed.value).toBe(false);
        expect(port.isCommandResidueLive()).toBe(false);
    });

    it('stops a settle chain that is still waiting for its frames', () => {
        vi.useFakeTimers();
        const port = createDocumentViewportWritePort();
        port.observeWheelPacket(tailPacket(0, true));
        port.observeWheelPacket(tailPacket(8));
        port.fenceCommandAgainstLiveGesture(10);
        expect(port.userScrollSuppressed.value).toBe(true);
        port.observeWheelScrollSequence('begin');
        port.observeWheelScrollSequence('end');
        expect(port.userScrollSuppressed.value).toBe(false);
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        port.retire();

        expect(vi.getTimerCount()).toBe(0);
        // Settled: a new gesture is not mistaken for one the viewer must
        // scroll by hand.
        expect(port.observeWheelPacket(tailPacket(500, true))).toBe('user-input');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('refuses every write after retirement without throwing', () => {
        vi.useFakeTimers();
        const port = createDocumentViewportWritePort();
        const container = createScrollContainer();
        const pending = port.beginIntent('navigate:3');
        expect(
            port.apply(container, {
                intent: pending,
                reason: 'navigation',
                top: 100,
            }),
        ).toBe(true);

        port.retire();

        expect(port.consumeAuthorityScroll(container)).toBe(false);
        expect(
            port.apply(container, {
                intent: pending,
                reason: 'late-navigation',
                top: 200,
            }),
        ).toBe(false);
        const late = port.beginIntent('late-restore');
        expect(
            port.apply(container, {
                intent: late,
                reason: 'late-restore',
                top: 300,
            }),
        ).toBe(false);
        expect(container.scrollTop).toBe(100);

        const epoch = port.getInteractionEpoch();
        port.observeUserInteraction(container);
        port.observeUserScroll(container);
        port.observeZoomPacket(tailPacket(600, true), container);
        port.observeWheelScrollSequence('begin');
        port.fenceCommandAgainstLiveGesture(700);
        expect(port.observeWheelPacket(tailPacket(710))).toBe('user-input');
        expect(port.getInteractionEpoch()).toBe(epoch);
        expect(port.userScrollSuppressed.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('PDF viewport write port source identity', () => {
    it('rejects an intent begun for a source that has since been replaced', () => {
        let source: object | null = {name: 'first'};
        const port = createDocumentViewportWritePort({readSource: () => source});
        const container = createScrollContainer();
        const beforeSwap = port.beginIntent('restore-before-swap');

        source = {name: 'second'};

        expect(
            port.apply(container, {
                intent: beforeSwap,
                reason: 'restore-before-swap',
                top: 100,
            }),
        ).toBe(false);
        expect(container.scrollTop).toBe(0);
        expect(
            port.apply(container, {
                intent: port.beginIntent('restore-after-swap'),
                reason: 'restore-after-swap',
                top: 120,
            }),
        ).toBe(true);
        expect(container.scrollTop).toBe(120);
    });

    it('treats a port without a source as one fixed content', () => {
        const port = createDocumentViewportWritePort();
        const container = createScrollContainer();
        const intent = port.beginIntent('thumbnail-press');

        expect(intent.source).toBeNull();
        expect(
            port.apply(container, {
                intent,
                reason: 'thumbnail-press',
                top: 40,
            }),
        ).toBe(true);
    });
});

describe('shared test PDF viewport write port', () => {
    it('models user interaction superseding an existing intent', () => {
        const {port} = createTestPdfViewportWritePort();
        const beforeInteraction = port.beginIntent('before-interaction');

        port.observeUserInteraction();

        expect(port.getInteractionEpoch()).toBe(1);
        expect(beforeInteraction.interactionEpoch).toBe(0);
        expect(port.beginIntent('after-interaction').interactionEpoch).toBe(1);
    });
});
