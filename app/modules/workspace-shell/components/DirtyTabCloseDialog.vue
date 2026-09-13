<template>
    <UModal
        :open="open"
        :title="dialogTitle"
        :ui="{ footer: 'justify-end gap-2' }"
        @update:open="handleOpenUpdate"
    >
        <template #description>
            <span class="sr-only">
                {{ dialogDescription }}
            </span>
        </template>

        <template #body>
            <p class="text-sm text-muted">
                {{ dialogDescription }}
            </p>
        </template>

        <template #footer="{ close }">
            <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="outline"
                @click="close"
            />
            <UButton
                :label="t('tabs.discardChanges')"
                color="error"
                :disabled="isResolving"
                @click="handleDiscard"
            />
            <UButton
                :label="t('status.saveChanges')"
                color="primary"
                :disabled="isResolving"
                @click="handleSave"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
import type { TDirtyCloseDialogMode } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';

const {
    mode = 'tab',
    open,
    targetName,
} = defineProps<{
    mode?: TDirtyCloseDialogMode;
    open: boolean;
    targetName: string;
}>();

const emit = defineEmits<{
    'update:open': [open: boolean];
    discard: [];
    save: [];
}>();

const { t } = useTypedI18n();
const isResolving = ref(false);
const dialogTitle = computed(() => mode === 'window'
    ? t('tabs.confirmCloseWindowDirtyTitle')
    : t('tabs.confirmCloseDirtyTitle'));
const dialogDescription = computed(() => mode === 'window'
    ? t('tabs.confirmCloseWindowDirtyDescription')
    : t('tabs.confirmCloseDirtyDescription', {name: targetName}));

watch(() => open, (isOpen) => {
    if (isOpen) {
        isResolving.value = false;
    }
});

function handleOpenUpdate(open: boolean) {
    emit('update:open', open);
}

function handleDiscard() {
    if (isResolving.value) {
        return;
    }
    isResolving.value = true;
    emit('discard');
}

function handleSave() {
    if (isResolving.value) {
        return;
    }
    isResolving.value = true;
    emit('save');
}
</script>
