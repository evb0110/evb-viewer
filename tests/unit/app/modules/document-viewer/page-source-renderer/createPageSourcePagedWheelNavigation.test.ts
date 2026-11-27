import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDocumentViewportWritePort,
    observeDocumentViewportWheelInteraction,
} from '@app/modules/document-viewer/runtime/documentViewportWritePort';
import {createPageSourcePagedWheelNavigation} from '@app/modules/document-viewer/page-source-renderer/createPageSourcePagedWheelNavigation';

function createContainer() {
    return {
        clientHeight: 800,
        scrollTop: 0,
    } as HTMLElement;
}

function createWheelEvent(deltaY: number) {
    const preventDefault = vi.fn();
    return {
        event: {
            deltaX: 0,
            deltaY,
            preventDefault,
        },
        preventDefault,
    };
}

describe('createPageSourcePagedWheelNavigation', () => {
    it('advances sustained wheel packets from its durable cursor while the current-page prop lags', () => {
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const navigation = createPageSourcePagedWheelNavigation(20);
        const container = createContainer();
        const targets: number[] = [];

        for (let packet = 0; packet < 8; packet += 1) {
            now += 220;
            const {
                event,
                preventDefault,
            } = createWheelEvent(180);
            const target = navigation.handle(event, {
                container,
                continuousScroll: false,
                currentPage: 1,
                pageCount: 20,
                pageHeights: Array.from({length: 20}, () => 760),
                viewMode: 'single',
            });
            if (target !== null) targets.push(target);
            expect(preventDefault).toHaveBeenCalledOnce();
        }

        expect(targets).toEqual([
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
        ]);
        vi.restoreAllMocks();
    });

    it('preserves interior scrolling and resets the navigation cursor for explicit commands', () => {
        let now = 1_000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const navigation = createPageSourcePagedWheelNavigation(20);
        const container = createContainer();
        container.scrollTop = 100;
        const {
            event: interiorEvent,
            preventDefault,
        } = createWheelEvent(180);

        expect(navigation.handle(interiorEvent, {
            container,
            continuousScroll: false,
            currentPage: 4,
            pageCount: 20,
            pageHeights: Array.from({length: 20}, () => 1_200),
            viewMode: 'single',
        })).toBeNull();
        expect(preventDefault).not.toHaveBeenCalled();

        navigation.reset();
        container.scrollTop = 0;
        now += 1_000;
        expect(navigation.handle(createWheelEvent(-180).event, {
            container,
            continuousScroll: false,
            currentPage: 4,
            pageCount: 20,
            pageHeights: Array.from({length: 20}, () => 760),
            viewMode: 'single',
        })).toBe(3);
        vi.restoreAllMocks();
    });

    it('flips by only one page on a single small smooth inertial scroll with diagonal jitter', () => {
        const navigation = createPageSourcePagedWheelNavigation(20);
        const container = createContainer();
        const state = {
            container,
            continuousScroll: false,
            currentPage: 1,
            pageCount: 20,
            pageHeights: Array.from({length: 20}, () => 760),
            viewMode: 'single' as const,
        };
        const targets: number[] = [];

        // Decaying smooth burst lasting 360ms (> 180ms cooldown) plus mid-gesture diagonal jitter.
        const packets = [
            {timeStamp: 0, deltaX: 0, deltaY: 36},
            {timeStamp: 20, deltaX: 10, deltaY: 2},
            {timeStamp: 40, deltaX: 0, deltaY: 28},
            {timeStamp: 120, deltaX: 0, deltaY: 16},
            {timeStamp: 200, deltaX: 0, deltaY: 8},
            {timeStamp: 280, deltaX: 0, deltaY: 4},
            {timeStamp: 360, deltaX: 0, deltaY: 2},
        ];
        for (const packet of packets) {
            const preventDefault = vi.fn();
            const target = navigation.handle({
                ...packet,
                cancelable: true,
                preventDefault,
            }, state);
            if (target !== null) targets.push(target);
            expect(preventDefault).toHaveBeenCalledOnce();
        }
        expect(targets).toEqual([2]);

        // After a quiet gap (>= 200ms), another small scroll flips to page 3.
        const nextPreventDefault = vi.fn();
        expect(navigation.handle({
            timeStamp: 600,
            deltaX: 0,
            deltaY: 36,
            cancelable: true,
            preventDefault: nextPreventDefault,
        }, state)).toBe(3);
        expect(nextPreventDefault).toHaveBeenCalledOnce();
    });

    it('ignores horizontal-dominant line-mode wheel input when normalized vertical pixels exceed raw deltaX', () => {
        const navigation = createPageSourcePagedWheelNavigation(20);
        const container = createContainer();
        const preventDefault = vi.fn();

        // Line mode: deltaX=2 lines, deltaY=1 line -> normalized vertical deltaPx=16.
        // Raw axis comparison must classify this as horizontal-dominant and not turn a page.
        expect(navigation.handle({
            cancelable: true,
            deltaMode: 1,
            deltaX: 2,
            deltaY: 1,
            timeStamp: 100,
            preventDefault,
        }, {
            container,
            continuousScroll: false,
            currentPage: 1,
            pageCount: 20,
            pageHeights: Array.from({length: 20}, () => 760),
            viewMode: 'single',
        }, 16)).toBeNull();
        expect(preventDefault).not.toHaveBeenCalled();
    });

    it('advances pages on repeated 1-line wheel notches spaced 100ms apart', () => {
        const navigation = createPageSourcePagedWheelNavigation(20);
        const container = createContainer();
        const state = {
            container,
            continuousScroll: false,
            currentPage: 1,
            pageCount: 20,
            pageHeights: Array.from({length: 20}, () => 760),
            viewMode: 'single' as const,
        };
        const targets: number[] = [];

        for (let index = 0; index < 16; index += 1) {
            const target = navigation.handle({
                cancelable: true,
                deltaMode: 1,
                deltaX: 0,
                deltaY: 1,
                timeStamp: index * 100,
                preventDefault: vi.fn(),
            }, state, 16);
            if (target !== null) targets.push(target);
        }
        expect(targets.length).toBeGreaterThanOrEqual(5);
    });

    it('keeps a cancelable tail fenced across a >200ms gap while the viewport write port reports an open host sequence', () => {
        const port = createDocumentViewportWritePort();
        const navigation = createPageSourcePagedWheelNavigation(20);
        const container = createContainer();
        container.scrollTop = 0;

        const makeEvent = (timeStamp: number, deltaY: number) => {
            const event = {
                cancelable: true,
                clientX: 100,
                clientY: 100,
                defaultPrevented: false,
                deltaMode: 0,
                deltaX: 0,
                deltaY,
                timeStamp,
                preventDefault: vi.fn(() => {
                    event.defaultPrevented = true;
                }),
            };
            return event;
        };

        // 1. Interior scroll starts the host sequence unprevented.
        const interiorEvent = makeEvent(0, 40);
        observeDocumentViewportWheelInteraction(port, {
            deltaPx: 40,
            event: interiorEvent,
            intent: 'scroll',
        }, container);
        expect(navigation.handle(interiorEvent, {
            container,
            continuousScroll: false,
            currentPage: 1,
            pageCount: 20,
            pageHeights: Array.from({length: 20}, () => 1_200),
            viewMode: 'single',
        }, 40)).toBeNull();
        port.observeWheelScrollSequence('begin');

        // 2. Reaching the page edge flips once to page 2.
        container.scrollTop = 440;
        const flipEvent = makeEvent(40, 120);
        observeDocumentViewportWheelInteraction(port, {
            deltaPx: 120,
            event: flipEvent,
            intent: 'scroll',
        }, container);
        expect(navigation.handle(flipEvent, {
            container,
            continuousScroll: false,
            currentPage: 1,
            pageCount: 20,
            pageHeights: Array.from({length: 20}, () => 1_200),
            viewMode: 'single',
        }, 120)).toBe(2);

        // 3. A cancelable decaying tail after a 260ms gap stays blocked while the host sequence is open.
        const delayedTailEvent = makeEvent(300, 60);
        observeDocumentViewportWheelInteraction(port, {
            deltaPx: 60,
            event: delayedTailEvent,
            intent: 'scroll',
        }, container);
        expect(navigation.handle(delayedTailEvent, {
            container,
            continuousScroll: false,
            currentPage: 2,
            pageCount: 20,
            pageHeights: Array.from({length: 20}, () => 760),
            viewMode: 'single',
        }, 60)).toBeNull();
        expect(delayedTailEvent.preventDefault).toHaveBeenCalledOnce();

        // 4. Once the host closes the sequence, a new gesture after the quiet gap flips to page 3.
        port.observeWheelScrollSequence('end');
        const nextGestureEvent = makeEvent(560, 120);
        observeDocumentViewportWheelInteraction(port, {
            deltaPx: 120,
            event: nextGestureEvent,
            intent: 'scroll',
        }, container);
        expect(navigation.handle(nextGestureEvent, {
            container,
            continuousScroll: false,
            currentPage: 2,
            pageCount: 20,
            pageHeights: Array.from({length: 20}, () => 760),
            viewMode: 'single',
        }, 120)).toBe(3);
    });
});
