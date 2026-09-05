<template>
    <UModal
        :open="open"
        :title="t('errors.file.passwordPromptTitle')"
        :ui="{ footer: 'justify-end gap-2' }"
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
                <UFormField
                    :label="t('errors.file.passwordPromptLabel')"
                    :error="errorMessage || false"
                >
                    <UInput
                        v-model="password"
                        type="password"
                        autocomplete="current-password"
                        autofocus
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
                @click="handleCancel"
            />
            <UButton
                :label="t('errors.file.passwordPromptOpen')"
                color="primary"
                type="submit"
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
    errorMessage,
    submitPassword,
    cancelPasswordPrompt,
} = useDocumentPasswordPrompt();
const password = ref('');

watch(open, (isOpen) => {
    if (isOpen) {
        password.value = '';
    }
});

function handleOpenUpdate(open: boolean) {
    if (!open) {
        cancelPasswordPrompt();
    }
}

function handleSubmit() {
    submitPassword(password.value);
    password.value = '';
}

function handleCancel() {
    password.value = '';
    cancelPasswordPrompt();
}
</script>
