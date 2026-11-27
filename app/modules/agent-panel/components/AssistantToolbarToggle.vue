<template>
    <ToolbarButton
        v-if="isEnabled"
        icon="ph:sparkle"
        :active="isOpen"
        :disabled="!isAvailable"
        :tooltip="t('assistant.toggle')"
        @click="toggle"
    />
</template>

<script setup lang="ts">
import ToolbarButton from '@app/components/ToolbarButton.vue';
import {useAssistantPanel} from '@app/composables/useAssistantPanel';

const {t} = useTypedI18n();
const {isOpen, isEnabled, isAvailable, toggle} = useAssistantPanel();
</script>
