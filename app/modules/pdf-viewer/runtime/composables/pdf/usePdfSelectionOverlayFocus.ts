import type {Ref} from 'vue';

interface ISelectionOverlayKeyboardController {
    handleKeyboardKey: (event: KeyboardEvent) => boolean;
}

interface IPdfSelectionOverlayFocusOptions {
    isActive: () => boolean;
    overlayRef: Ref<HTMLElement | null>;
    keyboardController: ISelectionOverlayKeyboardController | null;
    onCancel: () => void;
}

export const usePdfSelectionOverlayFocus = (options: IPdfSelectionOverlayFocusOptions) => {
    let previouslyFocusedElement: HTMLElement | null = null;

    function focusOverlay() {
        if (typeof document !== 'undefined') {
            const activeElement = document.activeElement;
            if (activeElement instanceof HTMLElement && activeElement !== options.overlayRef.value) {
                previouslyFocusedElement = activeElement;
            }
        }
        void nextTick(() => options.overlayRef.value?.focus({preventScroll: true}));
    }

    function restoreFocus() {
        const element = previouslyFocusedElement;
        previouslyFocusedElement = null;
        if (element?.isConnected) {
            void nextTick(() => element.focus({preventScroll: true}));
        }
    }

    function handleKeyboardKey(event: KeyboardEvent) {
        if (!options.isActive()) {
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            options.overlayRef.value?.focus({preventScroll: true});
            return;
        }
        if (options.keyboardController?.handleKeyboardKey(event)) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            options.onCancel();
        }
    }

    watch(
        options.isActive,
        (isActive) => {
            if (isActive) {
                focusOverlay();
            } else {
                restoreFocus();
            }
        },
        {
            flush: 'post',
            immediate: true,
        },
    );

    onBeforeUnmount(restoreFocus);

    return {handleKeyboardKey};
};
