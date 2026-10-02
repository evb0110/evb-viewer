<template>
    <div v-show="visible" class="workspace-document-alerts-root">
        <Transition name="document-status">
            <!-- Hidden, not unmounted, while converting: the convert dialog returns focus to its button. -->
            <DjvuBanner
                v-if="showDjvuBanner"
                v-show="!djvuConverting"
                @convert="handleConvert"
                @dismiss="handleDismiss"
            />
        </Transition>
    </div>
</template>

<script setup lang="ts">
import { DjvuBanner } from '@app/modules/djvu-viewer/public/component-exports/djvuBanner';

defineProps<{
    visible: boolean;
    showDjvuBanner: boolean;
    djvuConverting: boolean;
}>();

const emit = defineEmits<{
    convert: [];
    dismiss: [];
}>();

function handleConvert() {
    emit('convert');
}

function handleDismiss() {
    emit('dismiss');
}
</script>

<style scoped>
.workspace-document-alerts-root {
    display: contents;
}
</style>
