<template>
    <button
        type="button"
        class="pdf-annotation-editor-entity pdf-annotation-editor-note"
        :class="{'is-selected': selected}"
        :style="noteStyle"
        :data-annotation-id="entity.identity.id"
        :data-stable-key="`ann:${entity.pageIndex}:${entity.identity.pdfRef ?? entity.identity.id}`"
        data-annotation-kind="note"
        :aria-label="t('annotations.openNote')"
        @mousedown.stop
        @pointerdown.stop="handlePointerDown"
        @keydown.enter.stop.prevent="handleDoubleClick"
        @keydown.space.stop.prevent="handleDoubleClick"
        @dblclick.stop="handleDoubleClick"
    >
        <UIcon name="i-ph-chat-circle-text" />
    </button>
</template>

<script setup lang="ts">
import type { INoteEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

const { t } = useTypedI18n();

const props = defineProps<{
    entity: INoteEntity;
    selected: boolean;
    displayRect?: INoteEntity['position'] | undefined;
}>();
const emit = defineEmits<{
    'pointer-down': [event: PointerEvent];
    'double-click': [];
}>();

const notePosition = computed(() => props.displayRect ?? props.entity.position);
const noteStyle = computed(() => ({
    left: `${notePosition.value.left * 100}%`,
    top: `${notePosition.value.top * 100}%`,
    width: `${Math.max(notePosition.value.width, 0.018) * 100}%`,
    height: `${Math.max(notePosition.value.height, 0.018) * 100}%`,
    color: props.entity.color ?? 'var(--ui-text)',
}));

function handlePointerDown(event: PointerEvent) {
    emit('pointer-down', event);
}

function handleDoubleClick() {
    emit('double-click');
}
</script>
