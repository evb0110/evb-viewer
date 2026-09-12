<template>
    <UModal
        v-model:open="open"
        :title="t('settings.title')"
        :ui="{
            content: 'w-[min(var(--app-settings-dialog-width),var(--app-floating-panel-viewport-width))] max-w-none',
            footer: 'justify-end',
        }"
    >
        <template #description>
            <span class="sr-only">
                {{ settingsDialogDescription }}
            </span>
        </template>

        <template #body>
            <div class="settings-dialog-content">
                <SettingsContent />
            </div>
        </template>

        <template #footer="{ close }">
            <UButton
                :label="t('settings.close')"
                color="neutral"
                variant="outline"
                @click="close"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
import SettingsContent from '@app/components/settings/SettingsContent.vue';

const open = defineModel<boolean>('open', { required: true });
const { isDesktopRuntime } = useRuntimeEnvironment();
const { t } = useTypedI18n();
const {
    load,
    save,
} = useSettings();

watch(open, (isOpen, wasOpen) => {
    if (!isOpen || wasOpen) {
        return;
    }

    void (async () => {
        // SettingsContent remains mounted while the modal is closed. Flush a
        // pending local edit before replacing its snapshot with the latest
        // persisted value from another tab or process.
        if (await save()) {
            await load();
        }
    })();
});

const settingsDialogDescription = computed(() => isDesktopRuntime.value
    ? t('settings.dialogDescription')
    : t('settings.browserDialogDescription'));
</script>

<style scoped>
.settings-dialog-content {
    container-type: inline-size;
}
</style>
