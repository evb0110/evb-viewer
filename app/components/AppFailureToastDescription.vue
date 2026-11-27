<template>
    <span class="app-toast-failure-description">
        <span v-if="reason" class="app-toast-failure-reason">{{ reason }}</span>
        <span class="app-toast-error-id">{{ errorIdLabel }}: {{ errorId }}</span>
    </span>
</template>

<script setup lang="ts">
const {
    reason = undefined,
    errorIdLabel,
    errorId,
} = defineProps<{
    reason?: string | undefined;
    errorIdLabel: string;
    errorId: string;
}>();
</script>
