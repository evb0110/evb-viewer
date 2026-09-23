<template>
    <UModal
        :open="open"
        :title="t('errors.file.passwordPromptTitle')"
        :ui="{ footer: 'justify-end gap-2' }"
        :dismissible="!checking"
        :close="{ disabled: checking }"
        @update:open="handleOpenUpdate"
    >
        <template #description>
            <span class="sr-only">
                {{ t('errors.file.passwordPromptDescription', { name: fileName }) }}
            </span>
        </template>

        <template #body>
            <form class="space-y-4" @submit.prevent="handleSubmit">
                <p class="text-sm text-muted">
                    {{ t('errors.file.passwordPromptDescription', { name: fileName }) }}
                </p>
                <!--
                    The blank help line holds the error's place, so a wrong
                    password does not grow the dialog and move its buttons.
                -->
                <UFormField
                    :label="t('errors.file.passwordPromptLabel')"
                    :error="errorMessage || false"
                    :help="'\u00A0'"
                >
                    <UInput
                        ref="passwordInput"
                        v-model="password"
                        type="password"
                        autocomplete="current-password"
                        autofocus
                        :disabled="checking"
                        class="w-full"
                        @keydown.enter.prevent="handleSubmit"
                    />
                </UFormField>
            </form>
        </template>

        <template #footer>
            <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="outline"
                type="button"
                :disabled="checking"
                @click="handleCancel"
            />
            <UButton
                :label="t('errors.file.passwordPromptOpen')"
                color="primary"
                type="submit"
                :disabled="checking"
                @click="handleSubmit"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
import { useDocumentPasswordPrompt } from '@app/modules/workspace-shell/composables/useDocumentPasswordPrompt';

const { t } = useTypedI18n();
const {
    open,
    fileName,
    checking,
    errorMessage,
    submitPassword,
    cancelPasswordPrompt,
} = useDocumentPasswordPrompt();
const password = ref('');
const passwordInput = useTemplateRef<{inputRef: HTMLInputElement | null}>('passwordInput');

watch(open, () => {
    password.value = '';
});

// A wrong password keeps the dialog open; clear the field and hand focus back
// once the check finishes.
watch(checking, async (isChecking) => {
    if (isChecking || !open.value) {
        return;
    }
    password.value = '';
    await nextTick();
    passwordInput.value?.inputRef?.focus();
});

function handleOpenUpdate(open: boolean) {
    if (!open) {
        cancelPasswordPrompt();
    }
}

function handleSubmit() {
    if (checking.value) {
        return;
    }
    submitPassword(password.value);
}

function handleCancel() {
    password.value = '';
    cancelPasswordPrompt();
}
</script>
