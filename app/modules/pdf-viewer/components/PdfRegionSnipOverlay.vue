<template>
    <div
        class="snip-live-region sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
    >
        {{ badgePosition ? copiedLabel : '' }}
    </div>
    <div
        v-if="shouldRender"
        ref="overlayRef"
        class="snip-overlay"
        :class="{ 'is-active': active }"
        :role="active ? 'dialog' : undefined"
        :aria-modal="active ? 'true' : undefined"
        :aria-label="active ? hintLabel : undefined"
        :tabindex="active ? 0 : -1"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="cancelSelection"
        @contextmenu="handleContextMenu"
        @wheel="handleWheel"
        @keydown="handleKeyboardKey"
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
import type { CSSProperties } from 'vue';
import type { ILocalRect } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';
import type {
    IRegionSelectionOverlayBaseProps,
    IRegionSelectionOverlayEmits,
} from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSelectionOverlay';
import { pdfRegionSnipKeyboardKey } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSnip';
import { useEmittedPdfRegionSelectionOverlay } from '@app/modules/pdf-viewer/runtime/composables/pdf/useEmittedPdfRegionSelectionOverlay';
import { usePdfSelectionOverlayFocus } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfSelectionOverlayFocus';
import { regionRectStyle } from '@app/modules/pdf-viewer/engine/region-selection/regionRectStyle';

interface IProps {
    active: IRegionSelectionOverlayBaseProps['active'];
    selectionRect: IRegionSelectionOverlayBaseProps['selectionRect'];
    hintLabel: IRegionSelectionOverlayBaseProps['hintLabel'];
    flashRect: ILocalRect | null;
    badgePosition: {
        x: number;
        y: number 
    } | null;
    copiedLabel: string;
}

const {
    active,
    selectionRect,
    hintLabel,
    flashRect,
    badgePosition,
    copiedLabel,
} = defineProps<IProps>();
const emit = defineEmits<IRegionSelectionOverlayEmits>();
const overlayRef = ref<HTMLElement | null>(null);
const keyboardController = inject(pdfRegionSnipKeyboardKey, null);

const {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleContextMenu,
    handleWheel,
} = useEmittedPdfRegionSelectionOverlay({
    get active() {
        return active;
    },
    get selectionRect() {
        return selectionRect;
    },
    get hintLabel() {
        return hintLabel;
    },
}, emit);

const shouldRender = computed(() => active || Boolean(flashRect) || Boolean(badgePosition));
const selectionStyle = computed(() => regionRectStyle(selectionRect));
const flashStyle = computed(() => regionRectStyle(flashRect));
const badgeStyle = computed<CSSProperties>(() => {
    if (!badgePosition) {
        return {};
    }
    return {
        left: `${badgePosition.x}px`,
        top: `${badgePosition.y}px`,
    };
});

function cancelSelection() {
    emit('cancel');
}

const {handleKeyboardKey} = usePdfSelectionOverlayFocus({
    isActive: () => active,
    overlayRef,
    keyboardController,
    onCancel: cancelSelection,
});
</script>

<style scoped>
.snip-overlay {
    position: absolute;
    inset: 0;
    z-index: var(--app-z-pdf-selection-overlay);
    overflow: hidden;
    pointer-events: none;
    user-select: none;
    outline: none;
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
