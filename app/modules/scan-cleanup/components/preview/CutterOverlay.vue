<template>
    <button
        v-if="visible"
        class="cutter-control"
        :class="{'is-refreshing': refreshing, 'is-horizontal': horizontal}"
        type="button"
        :style="style"
        :aria-label="label"
        aria-describedby="scan-cleanup-cutter-hint"
        @pointerdown="$emit('start', $event)"
        @pointermove="$emit('move', $event)"
        @pointerup="$emit('finish', $event)"
        @pointercancel="$emit('abort', $event)"
        @lostpointercapture="$emit('lost-pointer-capture', $event)"
        @keydown.esc.stop.prevent="$emit('cancel')"
        @dblclick.prevent="$emit('reset')"
        @keydown.left.prevent="!horizontal && $emit('nudge', -1, $event.shiftKey)"
        @keydown.right.prevent="!horizontal && $emit('nudge', 1, $event.shiftKey)"
        @keydown.up.prevent="horizontal && $emit('nudge', -1, $event.shiftKey)"
        @keydown.down.prevent="horizontal && $emit('nudge', 1, $event.shiftKey)"
    >
        <span class="cutter-line" :class="{'is-horizontal': horizontal}" aria-hidden="true" />
        <span class="cutter-grab-handle" :class="{'is-horizontal': horizontal}" aria-hidden="true">
            <UIcon name="i-ph-dots-six-vertical" class="size-4" />
        </span>
    </button>
    <span id="scan-cleanup-cutter-hint" class="sr-only">{{ hint }}</span>
</template>

<script setup lang="ts">
import type {CSSProperties} from 'vue';

defineProps<{
    hint: string;
    /** The split runs across the shown scan, as it does on a quarter-turned original. */
    horizontal?: boolean;
    label: string;
    refreshing: boolean;
    style: CSSProperties;
    visible: boolean;
}>();
defineEmits<{
    abort: [event: PointerEvent];
    cancel: [];
    finish: [event: PointerEvent];
    'lost-pointer-capture': [event: PointerEvent];
    move: [event: PointerEvent];
    nudge: [direction: -1 | 1, coarse: boolean];
    reset: [];
    start: [event: PointerEvent];
}>();
</script>
