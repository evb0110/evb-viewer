<template>
    <span
        class="assistant-provider-mark"
        :class="`is-${provider}`"
    >
        <UIcon
            :name="provider === 'claude' ? 'evb:provider-claude' : 'evb:provider-openai'"
            mode="svg"
            class="assistant-provider-icon"
            aria-hidden="true"
            focusable="false"
        />
        <span
            v-if="badge"
            class="assistant-provider-badge"
            aria-hidden="true"
            >{{ badge }}</span
        >
    </span>
</template>

<script setup lang="ts">
import type {TAssistantDriver} from '@contracts/assistant';

defineProps<{
    provider: TAssistantDriver;
    /** Initials that tell a second instance of the provider apart. */
    badge?: string | undefined;
}>();
</script>

<style scoped>
.assistant-provider-mark {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
}

/* T3 Code's brand colors: Claude's coral; the OpenAI mark follows the text. */
.is-claude {
    color: var(--app-assistant-claude-mark);
}

.assistant-provider-badge {
    position: absolute;
    right: -0.4em;
    bottom: -0.35em;
    display: flex;
    min-width: var(--app-assistant-provider-badge-size);
    height: var(--app-assistant-provider-badge-size);
    align-items: center;
    justify-content: center;
    padding: 0 0.15em;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-full);
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: var(--app-assistant-provider-badge-font-size);
    font-weight: 600;
    line-height: 1;
}

.assistant-provider-icon {
    display: inline-block;
    width: var(--app-assistant-provider-icon-size);
    height: var(--app-assistant-provider-icon-size);
    flex: 0 0 auto;
}
</style>
