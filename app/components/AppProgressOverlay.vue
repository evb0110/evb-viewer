<template>
    <div
        v-if="open"
        ref="overlayElement"
        class="app-progress-overlay"
        :role="modal ? 'dialog' : 'status'"
        :aria-modal="modal ? 'true' : undefined"
        :aria-labelledby="modal ? titleId : undefined"
        :aria-describedby="modal ? descriptionIds : undefined"
        :aria-live="modal ? undefined : 'polite'"
        tabindex="-1"
        @keydown="handleKeydown"
    >
        <div class="app-progress-overlay-card">
            <AppSpinner size="lg" tone="primary" />
            <div
                :id="titleId"
                class="app-progress-overlay-title"
            >
                {{ title }}
            </div>
            <div
                v-if="detail"
                :id="detailId"
                class="app-progress-overlay-detail"
            >
                {{ detail }}
            </div>
            <AppProgressBar
                :value="value"
                class="app-progress-overlay-bar"
            />
            <div
                v-if="formattedPercent"
                class="app-progress-overlay-percent"
            >
                {{ formattedPercent }}
            </div>
            <div
                v-if="subDetail"
                :id="subDetailId"
                class="app-progress-overlay-sub-detail"
            >
                {{ subDetail }}
            </div>
            <UButton
                v-if="cancelLabel"
                :label="cancelLabel"
                variant="outline"
                color="neutral"
                size="sm"
                @click="emit('cancel')"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { clamp } from 'es-toolkit/math';
import AppProgressBar from '@app/components/AppProgressBar.vue';
import AppSpinner from '@app/components/AppSpinner.vue';

interface IAppProgressOverlayProps {
    open: boolean;
    title: string;
    value: number | null;
    detail?: string;
    subDetail?: string;
    cancelLabel?: string;
    modal?: boolean;
}

const {
    cancelLabel = '',
    detail = '',
    modal = false,
    open,
    subDetail = '',
    value,
} = defineProps<IAppProgressOverlayProps>();

const emit = defineEmits<{cancel: [];}>();
const overlayElement = ref<HTMLElement | null>(null);
const titleId = useId();
const detailId = useId();
const subDetailId = useId();
const descriptionIds = computed(() => [
    detail ? detailId : null,
    subDetail ? subDetailId : null,
].filter((id): id is string => id !== null).join(' ') || undefined);

let previouslyFocusedElement: HTMLElement | null = null;
const inertSiblings = new Map<HTMLElement, boolean>();

function getFocusableElements() {
    return Array.from(
        overlayElement.value?.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
    ).filter(element => (
        !element.hasAttribute('disabled')
        && element.getAttribute('aria-hidden') !== 'true'
    ));
}

function applyModalInert() {
    const overlay = overlayElement.value;
    const parent = overlay?.parentElement;
    if (!parent) {
        return;
    }
    for (const sibling of Array.from(parent.children)) {
        if (sibling === overlay || !(sibling instanceof HTMLElement)) {
            continue;
        }
        if (!inertSiblings.has(sibling)) {
            inertSiblings.set(sibling, sibling.inert);
        }
        sibling.inert = true;
    }
}

function restoreModalInert() {
    for (const [
        element,
        wasInert,
    ] of inertSiblings) {
        element.inert = wasInert;
    }
    inertSiblings.clear();
}

function focusModalEntry() {
    const focusableElements = getFocusableElements();
    (focusableElements[0] ?? overlayElement.value)?.focus({preventScroll: true});
}

function containOverlayFocus(event: FocusEvent) {
    const target = event.target;
    if (open && modal && target instanceof Node && !overlayElement.value?.contains(target)) {
        focusModalEntry();
    }
}

function findFocusFallback() {
    return Array.from(document.querySelectorAll<HTMLElement>(
        '[data-focus-restore], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).find(element => {
        const style = window.getComputedStyle(element);
        return !element.hasAttribute('disabled')
            && element.getAttribute('aria-hidden') !== 'true'
            && element.closest('[aria-hidden="true"], [hidden], [inert]') === null
            && !element.inert
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && element.getClientRects().length > 0;
    }) ?? null;
}

function restoreFocus() {
    const element = previouslyFocusedElement;
    previouslyFocusedElement = null;
    void nextTick(() => {
        const target = element?.isConnected ? element : findFocusFallback();
        target?.focus({preventScroll: true});
    });
}

function handleKeydown(event: KeyboardEvent) {
    if (!modal) {
        return;
    }
    if (event.key === 'Escape') {
        if (!cancelLabel) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        emit('cancel');
        return;
    }
    if (event.key !== 'Tab') {
        return;
    }

    const focusableElements = getFocusableElements();
    if (focusableElements.length === 0) {
        event.preventDefault();
        overlayElement.value?.focus({preventScroll: true});
        return;
    }

    event.preventDefault();
    const activeIndex = focusableElements.indexOf(document.activeElement as HTMLElement);
    const nextIndex = activeIndex < 0
        ? event.shiftKey
            ? focusableElements.length - 1
            : 0
        : (activeIndex + (event.shiftKey ? -1 : 1) + focusableElements.length) % focusableElements.length;
    focusableElements[nextIndex]?.focus({preventScroll: true});
}

watch(
    [
        () => open,
        () => modal,
    ],
    ([
        isOpen,
        isModal,
    ]) => {
        if (!isOpen || !isModal) {
            if (typeof document !== 'undefined') {
                document.removeEventListener('focusin', containOverlayFocus);
            }
            restoreModalInert();
            restoreFocus();
            return;
        }
        if (typeof document !== 'undefined') {
            const activeElement = document.activeElement;
            if (activeElement instanceof HTMLElement && activeElement !== overlayElement.value) {
                previouslyFocusedElement = activeElement;
            }
            document.addEventListener('focusin', containOverlayFocus);
        }
        void nextTick(() => {
            if (open && modal) {
                applyModalInert();
                focusModalEntry();
            }
        });
    },
    {
        flush: 'post',
        immediate: true,
    },
);

onBeforeUnmount(() => {
    if (typeof document !== 'undefined') {
        document.removeEventListener('focusin', containOverlayFocus);
    }
    restoreModalInert();
    restoreFocus();
});

const formattedPercent = computed(() => typeof value === 'number' && Number.isFinite(value)
    ? `${clamp(Math.round(value), 0, 100)}%`
    : '');
</script>

<style scoped>
.app-progress-overlay {
    position: absolute;
    inset: 0;
    z-index: var(--app-progress-overlay-z-index);
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    background: color-mix(in oklab, var(--ui-bg-elevated) 42%, transparent);
}

.app-progress-overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--app-progress-card-gap);
    padding: var(--app-progress-card-padding);
    border-radius: var(--app-progress-card-radius);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    box-shadow: var(--ui-shadow-lg);
    inline-size: min(
        var(--app-content-width-xs),
        calc(100% - (2 * var(--app-space-9xl)))
    );
    max-inline-size: calc(100% - (2 * var(--app-space-9xl)));
    box-sizing: border-box;
}

.app-progress-overlay-title {
    font-size: var(--app-text-size-body);
    color: var(--ui-text);
    font-weight: 500;
    text-align: center;
}

.app-progress-overlay-detail,
.app-progress-overlay-sub-detail {
    max-inline-size: var(--app-progress-bar-width);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    text-align: center;
}

.app-progress-overlay-sub-detail {
    color: var(--ui-text-dimmed);
}

.app-progress-overlay-bar {
    width: min(var(--app-progress-bar-width), 100%);
    max-inline-size: 100%;
}

.app-progress-overlay-percent {
    font-size: var(--app-text-size-kicker);
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}
</style>
