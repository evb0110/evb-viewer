// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    effectScope,
    nextTick,
} from 'vue';
import { usePositionedMenu } from '@app/composables/usePositionedMenu';

interface ITestPositionedMenuState {
    visible: boolean;
    x: number;
    y: number;
}

function createInitialMenuState(): ITestPositionedMenuState {
    return {
        visible: false,
        x: 0,
        y: 0,
    };
}

function setWindowSize(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: width,
    });
    Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: height,
    });
}

function setElementSize(element: HTMLElement, width: number, height: number) {
    Object.defineProperty(element, 'offsetWidth', {
        configurable: true,
        value: width,
    });
    Object.defineProperty(element, 'offsetHeight', {
        configurable: true,
        value: height,
    });
}

describe('usePositionedMenu', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        setWindowSize(100, 100);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('requeries a menu element that rendered after an initial null lookup', async () => {
        const scope = effectScope();
        const positionedMenu = scope.run(() => usePositionedMenu<ITestPositionedMenuState>(
            '.test-positioned-menu',
            createInitialMenuState,
            { autoDismiss: { onOutsideClick: true } },
        ));

        if (!positionedMenu) {
            throw new Error('Failed to create positioned menu');
        }

        expect(positionedMenu.menuElement.value).toBeNull();

        positionedMenu.showPositionedMenu({
            x: 90,
            y: 90,
            fallbackWidth: 5,
            fallbackHeight: 5,
            buildState: position => ({
                visible: true,
                x: position.x,
                y: position.y,
            }),
        });

        const menuElement = document.createElement('div');
        menuElement.className = 'test-positioned-menu';
        setElementSize(menuElement, 50, 40);
        document.body.append(menuElement);

        await nextTick();

        expect(positionedMenu.menuElement.value).toBe(menuElement);
        expect(positionedMenu.menu.value.x).toBe(42);
        expect(positionedMenu.menu.value.y).toBe(52);

        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await nextTick();

        expect(positionedMenu.menu.value.visible).toBe(false);
        scope.stop();
    });

    it('closes when another menu opens by right-click elsewhere, but not for one inside it', async () => {
        const scope = effectScope();
        const positionedMenu = scope.run(() => usePositionedMenu<ITestPositionedMenuState>(
            '.test-positioned-menu',
            createInitialMenuState,
            { autoDismiss: { onOutsideClick: true } },
        ))!;
        const menuElement = document.createElement('div');
        menuElement.className = 'test-positioned-menu';
        document.body.append(menuElement);
        const open = () => positionedMenu.showPositionedMenu({
            x: 10,
            y: 10,
            fallbackWidth: 5,
            fallbackHeight: 5,
            buildState: position => ({
                visible: true,
                x: position.x,
                y: position.y,
            }),
        });
        open();
        await nextTick();

        menuElement.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true}));
        expect(positionedMenu.menu.value.visible).toBe(true);

        // A secondary press produces no click event.
        document.body.dispatchEvent(new Event('pointerdown', {bubbles: true}));
        document.body.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true}));
        await nextTick();
        expect(positionedMenu.menu.value.visible).toBe(false);
        scope.stop();
    });
});
