<template>
    <div
        v-for="output in outputs"
        :key="`placement-${output.metadata.half}`"
        class="placement-overlay-canvas"
        :style="output.canvasStyle"
    >
        <template v-if="output.active">
            <span
                v-for="anchor in anchors"
                :key="anchor.alignment"
                class="placement-snap-anchor"
                :class="{'is-nearest': anchor.alignment === output.alignment}"
                :style="anchor.style"
                aria-hidden="true"
            />
        </template>
        <div
            class="placement-control"
            :class="{'is-active': output.active}"
            :style="output.imageStyle"
            :tabindex="enabled ? 0 : -1"
            :role="enabled ? 'button' : undefined"
            :aria-label="enabled ? labels[output.metadata.half] : undefined"
            @pointerdown="$emit('start', $event, output)"
            @pointermove="$emit('move', $event)"
            @pointerup="$emit('finish', $event)"
            @pointercancel="$emit('abort', $event)"
            @lostpointercapture="$emit('lost-pointer-capture', $event)"
            @keydown.esc.stop.prevent="$emit('cancel')"
            @keydown="$emit('nudge', $event, output)"
        >
            <template v-if="output.active">
                <img
                    class="cleaned-image"
                    :src="output.pixelSwap.currentUrl"
                    :style="output.sourceCropStyle"
                    alt=""
                >
                <span class="margin-overlay" aria-hidden="true" />
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
import type {CSSProperties} from 'vue';
import type {
    TScanCleanupOutputHalf,
    TScanCleanupPageAlignment,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {IScanCleanupPlacementOverlayOutput} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPresentation';

defineProps<{
    anchors: Array<{
        alignment: TScanCleanupPageAlignment;
        style: CSSProperties
    }>;
    enabled: boolean;
    labels: Partial<Record<TScanCleanupOutputHalf, string>>;
    outputs: IScanCleanupPlacementOverlayOutput[];
}>();
defineEmits<{
    abort: [event: PointerEvent];
    cancel: [];
    finish: [event: PointerEvent];
    'lost-pointer-capture': [event: PointerEvent];
    move: [event: PointerEvent];
    nudge: [event: KeyboardEvent, output: IScanCleanupPlacementOverlayOutput];
    start: [event: PointerEvent, output: IScanCleanupPlacementOverlayOutput];
}>();
</script>
