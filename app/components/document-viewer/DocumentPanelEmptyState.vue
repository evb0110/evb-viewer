<template>
    <div
        class="document-panel-empty-state"
        :class="{'has-action': Boolean(slots.action)}"
    >
        <UIcon
            :name="icon"
            class="document-panel-empty-state__icon"
        />
        <p class="document-panel-empty-state__title">
            {{ title }}
        </p>
        <p
            v-if="description"
            class="document-panel-empty-state__description"
        >
            {{ description }}
        </p>
        <div
            v-if="slots.action"
            class="document-panel-empty-state__action"
        >
            <slot name="action" />
        </div>
    </div>
</template>

<script setup lang="ts">
defineProps<{
    icon: string;
    title: string;
    description?: string;
}>();
const slots = useSlots();
</script>

<style scoped>
.document-panel-empty-state {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-3xl);
    padding: var(--app-panel-empty-padding);
    text-align: center;
    color: var(--ui-text-muted);
}

.document-panel-empty-state__icon {
    width: var(--app-panel-empty-icon-size);
    height: var(--app-panel-empty-icon-size);
    color: var(--ui-text-dimmed);
}

.document-panel-empty-state__title {
    margin: 0;
    font-size: var(--app-text-size-panel-title);
    font-weight: 600;
    color: var(--ui-text);
}

.document-panel-empty-state__description {
    margin: 0;
    max-width: var(--app-panel-empty-max-width);
    font-size: var(--app-text-size-body-sm);
    line-height: 1.45;
}

.document-panel-empty-state__action {
    margin-top: var(--app-space-sm);
}
</style>
