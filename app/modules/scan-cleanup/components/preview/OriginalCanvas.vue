<template>
    <div class="raw-preview">
        <img
            v-if="pixelSwap.outgoingUrl"
            :key="pixelSwap.outgoingUrl"
            class="preview-pixel is-outgoing"
            :src="pixelSwap.outgoingUrl"
            alt=""
        >
        <img
            v-if="pixelSwap.currentUrl"
            :key="pixelSwap.currentUrl"
            class="preview-pixel"
            :class="{'is-entering': pixelSwap.entering}"
            :src="pixelSwap.currentUrl"
            :alt="alt"
            @transitionend="$emit('complete', pixelSwap.currentUrl)"
            @transitioncancel="$emit('complete', pixelSwap.currentUrl)"
        >
        <img
            v-if="pixelSwap.incomingUrl"
            :key="pixelSwap.incomingUrl"
            class="preview-pixel is-incoming"
            :src="pixelSwap.incomingUrl"
            alt=""
            @load="$emit('load', pixelSwap.incomingUrl)"
        >
        <span
            v-for="(style, index) in cropOverlayStyles"
            :key="`lossless-crop-${String(index)}`"
            class="lossless-crop-overlay"
            :style="style"
            aria-hidden="true"
        />
    </div>
</template>

<script setup lang="ts">
import type {CSSProperties} from 'vue';
import type {IScanCleanupPreviewImageSwap} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewImages';

defineProps<{
    alt: string;
    cropOverlayStyles: CSSProperties[];
    pixelSwap: IScanCleanupPreviewImageSwap;
}>();
defineEmits<{
    complete: [url: string];
    load: [url: string];
}>();
</script>
