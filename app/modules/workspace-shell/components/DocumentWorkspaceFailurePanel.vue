<template>
    <div class="workspace-host__loading" role="alert" aria-live="assertive">
        <div class="flex max-w-sm flex-col items-center gap-3 px-4 text-center">
            <span class="text-sm font-medium text-[var(--ui-text-highlighted)]">
                {{ t('errors.workspace.loadTitle') }}
            </span>
            <p class="text-sm text-[var(--ui-text-muted)]">
                {{ description }}
            </p>
            <div class="flex items-center gap-2">
                <UButton color="neutral" variant="outline" :label="t('common.retry')" @click="emit('retry')" />
                <UButton color="neutral" variant="outline" :label="t('common.close')" @click="emit('close')" />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
defineProps<{description: string;}>();
const emit = defineEmits<{
    close: [];
    retry: []
}>();
const { t } = useTypedI18n();
</script>
