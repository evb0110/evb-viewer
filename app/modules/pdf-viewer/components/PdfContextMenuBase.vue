<template>
    <div
        v-if="visible"
        ref="menuElement"
        class="pdf-context-menu-base app-floating-scroll-region app-scrollbar app-scroll-region--balanced"
        :class="`pdf-context-menu-base--${variant}`"
        :style="resolvedStyle"
        role="menu"
        aria-orientation="vertical"
        :aria-label="accessibleLabel || t('toolbar.appMenu')"
        tabindex="-1"
        @click.stop
        @keydown="handleMenuKeydown"
        @pointermove="handleMenuPointerMove"
        @pointerleave="clearActiveItem"
    >
        <slot />
    </div>
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core';

type TVariant = 'grid' | 'panel';

interface IProps {
    visible: boolean;
    style?: Record<string, string>;
    variant?: TVariant;
    zIndex?: number | string;
    minWidth?: string;
    accessibleLabel?: string;
}

const {
    style: baseStyle = {},
    variant = 'grid',
    zIndex = 'var(--app-pdf-context-menu-z-index)',
    minWidth = '',
    accessibleLabel = '',
    visible,
} = defineProps<IProps>();

const resolvedStyle = computed(() => {
    const style: Record<string, string> = {
        ...baseStyle,
        zIndex: String(zIndex),
    };

    if (minWidth) {
        style.minInlineSize = `min(${minWidth}, var(--app-floating-panel-viewport-width))`;
    }

    return style;
});

const { t } = useTypedI18n();
const documentTarget = typeof document === 'undefined' ? undefined : document;
const menuElement = ref<HTMLElement | null>(null);
let previouslyFocusedElement: HTMLElement | null = null;
let pointerFocusPending = false;
let pointerFocusResetTimer: ReturnType<typeof setTimeout> | null = null;
let lastInputWasKeyboard = false;

function getMenuItems() {
    return Array.from(
        menuElement.value?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], [role="menuitem"], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
    ).filter(element => !element.hasAttribute('disabled') && !element.hasAttribute('aria-hidden'));
}

function focusMenuEntry() {
    // Focus is the menu's only active-item marker. A pointer-opened menu starts
    // with no active item so Enter or Space cannot run an action nobody chose.
    const entry = lastInputWasKeyboard ? getMenuItems()[0] : null;
    (entry ?? menuElement.value)?.focus({preventScroll: true});
}

function clearActiveItem() {
    const root = menuElement.value;
    if (root && root !== document.activeElement && root.contains(document.activeElement)) {
        root.focus({preventScroll: true});
    }
}

function handleMenuPointerMove(event: PointerEvent) {
    const target = event.target;
    const item = target instanceof Element
        ? getMenuItems().find(element => element.contains(target))
        : undefined;
    if (!item) {
        clearActiveItem();
        return;
    }
    if (item !== document.activeElement) {
        item.focus({preventScroll: true});
    }
}

function handleMenuKeydown(event: KeyboardEvent) {
    if (![
        'ArrowDown',
        'ArrowUp',
        'Home',
        'End',
    ].includes(event.key)) {
        return;
    }

    const items = getMenuItems();
    if (items.length === 0) {
        event.preventDefault();
        menuElement.value?.focus({preventScroll: true});
        return;
    }

    event.preventDefault();
    const activeIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
            ? items.length - 1
            : (activeIndex < 0 ? 0 : activeIndex + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[nextIndex]?.focus({preventScroll: true});
}

function containMenuFocus(event: FocusEvent) {
    const target = event.target;
    if (pointerFocusPending) {
        pointerFocusPending = false;
        return;
    }
    if (visible && target instanceof Node && !menuElement.value?.contains(target)) {
        focusMenuEntry();
    }
}

function markKeyboardInput() {
    lastInputWasKeyboard = true;
}

function markPointerFocus() {
    pointerFocusPending = true;
    if (pointerFocusResetTimer !== null) {
        clearTimeout(pointerFocusResetTimer);
    }
    pointerFocusResetTimer = setTimeout(() => {
        pointerFocusPending = false;
        pointerFocusResetTimer = null;
    }, 0);
}

useEventListener(documentTarget, 'keydown', markKeyboardInput, { capture: true });
useEventListener(documentTarget, 'pointerdown', () => {
    lastInputWasKeyboard = false;
}, { capture: true });

function removeFocusListeners() {
    if (typeof document !== 'undefined') {
        document.removeEventListener('focusin', containMenuFocus);
        document.removeEventListener('pointerdown', markPointerFocus, true);
    }
    pointerFocusPending = false;
    if (pointerFocusResetTimer !== null) {
        clearTimeout(pointerFocusResetTimer);
        pointerFocusResetTimer = null;
    }
}

function restoreFocus() {
    const element = previouslyFocusedElement;
    previouslyFocusedElement = null;
    if (element?.isConnected) {
        void nextTick(() => {
            // A menu action may focus an editor or a dialog as it closes.
            // Returning focus to the opener would blur and commit that editor.
            const active = document.activeElement;
            if (active && active !== document.body && active !== element) return;
            element.focus({preventScroll: true});
        });
    }
}

watch(() => visible, (isVisible) => {
    if (!isVisible) {
        removeFocusListeners();
        restoreFocus();
        return;
    }

    if (typeof document !== 'undefined') {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && activeElement !== menuElement.value) {
            previouslyFocusedElement = activeElement;
        }
        document.addEventListener('focusin', containMenuFocus);
        document.addEventListener('pointerdown', markPointerFocus, true);
    }
    void nextTick(focusMenuEntry);
}, {
    flush: 'post',
    immediate: true,
});

onBeforeUnmount(() => {
    removeFocusListeners();
    restoreFocus();
});
</script>

<style scoped>
.pdf-context-menu-base {
    position: fixed;
    box-sizing: border-box;
    width: max-content;
    max-width: var(--app-floating-panel-max-inline-size);
    min-inline-size: min(var(--app-context-menu-preferred-width), var(--app-floating-panel-viewport-width));
    border: 1px solid var(--app-pdf-context-menu-border);
    border-radius: var(--app-context-menu-radius);
    background: var(--app-pdf-context-menu-item-bg);
    box-shadow: var(--app-pdf-context-menu-grid-shadow);
    color: var(--app-pdf-context-menu-item-fg);
}

.pdf-context-menu-base--grid {
    --pdf-context-menu-inline-padding: var(--app-space-3xl);

    display: grid;
    padding: var(--app-pdf-context-menu-grid-padding);
}

.pdf-context-menu-base--panel {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-xs);
    padding: 0.3rem;
    border-radius: 0.55rem;
    background: var(--app-pdf-context-menu-panel-bg);
    box-shadow: var(--app-pdf-context-menu-panel-shadow);
}

.pdf-context-menu-base :deep(.pdf-context-menu__section-title) {
    margin: 0;
    padding: var(--app-space-3xl) var(--app-space-5xl) var(--app-space-sm);
    color: var(--app-pdf-context-menu-title-fg);
    font-size: var(--app-text-size-menu-shortcut);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: var(--app-font-weight-semibold);
    display: flex;
    align-items: center;
    gap: var(--app-space-md);
    min-width: 0;
    white-space: normal;
    overflow: hidden;
    overflow-wrap: anywhere;
}

.pdf-context-menu-base--grid :deep(.pdf-context-menu__section-title) {
    padding-inline: var(--pdf-context-menu-inline-padding);
}

.pdf-context-menu-base :deep(.pdf-context-menu__divider) {
    height: var(--app-hairline-height);
    background: var(--app-pdf-context-menu-divider);
}

.pdf-context-menu-base--grid :deep(.pdf-context-menu__divider) {
    margin: var(--app-space-sm) var(--app-space-2xs);
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__divider) {
    margin: var(--app-space-2xs) 0.1rem;
}

.pdf-context-menu-base :deep(.pdf-context-menu__action) {
    display: flex;
    align-items: center;
    gap: var(--app-space-2xl);
    min-width: 0;
    text-align: left;
    color: var(--app-pdf-context-menu-item-fg);
    white-space: normal;
    overflow: hidden;
    overflow-wrap: anywhere;
}

.pdf-context-menu-base--grid :deep(.pdf-context-menu__action) {
    border: none;
    border-radius: var(--app-pdf-context-menu-item-radius);
    background: transparent;
    min-height: var(--app-control-height-sm);
    padding: 0 var(--pdf-context-menu-inline-padding);
    cursor: pointer;
    font-size: var(--app-text-size-body-sm);
    transition: background-color 120ms ease, color 120ms ease;
}

.pdf-context-menu-base:focus {
    outline: none;
}

.pdf-context-menu-base--grid :deep(.pdf-context-menu__action:focus) {
    outline: none;
    background: var(--app-pdf-context-menu-item-hover-bg);
}

.pdf-context-menu-base--grid :deep(.pdf-context-menu__action:disabled) {
    color: var(--app-pdf-context-menu-item-disabled-fg);
    background: transparent;
    cursor: default;
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__action) {
    border: 1px solid transparent;
    border-radius: var(--app-radius-lg);
    background: transparent;
    color: var(--app-pdf-context-menu-panel-action-fg);
    font-size: var(--app-text-size-meta);
    min-height: 0;
    padding: var(--app-space-md) var(--app-space-2xl);
    cursor: pointer;
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__action:focus) {
    outline: none;
    border-color: var(--app-pdf-context-menu-panel-action-border);
    background: var(--app-pdf-context-menu-panel-action-hover-bg);
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__action:disabled) {
    opacity: var(--app-opacity-disabled);
}

.pdf-context-menu-base :deep(.pdf-context-menu__action--danger) {
    color: var(--app-pdf-context-menu-danger-fg);
}

.pdf-context-menu-base--grid :deep(.pdf-context-menu__action--danger:focus) {
    background: var(--app-pdf-context-menu-danger-hover-bg);
}

.pdf-context-menu-base :deep(.pdf-context-menu__icon) {
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    flex-shrink: 0;
    color: var(--ui-text-muted);
}

.pdf-context-menu-base :deep(.pdf-context-menu__action--danger .pdf-context-menu__icon) {
    color: inherit;
}
</style>
