import type { Ref } from 'vue';
import {
    onClickOutside,
    useEventListener,
} from '@vueuse/core';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';

interface IPositionedMenuState {
    visible: boolean;
    x: number;
    y: number;
}

interface IShowPositionedMenuOptions<TMenuState extends IPositionedMenuState> {
    x: number;
    y: number;
    fallbackWidth: number;
    fallbackHeight: number;
    buildState: (position: {
        x: number;
        y: number;
    }) => TMenuState;
}

interface IPositionedMenuAutoDismissOptions {
    onOutsideClick?: boolean;
    onResize?: boolean;
    onScroll?: boolean;
}

interface IUsePositionedMenuOptions {autoDismiss?: IPositionedMenuAutoDismissOptions;}

export const usePositionedMenu = <TMenuState extends IPositionedMenuState>(
    selector: string,
    createInitialState: () => TMenuState,
    options: IUsePositionedMenuOptions = {},
) => {
    const { clampElementToViewport } = useContextMenuPosition();
    const windowTarget = typeof window === 'undefined' ? undefined : window;

    const menu = ref(createInitialState()) as Ref<TMenuState>;
    const menuElementQueryVersion = ref(0);
    const menuElement = computed(() => {
        const _queryVersion = menuElementQueryVersion.value;
        if (typeof window === 'undefined' || !menu.value.visible) {
            return null;
        }
        return document.querySelector<HTMLElement>(selector);
    });

    const menuStyle = computed(() => ({
        left: `${menu.value.x}px`,
        top: `${menu.value.y}px`,
    }));

    function refreshMenuElement() {
        menuElementQueryVersion.value += 1;
    }

    function positionMenu(
        x: number,
        y: number,
        fallbackWidth: number,
        fallbackHeight: number,
    ) {
        const clamped = clampElementToViewport(
            x,
            y,
            menuElement.value,
            fallbackWidth,
            fallbackHeight,
        );
        menu.value.x = clamped.x;
        menu.value.y = clamped.y;
    }

    function showPositionedMenu(options: IShowPositionedMenuOptions<TMenuState>) {
        const initialPosition = clampElementToViewport(
            options.x,
            options.y,
            menuElement.value,
            options.fallbackWidth,
            options.fallbackHeight,
        );

        menu.value = options.buildState(initialPosition);

        void nextTick(() => {
            if (!menu.value.visible) {
                return;
            }
            refreshMenuElement();
            positionMenu(
                options.x,
                options.y,
                options.fallbackWidth,
                options.fallbackHeight,
            );
        });
    }

    function resetMenu() {
        menu.value = createInitialState();
    }

    function dismissMenu() {
        if (!menu.value.visible) {
            return;
        }
        resetMenu();
    }

    onClickOutside(menuElement, () => {
        if (options.autoDismiss?.onOutsideClick) {
            dismissMenu();
        }
    }, { capture: true });
    // A right-click makes no click, so another menu opening elsewhere closes
    // this one first instead of both trapping focus.
    useEventListener(windowTarget, 'contextmenu', (event) => {
        if (options.autoDismiss?.onOutsideClick && !(event.target instanceof Node && menuElement.value?.contains(event.target))) {
            dismissMenu();
        }
    }, { capture: true });
    useEventListener(windowTarget, 'resize', () => {
        if (options.autoDismiss?.onResize) {
            dismissMenu();
        }
    });
    useEventListener(windowTarget, 'scroll', () => {
        if (options.autoDismiss?.onScroll) {
            dismissMenu();
        }
    }, { capture: true });
    useEventListener(windowTarget, 'keydown', (event) => {
        if (!(event instanceof KeyboardEvent) || event.key !== 'Escape' || !menu.value.visible) {
            return;
        }
        // Let composables with an Escape side effect observe the original
        // event before the shared menu state closes.
        queueMicrotask(dismissMenu);
    });

    return {
        menu,
        menuElement,
        menuStyle,
        positionMenu,
        showPositionedMenu,
        resetMenu,
        dismissMenu,
    };
};
