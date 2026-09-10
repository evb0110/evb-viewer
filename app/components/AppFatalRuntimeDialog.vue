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
        class="fatal-runtime-dialog fixed inset-0 z-50 m-0 flex h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-[color:var(--app-window-bg)]/96 p-6 backdrop-blur-sm"
        @cancel.prevent
        @keydown="handleDialogKeydown"
    >
        <div class="app-scrollbar app-scroll-region--balanced max-h-[calc(100dvh-3rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-default bg-default p-6 shadow-[var(--shadow-popup)]">
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
                    @click="$emit('reload')"
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

const props = defineProps<{
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
const shortFailureId = computed(() => props.failure
    ? getFailureErrorId(props.failure)
    : null);
const dialogDescriptionIds = computed(() => [
    'fatal-runtime-description',
    shortFailureId.value ? 'fatal-runtime-error-id' : null,
    props.detail ? 'fatal-runtime-detail' : null,
].filter((id): id is string => Boolean(id)).join(' '));

function getLocalDetails() {
    return [
        props.description,
        props.detail,
    ]
        .filter((value): value is string => Boolean(value?.trim()))
        .join('\n') || undefined;
}

function handleCopy() {
    const description = getLocalDetails();
    const text = props.failure
        ? formatFailurePresentationCopy({
            failure: props.failure,
            title: props.title,
            ...(description ? {description} : {}),
        })
        : props.detail ?? undefined;
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
        props.open
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
    () => props.open,
    (open) => {
        if (!open) {
            removeDocumentFocusGuard();
            closeNativeDialog();
            return;
        }
        void nextTick(() => {
            if (!props.open || typeof document === 'undefined') {
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
.fatal-runtime-dialog::backdrop {
    background: transparent;
}
</style>
