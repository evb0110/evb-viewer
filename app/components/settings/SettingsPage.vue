<template>
    <AppToolPageShell
        :title="t('settings.title')"
        :eyebrow="t('settings.pageEyebrow')"
        icon="i-ph-gear"
        :show-back="showBack"
        :show-eyebrow="showEyebrow"
        :show-header="showHeader"
        @close="emit('close')"
    >
        <div class="settings-page-content">
            <SettingsContent />
        </div>
    </AppToolPageShell>
</template>

<script setup lang="ts">
import AppToolPageShell from '@app/components/AppToolPageShell.vue';
import SettingsContent from '@app/components/settings/SettingsContent.vue';

const emit = defineEmits<{close: []}>();

const {
    showBack = true,
    showEyebrow = true,
    showHeader = true,
} = defineProps<{
    showBack?: boolean;
    showEyebrow?: boolean;
    showHeader?: boolean;
}>();

const {t} = useTypedI18n();
</script>

<style scoped>
.settings-page-content {
    width: min(100%, 64rem);
    margin: 0 auto;
}
</style>
