import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    canScrollWithinPageBounds,
    hasScrollablePageBounds,
    isWithinPageScrollBoundsInterior,
    resolveNextTopWithinPageBounds,
    resolveWheelDirection,
    resolveWheelTargetAnchor,
    resolveWheelTargetPage,
    shouldHandleSinglePageWheel,
} from '@app/modules/document-viewer/single-page-wheel/singlePageWheelNavigation';
import { resolveDocumentWheelInteraction } from '@app/modules/document-viewer/input/documentWheelInteraction';

function createWheelEvent(options?: {
    ctrlKey?: boolean;
    deltaX?: number;
    deltaY?: number;
    metaKey?: boolean;
}): WheelEvent {
    // Wheel normalization reads only these event fields in this unit.
    return {
        ctrlKey: options?.ctrlKey ?? false,
        deltaMode: 0,
        deltaX: options?.deltaX ?? 0,
        deltaY: options?.deltaY ?? 120,
        deltaZ: 0,
        metaKey: options?.metaKey ?? false,
    } as WheelEvent;
}

function createContainer(scrollTop = 0): HTMLElement {
    // Single-page wheel handling reads only scrollTop from this container.
    return {scrollTop} as HTMLElement;
}

function createWheelContainer(): HTMLElement {
    // Wheel normalization reads only clientHeight from this container.
    return {clientHeight: 800} as HTMLElement;
}

function createWheelInteraction(options?: {
    ctrlKey?: boolean;
    deltaX?: number;
    deltaY?: number;
    metaKey?: boolean;
}) {
    return resolveDocumentWheelInteraction(createWheelEvent(options), createWheelContainer(), false);
}

describe('singlePageWheelNavigation', () => {
    describe('shouldHandleSinglePageWheel', () => {
        it('ignores wheel packets when single-page wheel handling is unavailable', () => {
            const event = createWheelInteraction();
            const container = createContainer();

            expect(shouldHandleSinglePageWheel(event, container, true, true, false, 3)).toBe(false);
            expect(shouldHandleSinglePageWheel(event, container, true, false, true, 3)).toBe(false);
            expect(shouldHandleSinglePageWheel(event, container, false, false, false, 3)).toBe(false);
            expect(shouldHandleSinglePageWheel(event, null, true, false, false, 3)).toBe(false);
            expect(shouldHandleSinglePageWheel(event, container, true, false, false, 0)).toBe(false);
        });

        it('ignores zoom gestures and wheel packets without vertical delta', () => {
            const container = createContainer();

            expect(shouldHandleSinglePageWheel(
                createWheelInteraction({ ctrlKey: true }),
                container,
                true,
                false,
                false,
                3,
            )).toBe(false);
            expect(shouldHandleSinglePageWheel(
                createWheelInteraction({ metaKey: true }),
                container,
                true,
                false,
                false,
                3,
            )).toBe(false);
            expect(shouldHandleSinglePageWheel(
                createWheelInteraction({ deltaY: 0 }),
                container,
                true,
                false,
                false,
                3,
            )).toBe(false);
        });

        it('rejects horizontal intent while allowing vertical and diagonal vertical intent', () => {
            const container = createContainer();

            expect(shouldHandleSinglePageWheel(
                createWheelInteraction({
                    deltaX: 150,
                    deltaY: 120,
                }),
                container,
                true,
                false,
                false,
                3,
            )).toBe(false);
            expect(shouldHandleSinglePageWheel(
                createWheelInteraction({
                    deltaX: 120,
                    deltaY: 120,
                }),
                container,
                true,
                false,
                false,
                3,
            )).toBe(true);
            expect(shouldHandleSinglePageWheel(
                createWheelInteraction({
                    deltaX: 80,
                    deltaY: 120,
                }),
                container,
                true,
                false,
                false,
                3,
            )).toBe(true);
        });
    });

    it('resolves wheel direction from normalized wheel delta', () => {
        expect(resolveWheelDirection(12)).toBe(1);
        expect(resolveWheelDirection(-12)).toBe(-1);
    });

    it('detects whether a tall page can scroll farther within its bounds', () => {
        const bounds = {
            min: 10,
            max: 110,
        };

        expect(hasScrollablePageBounds(bounds)).toBe(true);
        expect(hasScrollablePageBounds({
            min: 10,
            max: 11,
        })).toBe(false);
        expect(canScrollWithinPageBounds(createContainer(50), bounds, 1)).toBe(true);
        expect(canScrollWithinPageBounds(createContainer(50), bounds, -1)).toBe(true);
        expect(canScrollWithinPageBounds(createContainer(109), bounds, 1)).toBe(false);
        expect(canScrollWithinPageBounds(createContainer(11), bounds, -1)).toBe(false);
        expect(isWithinPageScrollBoundsInterior(createContainer(50), bounds)).toBe(true);
        expect(isWithinPageScrollBoundsInterior(createContainer(109), bounds)).toBe(false);
    });

    it('clamps the next scroll top within tall-page bounds', () => {
        const bounds = {
            min: 10,
            max: 110,
        };

        expect(resolveNextTopWithinPageBounds(createContainer(100), bounds, 50, 1)).toBe(110);
        expect(resolveNextTopWithinPageBounds(createContainer(20), bounds, -50, -1)).toBe(10);
        expect(resolveNextTopWithinPageBounds(createContainer(40), bounds, 30, 1)).toBe(70);
        expect(resolveNextTopWithinPageBounds(createContainer(40), bounds, -20, -1)).toBe(20);
    });

    it('moves one page in single-page mode and one spread in facing modes', () => {
        expect(resolveWheelTargetPage(2, 'single', 5, 1)).toBe(3);
        expect(resolveWheelTargetPage(2, 'single', 5, -1)).toBe(1);
        expect(resolveWheelTargetPage(1, 'facing', 6, 1)).toBe(3);
        expect(resolveWheelTargetPage(4, 'facing', 6, -1)).toBe(1);
        expect(resolveWheelTargetPage(1, 'facing-first-single', 6, 1)).toBe(2);
        expect(resolveWheelTargetPage(4, 'facing-first-single', 6, -1)).toBe(2);
    });

    it('selects directional anchors only for tall target pages', () => {
        expect(resolveWheelTargetAnchor(true, 1)).toBe('top');
        expect(resolveWheelTargetAnchor(true, -1)).toBe('bottom');
        expect(resolveWheelTargetAnchor(false, 1)).toBe('top');
        expect(resolveWheelTargetAnchor(false, -1)).toBe('top');
    });
});
