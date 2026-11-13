import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDocumentViewportWritePort } from '@app/modules/document-viewer/runtime/documentViewportWritePort';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';

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

        expect(port.apply(container, {
            intent,
            reason: 'test',
            top: 120,
        })).toBe(true);
        expect(consumedDuringSetter).toBe(true);
        expect(port.consumeAuthorityScroll(container)).toBe(true);

        const clampedIntent = port.beginIntent('clamped-navigation');
        expect(port.apply(container, {
            intent: clampedIntent,
            reason: 'test-clamped',
            top: 2_000,
        })).toBe(true);
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
        expect(port.apply(container, {
            intent: preWheelIntent,
            reason: 'stale-after-wheel',
            top: 220,
        })).toBe(false);
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
