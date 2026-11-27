<template>
    <code :data-language="language"><span
        v-for="(token, index) in tokens"
        :key="index"
        :class="`agent-assistant-code-token is-${token.kind}`"
    >{{ token.text }}</span></code>
</template>

<script setup lang="ts">
import { highlightAssistantCode } from '@app/modules/agent-panel/utils/highlightAssistantCode';

const props = defineProps<{
    code: string;
    language: string | null;
}>();
const tokens = computed(() => highlightAssistantCode(props.code, props.language));
</script>

<style scoped>
code {
    font-family: var(--app-font-mono);
    font-size: var(--app-text-size-body-sm);
}

.is-keyword {
    color: var(--ui-primary);
}

.is-string {
    color: var(--ui-success);
}

.is-number {
    color: var(--ui-warning);
}

.is-comment {
    color: var(--ui-text-dimmed);
}
</style>
