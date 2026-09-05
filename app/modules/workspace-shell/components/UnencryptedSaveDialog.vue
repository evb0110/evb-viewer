<template>
    <UModal
        :open="open"
        :title="t('errors.save.unencryptedTitle')"
        :ui="{ content: 'unencrypted-save-dialog', footer: 'justify-end gap-2' }"
        @update:open="handleOpenUpdate"
    >
        <template #description>
            <span class="sr-only">
                {{ t('errors.save.unencryptedDescription') }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-4">
                <p class="text-sm text-muted">
                    {{ t('errors.save.unencryptedDescription') }}
                </p>
                <UCheckbox
                    data-testid="unencrypted-save-dont-show-again"
                    :model-value="dontShowAgain"
                    :label="t('errors.save.unencryptedDontShowAgain')"
                    @update:model-value="handleDontShowAgainUpdate"
                />
            </div>
        </template>

        <template #footer>
            <UButton
                data-testid="unencrypted-save-cancel"
                :label="t('common.cancel')"
                color="neutral"
                variant="outline"
                @click="emit('cancel')"
            />
            <UButton
                data-testid="unencrypted-save-continue"
                :label="t('errors.save.unencryptedContinue')"
                color="primary"
                @click="emit('continue')"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
defineProps<{
    open: boolean;
    dontShowAgain: boolean;
}>();

const emit = defineEmits<{
    'update:open': [open: boolean];
    'update:dont-show-again': [value: boolean];
    continue: [];
    cancel: [];
}>();

const { t } = useTypedI18n();

function handleOpenUpdate(open: boolean) {
    emit('update:open', open);
}

function handleDontShowAgainUpdate(value: boolean | 'indeterminate') {
    emit('update:dont-show-again', value === true);
}
</script>
