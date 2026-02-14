<template>
    <div
        v-if="visible"
        class="notes-context-menu"
        :style="menuStyle"
        @click.stop
    >
        <button
            type="button"
            class="context-menu-action"
            :disabled="!comment"
            @click="emit('open')"
        >
            {{ t('annotations.openNote') }}
        </button>
        <button
            type="button"
            class="context-menu-action"
            :disabled="!comment"
            @click="emit('copy')"
        >
            {{ t('annotations.copyText') }}
        </button>
        <button
            type="button"
            class="context-menu-action is-danger"
            :disabled="!comment"
            @click="emit('delete')"
        >
            {{ t('annotations.delete') }}
        </button>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

interface IProps {
    visible: boolean;
    x: number;
    y: number;
    comment: IAnnotationCommentSummary | null;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'open'): void;
    (e: 'copy'): void;
    (e: 'delete'): void;
}>();

const { t } = useTypedI18n();

const menuStyle = computed(() => ({
    left: `${props.x}px`,
    top: `${props.y}px`,
}));
</script>

<style scoped>
.notes-context-menu {
    position: fixed;
    z-index: 1400;
    min-width: 10.5rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.55rem;
    background: var(--ui-bg);
    box-shadow: 0 14px 30px color-mix(in srgb, var(--ui-bg-inverted) 20%, transparent 80%);
    padding: 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}

.context-menu-action {
    border: 1px solid transparent;
    border-radius: 0.4rem;
    background: transparent;
    color: var(--ui-text-highlighted);
    font-size: 0.77rem;
    text-align: left;
    padding: 0.35rem 0.45rem;
    cursor: pointer;
}

.context-menu-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.context-menu-action:hover:not(:disabled) {
    border-color: var(--ui-border);
    background: color-mix(in srgb, var(--ui-bg-muted) 55%, var(--ui-bg) 45%);
}

.context-menu-action.is-danger {
    color: color-mix(in srgb, var(--ui-error) 68%, var(--ui-text-highlighted) 32%);
}
</style>
