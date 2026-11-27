<template>
    <UInput
        ref="inputRef"
        v-model="model"
    >
        <template
            v-if="model.length > 0"
            #trailing
        >
            <div class="app-search-input-actions">
                <slot name="actions" />
                <UButton
                    icon="i-ph-x"
                    variant="ghost"
                    color="neutral"
                    size="xs"
                    class="app-search-input-clear"
                    :aria-label="t('search.clearSearchLabel')"
                    @click="clear"
                />
            </div>
        </template>
    </UInput>
</template>

<script setup lang="ts">
interface IAppSearchInputExpose {
    focus: () => void;
}

const model = defineModel<string>({required: true});
const emit = defineEmits<{cleared: []}>();

const {t} = useTypedI18n();
const inputRef = useTemplateRef<{inputRef: HTMLInputElement | null}>('inputRef');

function focus() {
    inputRef.value?.inputRef?.focus();
}

function clear() {
    model.value = '';
    emit('cleared');
    focus();
}

defineExpose<IAppSearchInputExpose>({focus});
</script>

<style scoped>
.app-search-input-actions {
    display: flex;
    align-items: center;
    gap: var(--app-space-3xs);
}

.app-search-input-clear {
    min-width: auto;
    padding-inline: var(--app-space-2xs);
}
</style>
