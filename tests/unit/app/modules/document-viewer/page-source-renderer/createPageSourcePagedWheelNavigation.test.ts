import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
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
});
