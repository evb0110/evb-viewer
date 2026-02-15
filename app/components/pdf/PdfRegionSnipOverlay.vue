<template>
    <div
        v-if="shouldRender"
        class="snip-overlay"
        :class="{ 'is-active': active }"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="emit('cancel')"
        @contextmenu="handleContextMenu"
        @wheel="handleWheel"
    >
        <div
            v-if="selectionRect"
            class="snip-selection"
            :style="selectionStyle"
        />
        <div
            v-if="flashRect"
            class="snip-flash"
            :style="flashStyle"
        />
        <div
            v-if="badgePosition"
            class="snip-badge"
            :style="badgeStyle"
        >
            {{ copiedLabel }}
        </div>
        <div v-if="active && !selectionRect" class="snip-hint">
            {{ hintLabel }}
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    type CSSProperties,
} from 'vue';
import type {
    ILocalRect,
    ISnipPointerPayload,
} from '@app/composables/pdf/usePdfRegionSnip';

interface IProps {
    active: boolean;
    selectionRect: ILocalRect | null;
    flashRect: ILocalRect | null;
    badgePosition: {
        x: number;
        y: number 
    } | null;
    hintLabel: string;
    copiedLabel: string;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'pointer-start', payload: ISnipPointerPayload): void;
    (e: 'pointer-move', payload: ISnipPointerPayload): void;
    (e: 'pointer-end', payload: ISnipPointerPayload): void;
    (e: 'cancel'): void;
}>();

function buildPayload(event: PointerEvent): ISnipPointerPayload | null {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) {
        return null;
    }

    const rect = target.getBoundingClientRect();
    return {
        clientX: event.clientX,
        clientY: event.clientY,
        overlayRect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        },
    };
}

function handlePointerDown(event: PointerEvent) {
    if (!props.active || event.button !== 0) {
        return;
    }

    (event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId);
    const payload = buildPayload(event);
    if (payload) {
        emit('pointer-start', payload);
    }
}

function handlePointerMove(event: PointerEvent) {
    if (!props.active) {
        return;
    }
    const payload = buildPayload(event);
    if (payload) {
        emit('pointer-move', payload);
    }
}

function handlePointerUp(event: PointerEvent) {
    if (!props.active || event.button !== 0) {
        return;
    }
    const payload = buildPayload(event);
    if (payload) {
        emit('pointer-end', payload);
    }
}

function handleContextMenu(event: MouseEvent) {
    if (!props.active) {
        return;
    }
    event.preventDefault();
    emit('cancel');
}

function handleWheel(event: WheelEvent) {
    if (!props.active) {
        return;
    }
    event.preventDefault();
}

function rectStyle(rect: ILocalRect | null): CSSProperties {
    if (!rect) {
        return {};
    }
    return {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
    };
}

const shouldRender = computed(() => props.active || Boolean(props.flashRect) || Boolean(props.badgePosition));
const selectionStyle = computed(() => rectStyle(props.selectionRect));
const flashStyle = computed(() => rectStyle(props.flashRect));
const badgeStyle = computed<CSSProperties>(() => {
    if (!props.badgePosition) {
        return {};
    }
    return {
        left: `${props.badgePosition.x}px`,
        top: `${props.badgePosition.y}px`,
    };
});
</script>

<style scoped>
.snip-overlay {
    position: absolute;
    inset: 0;
    z-index: 50;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
}

.snip-overlay.is-active {
    pointer-events: auto;
    cursor: crosshair;
}

.snip-selection,
.snip-flash {
    position: absolute;
    box-sizing: border-box;
    border-radius: var(--app-snip-selection-radius);
}

.snip-selection {
    border: var(--app-snip-selection-border-width) solid var(--app-snip-selection-border);
    box-shadow: 0 0 0 9999px var(--app-snip-cutout-fill);
}

.snip-flash {
    border: 2px solid var(--app-snip-flash-border);
    background: var(--app-snip-flash-fill);
    box-shadow: 0 0 12px 2px var(--app-snip-flash-glow);
    animation: snip-flash 400ms ease-out forwards;
    pointer-events: none;
}

.snip-badge {
    position: absolute;
    transform: translateX(-50%);
    padding: var(--app-snip-badge-padding);
    border-radius: var(--app-snip-badge-radius);
    border: 1px solid var(--app-snip-badge-border);
    background: var(--app-snip-badge-bg);
    color: var(--app-snip-badge-fg);
    font-size: var(--app-snip-badge-font-size);
    line-height: 1;
    font-weight: 600;
    white-space: nowrap;
    box-shadow: var(--app-snip-badge-shadow);
    animation: snip-badge 200ms ease-out;
    pointer-events: none;
}

.snip-hint {
    position: absolute;
    top: var(--app-snip-hint-offset-top);
    left: 50%;
    transform: translateX(-50%);
    padding: var(--app-snip-hint-padding);
    border-radius: var(--app-snip-hint-radius);
    border: 1px solid var(--app-snip-hint-border);
    background: var(--app-snip-hint-bg);
    color: var(--app-snip-hint-fg);
    font-size: var(--app-snip-hint-font-size);
    line-height: 1;
    pointer-events: none;
    animation: snip-hint-enter 180ms ease-out;
}

@keyframes snip-flash {
    0% {
        opacity: 1;
    }

    35% {
        opacity: 0.7;
    }

    100% {
        opacity: 0;
        transform: scale(0.99);
    }
}

@keyframes snip-badge {
    from {
        opacity: 0;
        transform: translateX(-50%) translateY(4px) scale(0.95);
    }

    to {
        opacity: 1;
        transform: translateX(-50%) translateY(0) scale(1);
    }
}

@keyframes snip-hint-enter {
    from {
        opacity: 0;
        transform: translateX(-50%) translateY(-4px);
    }

    to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
    }
}
</style>
