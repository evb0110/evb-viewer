<template>
    <fieldset class="settings-section flex flex-col gap-2.5">
        <legend class="settings-section-title">{{ t('settings.updates') }}</legend>
        <UButton
            :label="isCheckInProgress ? t('updates.checkingAction') : t('settings.checkForUpdates')"
            color="neutral"
            variant="outline"
            :loading="isCheckInProgress"
            :disabled="isCheckInProgress"
            @click="emit('check')"
        />
    </fieldset>
</template>

<script setup lang="ts">
defineProps<{isCheckInProgress: boolean;}>();

const emit = defineEmits<{check: [];}>();

const { t } = useTypedI18n();
</script>

