<template>
    <AppTooltip
        :text="tooltipText"
        :delay-duration="200"
        :disabled="shouldSuppressTooltip"
        :open="controlledTooltipOpen"
        usefulness="always"
        @update:open="handleTooltipOpenUpdate"
    >
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
            @pointerenter="handlePointerEnter"
            @pointerleave="handlePointerLeave"
            @click.stop="handleActivate"
            @keydown.enter.stop.prevent="handleActivate"
            @keydown.space.stop.prevent="handleActivate"
        >
            <UIcon name="i-ph-chat-circle-text" />
        </button>
    </AppTooltip>
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
    activate: [];
}>();

const notePosition = computed(() => props.displayRect ?? props.entity.position);
const tooltipText = computed(() => {
    const text = props.entity.contents.trim();
    if (!text) {
        return t('annotations.emptyNote');
    }
    return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
});
const isTooltipSuppressed = ref(false);
const isTooltipOpen = ref(false);
const isPointerOver = ref(false);
const shouldSuppressTooltip = computed(() => isTooltipSuppressed.value);
const controlledTooltipOpen = computed(() =>
    shouldSuppressTooltip.value ? false : isTooltipOpen.value,
);
const noteStyle = computed(() => ({
    '--annotation-note-color': props.entity.color ?? 'var(--ui-warning)',
    left: `${(notePosition.value.left + notePosition.value.width / 2) * 100}%`,
    top: `${(notePosition.value.top + notePosition.value.height / 2) * 100}%`,
}));

function handlePointerDown(event: PointerEvent) {
    if (event.button === 0) {
        suppressTooltipUntilPointerExit();
    }
    emit('pointer-down', event);
}

function handleTooltipOpenUpdate(open: boolean) {
    isTooltipOpen.value = shouldSuppressTooltip.value ? false : open;
}

function suppressTooltipUntilPointerExit() {
    isTooltipSuppressed.value = true;
    isTooltipOpen.value = false;
}

function releaseTooltipAfterPointerLeave() {
    if (!isPointerOver.value) {
        isTooltipSuppressed.value = false;
    }
}

function handlePointerEnter() {
    isPointerOver.value = true;
}

function handlePointerLeave() {
    isPointerOver.value = false;
    releaseTooltipAfterPointerLeave();
}

watch(() => props.selected, selected => {
    if (selected && isPointerOver.value) {
        suppressTooltipUntilPointerExit();
    }
    else if (!isPointerOver.value) {
        releaseTooltipAfterPointerLeave();
    }
});

function handleActivate(event: MouseEvent | KeyboardEvent) {
    if ('button' in event && event.shiftKey) {
        if (isPointerOver.value) {
            suppressTooltipUntilPointerExit();
        }
        return;
    }
    if (isPointerOver.value) {
        suppressTooltipUntilPointerExit();
    }
    emit('activate');
}
</script>
