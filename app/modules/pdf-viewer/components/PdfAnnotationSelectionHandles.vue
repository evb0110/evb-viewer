<template>
    <div
        v-if="rect"
        ref="handlesRef"
        class="pdf-annotation-selection-handles"
        :style="handlesStyle"
    >
        <AppTooltip
            v-if="entity?.kind === 'text-box'"
            :text="t('annotations.moveTextBox')"
        >
            <button
                ref="moveHandleRef"
                type="button"
                tabindex="-1"
                class="pdf-annotation-move-handle"
                data-pdf-annotation-move-handle
                :aria-label="t('annotations.moveTextBox')"
                :style="{transform: `translate(calc(-50% + ${moveOffset.x}px), ${moveOffset.y}px)`}"
                @pointerdown.stop.prevent="emit('move-start', $event)"
                @click.stop
                @dblclick.stop
            >
                <UIcon name="i-ph-arrows-out-cardinal" />
            </button>
        </AppTooltip>
        <span
            v-for="handle in handles"
            :key="handle"
            class="pdf-annotation-selection-handle"
            :class="`pdf-annotation-selection-handle--${handle}`"
            :data-pdf-annotation-resize-handle="handle"
            aria-hidden="true"
            @pointerdown.stop.prevent="handlePointerDown(handle, $event)"
        ></span>
    </div>
</template>

<script setup lang="ts">
import type { AnnotationEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { TAnnotationResizeHandle } from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';

const props = defineProps<{
    entity: AnnotationEntity | null;
    displayRect?: IAnnotationMarkerRect | undefined;
    viewRotation?: number;
}>();
const emit = defineEmits<{
    'resize-start': [handle: TAnnotationResizeHandle, event: PointerEvent];
    'move-start': [event: PointerEvent];
}>();
const {t} = useTypedI18n();
const handlesRef = ref<HTMLElement | null>(null);
const moveHandleRef = ref<HTMLElement | null>(null);
const moveOffset = shallowRef({
    x: 0,
    y: 0,
});

function positionMoveHandle() {
    const root = handlesRef.value;
    const grip = moveHandleRef.value;
    const viewport = root?.closest<HTMLElement>('.pdfViewer');
    if (!root || !grip || !viewport || !viewport.clientWidth || !viewport.clientHeight) {
        return;
    }
    const bounds = viewport.getBoundingClientRect();
    const button = grip.getBoundingClientRect();
    const angle = ((props.entity && 'rotation' in props.entity ? props.entity.rotation : 0) + (props.viewRotation ?? 0)) * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const naturalX = button.x + button.width / 2 - (moveOffset.value.x * cos - moveOffset.value.y * sin);
    const naturalY = button.y + button.height / 2 - (moveOffset.value.x * sin + moveOffset.value.y * cos);
    const left = bounds.left + viewport.clientLeft + button.width / 2;
    const top = bounds.top + viewport.clientTop + button.height / 2;
    const right = bounds.left + viewport.clientLeft + viewport.clientWidth - button.width / 2;
    const bottom = bounds.top + viewport.clientTop + viewport.clientHeight - button.height / 2;
    const fits = (x: number, y: number) => x >= left && x <= right && y >= top && y <= bottom;
    let x = naturalX;
    let y = naturalY;
    if (!fits(x, y)) {
        // Try the opposite edge before moving the grip inside the visible area.
        const gap = Number.parseFloat(getComputedStyle(grip).marginBottom) || 0;
        const oppositeDistance = root.offsetHeight + grip.offsetHeight + 2 * gap;
        const oppositeX = naturalX - oppositeDistance * sin;
        const oppositeY = naturalY + oppositeDistance * cos;
        if (fits(oppositeX, oppositeY)) {
            x = oppositeX;
            y = oppositeY;
        }
    }
    const dx = Math.max(left, Math.min(x, right)) - naturalX;
    const dy = Math.max(top, Math.min(y, bottom)) - naturalY;
    const next = {
        x: dx * cos + dy * sin,
        y: dy * cos - dx * sin,
    };
    if (Math.abs(next.x - moveOffset.value.x) > 0.25 || Math.abs(next.y - moveOffset.value.y) > 0.25) {
        moveOffset.value = next;
    }
}

watch([
    () => props.entity,
    () => props.displayRect,
    () => props.viewRotation,
], async () => {
    await nextTick();
    positionMoveHandle();
}, {flush: 'post'});
watch(handlesRef, (root, _previous, onCleanup) => {
    const viewport = root?.closest('.pdfViewer');
    if (!root || !viewport) {
        return;
    }
    const observer = new ResizeObserver(positionMoveHandle);
    observer.observe(root);
    observer.observe(viewport);
    viewport.addEventListener('scroll', positionMoveHandle, {passive: true});
    window.addEventListener('resize', positionMoveHandle);
    onCleanup(() => {
        observer.disconnect();
        viewport.removeEventListener('scroll', positionMoveHandle);
        window.removeEventListener('resize', positionMoveHandle);
    });
    positionMoveHandle();
}, {flush: 'post'});

function normalizeSelectionRect(value: IAnnotationMarkerRect): IAnnotationMarkerRect {
    const right = value.left + value.width;
    const bottom = value.top + value.height;
    return {
        left: Math.min(value.left, right),
        top: Math.min(value.top, bottom),
        width: Math.abs(value.width),
        height: Math.abs(value.height),
    };
}

const handles = computed(() => ([
    'nw',
    'n',
    'ne',
    'e',
    'se',
    's',
    'sw',
    'w',
] as const).filter(handle => props.entity?.kind !== 'text-box' || (handle !== 'n' && handle !== 's')));

const rect = computed(() => {
    const entity = props.entity;
    if (!entity) {
        return null;
    }
    return entity.kind === 'shape' || entity.kind === 'text-box' || entity.kind === 'placed-image'
        ? normalizeSelectionRect(props.displayRect ?? entity.rect)
        : null;
});

const handlesStyle = computed(() => rect.value ? {
    left: `${rect.value.left * 100}%`,
    top: `${rect.value.top * 100}%`,
    width: `${rect.value.width * 100}%`,
    height: `${rect.value.height * 100}%`,
    transform: `rotate(${props.entity && 'rotation' in props.entity ? props.entity.rotation : 0}deg)`,
} : undefined);

function handlePointerDown(handle: TAnnotationResizeHandle, event: PointerEvent) {
    if (props.entity?.kind === 'text-box' || props.entity?.kind === 'placed-image' || props.entity?.kind === 'shape') {
        emit('resize-start', handle, event);
    }
}
</script>
