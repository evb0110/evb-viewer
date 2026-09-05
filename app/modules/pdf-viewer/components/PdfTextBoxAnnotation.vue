<template>
    <div
        class="pdf-annotation-editor-entity pdf-annotation-editor-text-box"
        :class="{
            'is-selected': selected,
            'is-editing': editing,
        }"
        :style="rectStyle"
        :data-annotation-id="entity.identity.id"
        data-annotation-kind="text-box"
        :aria-label="entity.text || t('annotations.annotationLabel')"
        @mousedown.stop
        @pointerdown.stop="handlePointerDown"
        @dblclick.stop="handleEdit"
    >
        <div
            v-if="editing"
            ref="editorRef"
            class="pdf-annotation-editor-text-box__editor"
            contenteditable="true"
            role="textbox"
            :aria-label="entity.text || t('annotations.text')"
            spellcheck="false"
            @input="handleInput"
            @keydown="handleKeydown"
            @blur="handleBlur"
        ></div>
        <template v-else>{{ entity.text }}</template>
    </div>
</template>

<script setup lang="ts">
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { toPdfScaledCssLength } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { useTextBoxInlineEdit } from '@app/modules/pdf-viewer/annotations/editor/useTextBoxInlineEdit';

const props = defineProps<{
    entity: ITextBoxEntity;
    selected: boolean;
    editing?: boolean;
    displayRect?: IAnnotationMarkerRect | undefined;
}>();
const emit = defineEmits<{
    'pointer-down': [event: PointerEvent];
    edit: [];
    commit: [text: string];
    cancel: [];
}>();
const { t } = useTypedI18n();
const editing = computed(() => props.editing ?? false);
const inlineEdit = useTextBoxInlineEdit({
    entity: computed(() => props.entity),
    editing,
    onCommit: text => emit('commit', text),
    onCancel: () => emit('cancel'),
});
const {
    commit,
    editorRef,
    handleInput,
    handleKeydown,
    handleBlur,
} = inlineEdit;

interface IPdfTextBoxAnnotationExpose {commitDraft: () => void;}

const rectStyle = computed(() => ({
    left: `${(props.displayRect ?? props.entity.rect).left * 100}%`,
    top: `${(props.displayRect ?? props.entity.rect).top * 100}%`,
    width: `${(props.displayRect ?? props.entity.rect).width * 100}%`,
    height: `${(props.displayRect ?? props.entity.rect).height * 100}%`,
    color: props.entity.color ?? 'var(--ui-text)',
    fontSize: toPdfScaledCssLength(props.entity.fontSize),
    transform: `rotate(${props.entity.rotation}deg)`,
}));

function handlePointerDown(event: PointerEvent) {
    emit('pointer-down', event);
}

function handleEdit() {
    if (!editing.value) {
        emit('edit');
    }
}

defineExpose<IPdfTextBoxAnnotationExpose>({commitDraft: commit});
</script>
