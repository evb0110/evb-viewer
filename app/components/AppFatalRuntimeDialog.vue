<template>
    <div
        data-fatal-runtime-workspace
        class="contents"
        :inert="open"
    >
        <slot />
    </div>
    <dialog
        v-if="open"
        ref="dialogElement"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fatal-runtime-title"
        :aria-describedby="dialogDescriptionIds"
        class="fatal-runtime-dialog"
        @cancel.prevent
        @keydown="handleDialogKeydown"
    >
        <div class="fatal-runtime-card app-scrollbar app-scroll-region--balanced">
            <UAlert
                color="error"
                variant="soft"
                icon="i-ph-warning"
            >
                <template #[alertTitleSlot]>
                    <h1
                        id="fatal-runtime-title"
                        ref="headingElement"
                        tabindex="-1"
                    >
                        {{ title }}
                    </h1>
                </template>
                <template #description>
                    <p id="fatal-runtime-description">
                        {{ description }}
                    </p>
                </template>
            </UAlert>
            <p
                v-if="shortFailureId"
                id="fatal-runtime-error-id"
                class="mt-4 text-sm text-dimmed"
            >
                <span class="font-medium text-default">{{ errorIdLabel }}</span>
                <code class="ml-2 break-all">{{ shortFailureId }}</code>
            </p>
            <div
                v-if="detail"
                class="mt-4 rounded-xl border border-default bg-elevated p-4 text-sm text-dimmed"
            >
                <p class="font-medium text-default">
                    {{ detailLabel }}
                </p>
                <p id="fatal-runtime-detail" class="mt-2 break-words">
                    {{ detail }}
                </p>
            </div>
            <div class="mt-5 flex flex-wrap gap-3">
                <UButton
                    data-fatal-runtime-action="reload"
                    color="error"
                    icon="i-ph-arrows-clockwise"
                    @click="emit('reload')"
                >
                    {{ reloadLabel }}
                </UButton>
                <UButton
                    v-if="detail || failure"
                    data-fatal-runtime-action="copy"
                    color="neutral"
                    variant="soft"
                    :icon="copied ? 'i-ph-check' : 'i-ph-copy'"
                    @click="handleCopy"
                >
                    {{ copyLabel }}
                </UButton>
            </div>
        </div>
    </dialog>
</template>

<script setup lang="ts">
import {
    formatFailurePresentationCopy,
    getFailureErrorId,
} from '@app/composables/useFailureToast';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

const {
    copied,
    copyLabel,
    description,
    detail,
    detailLabel,
    errorIdLabel,
    failure = null,
    open,
    reloadLabel,
    title,
} = defineProps<{
    copied: boolean;
    copyLabel: string;
    description: string;
    detail: string | null;
    detailLabel: string;
    errorIdLabel: string;
    failure?: FailureReceipt | null;
    open: boolean;
    reloadLabel: string;
    title: string;
}>();

const emit = defineEmits<{
    copy: [text?: string];
    reload: [];
}>();

const dialogElement = ref<HTMLDialogElement | null>(null);
const headingElement = ref<HTMLHeadingElement | null>(null);
const alertTitleSlot = 'title';
const shortFailureId = computed(() => failure
    ? getFailureErrorId(failure)
    : null);
const dialogDescriptionIds = computed(() => [
    'fatal-runtime-description',
    shortFailureId.value ? 'fatal-runtime-error-id' : null,
    detail ? 'fatal-runtime-detail' : null,
].filter((id): id is string => Boolean(id)).join(' '));

function getLocalDetails() {
    return [
        description,
        detail,
    ]
        .filter((value): value is string => Boolean(value?.trim()))
        .join('\n') || undefined;
}

function handleCopy() {
    const localDetails = getLocalDetails();
    const text = failure
        ? formatFailurePresentationCopy({
            failure,
            title,
            ...(localDetails ? {description: localDetails} : {}),
        })
        : detail ?? undefined;
    emit('copy', text);
}

function getRecoveryControls() {
    return Array.from(
        dialogElement.value?.querySelectorAll<HTMLElement>('[data-fatal-runtime-action]') ?? [],
    ).filter(element => !element.hasAttribute('disabled'));
}

function handleDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return;
    }
    if (event.key !== 'Tab') {
        return;
    }

    const controls = getRecoveryControls();
    if (controls.length === 0) {
        event.preventDefault();
        headingElement.value?.focus();
        return;
    }

    event.preventDefault();
    const activeIndex = controls.indexOf(document.activeElement as HTMLElement);
    const nextIndex = activeIndex < 0
        ? event.shiftKey
            ? controls.length - 1
            : 0
        : (activeIndex + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
    controls[nextIndex]?.focus();
}

function containDocumentFocus(event: FocusEvent) {
    const target = event.target;
    if (
        open
        && target instanceof Node
        && !dialogElement.value?.contains(target)
    ) {
        headingElement.value?.focus();
    }
}

function removeDocumentFocusGuard() {
    if (typeof document !== 'undefined') {
        document.removeEventListener('focusin', containDocumentFocus);
    }
}

function closeNativeDialog() {
    const dialog = dialogElement.value;
    if (dialog?.open) {
        dialog.close();
    }
}

watch(
    () => open,
    (isOpen) => {
        if (!isOpen) {
            removeDocumentFocusGuard();
            closeNativeDialog();
            return;
        }
        void nextTick(() => {
            if (!open || typeof document === 'undefined') {
                return;
            }
            const dialog = dialogElement.value;
            if (!dialog?.open) {
                dialog?.showModal();
            }
            document.addEventListener('focusin', containDocumentFocus);
            headingElement.value?.focus();
        });
    },
    {immediate: true},
);

onBeforeUnmount(() => {
    removeDocumentFocusGuard();
    closeNativeDialog();
});
</script>

<style scoped>
.fatal-runtime-dialog {
    position: fixed;
    inset: 0;
    z-index: var(--app-z-progress);
    margin: 0;
    display: flex;
    height: 100dvh;
    max-height: none;
    width: 100vw;
    max-width: none;
    align-items: center;
    justify-content: center;
    border: 0;
    background: color-mix(in oklab, var(--app-window-bg) 96%, transparent);
    padding: var(--app-space-16xl);
    backdrop-filter: blur(var(--app-backdrop-blur-sm));
}

.fatal-runtime-dialog::backdrop {
    background: transparent;
}

.fatal-runtime-card {
    max-height: calc(100dvh - var(--app-space-16xl) * 2);
    width: 100%;
    max-width: var(--app-fatal-runtime-card-max-width);
    overflow-y: auto;
    border-radius: var(--app-fatal-runtime-card-radius);
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    padding: var(--app-space-16xl);
    box-shadow: var(--shadow-popup);
}
</style>
