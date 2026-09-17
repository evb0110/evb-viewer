<template>
    <div
        v-for="output in outputs"
        :key="`content-${output.metadata.half}`"
        class="content-overlay"
        :style="output.style"
        tabindex="0"
        role="group"
        :aria-label="groupLabels[output.metadata.half]"
        @dblclick.stop="$emit('reset', output.metadata.half)"
    >
        <button
            v-for="handle in handles"
            :key="handle"
            type="button"
            class="content-handle"
            :class="`is-${handle}`"
            :aria-label="handleLabels[output.metadata.half]?.[handle]"
            @pointerdown.stop="$emit('start', $event, output, handle)"
            @pointermove.stop="$emit('move', $event)"
            @pointerup.stop="$emit('finish', $event)"
            @pointercancel.stop="$emit('abort', $event)"
            @lostpointercapture.stop="$emit('lost-pointer-capture', $event)"
            @keydown.esc.stop.prevent="$emit('cancel')"
            @keydown="$emit('nudge', $event, output, handle)"
        />
    </div>
</template>

<script setup lang="ts">
import type {TScanCleanupOutputHalf} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    IScanCleanupContentOverlayOutput,
    TScanCleanupContentHandle,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPresentation';

defineProps<{
    groupLabels: Partial<Record<TScanCleanupOutputHalf, string>>;
    handleLabels: Partial<Record<TScanCleanupOutputHalf, Partial<Record<TScanCleanupContentHandle, string>>>>;
    handles: readonly TScanCleanupContentHandle[];
    outputs: IScanCleanupContentOverlayOutput[];
}>();
defineEmits<{
    abort: [event: PointerEvent];
    cancel: [];
    finish: [event: PointerEvent];
    'lost-pointer-capture': [event: PointerEvent];
    move: [event: PointerEvent];
    nudge: [event: KeyboardEvent, output: IScanCleanupContentOverlayOutput, handle: TScanCleanupContentHandle];
    reset: [half: TScanCleanupOutputHalf];
    start: [event: PointerEvent, output: IScanCleanupContentOverlayOutput, handle: TScanCleanupContentHandle];
}>();
</script>
