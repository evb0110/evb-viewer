<template>
    <div
        ref="rootRef"
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
            @input="handleInputEvent"
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
import {
    annotationRectsEqual,
    expandTextBoxRectToContentSize,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';

interface ITextBoxCommitDraft {
    readonly text: string;
    readonly rect?: IAnnotationMarkerRect;
}

const props = defineProps<{
    entity: ITextBoxEntity;
    selected: boolean;
    editing?: boolean;
    autoSizeDraft?: boolean;
    displayRect?: IAnnotationMarkerRect | undefined;
}>();
const emit = defineEmits<{
    'pointer-down': [event: PointerEvent];
    edit: [];
    'draft-change': [];
    commit: [draft: ITextBoxCommitDraft];
    cancel: [];
}>();
const { t } = useTypedI18n();
const editing = computed(() => props.editing ?? false);
const rootRef = ref<HTMLElement | null>(null);
const draftRect = ref<IAnnotationMarkerRect | null>(null);
const inlineEdit = useTextBoxInlineEdit({
    entity: computed(() => props.entity),
    editing,
    onCommit: text => {
        const rect = draftRectForContent();
        emit('commit', {
            text,
            ...(rect ? {rect} : {}),
        });
    },
    onCancel: () => emit('cancel'),
});
const {
    commit,
    editorRef,
    handleInput,
    handleKeydown,
    handleBlur,
} = inlineEdit;

watch(editing, () => {
    draftRect.value = null;
});

function pixels(value: string) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function draftRectForContent(): IAnnotationMarkerRect | undefined {
    const root = rootRef.value;
    const editor = editorRef.value;
    const page = root?.closest<HTMLElement>('.pdf-annotation-editor-layer');
    const pageRect = page?.getBoundingClientRect();
    if (
        !props.autoSizeDraft
        || !root
        || !editor
        || !pageRect
        || pageRect.width <= 0
        || pageRect.height <= 0
        || !Number.isFinite(pageRect.width)
        || !Number.isFinite(pageRect.height)
    ) {
        return undefined;
    }
    const styles = getComputedStyle(root);
    const extraWidth = pixels(styles.paddingLeft)
        + pixels(styles.paddingRight)
        + pixels(styles.borderLeftWidth)
        + pixels(styles.borderRightWidth);
    const extraHeight = pixels(styles.paddingTop)
        + pixels(styles.paddingBottom)
        + pixels(styles.borderTopWidth)
        + pixels(styles.borderBottomWidth);

    const rootWidth = root.style.width;
    const rootHeight = root.style.height;
    const editorWidth = editor.style.width;
    const editorHeight = editor.style.height;
    const editorWhiteSpace = editor.style.whiteSpace;
    const editorOverflowWrap = editor.style.overflowWrap;
    let next = draftRect.value ?? props.entity.rect;
    try {
        root.style.width = 'max-content';
        root.style.height = 'auto';
        editor.style.width = 'max-content';
        editor.style.height = 'auto';
        editor.style.whiteSpace = 'pre';
        editor.style.overflowWrap = 'normal';
        const intrinsicEditorWidth = Math.max(
            editor.scrollWidth,
            editor.getBoundingClientRect().width,
        );
        const intrinsicWidth = (Math.ceil(intrinsicEditorWidth) + extraWidth) / pageRect.width;
        const baseRect = props.entity.rect;
        const width = Math.min(
            Math.max(baseRect.width, intrinsicWidth),
            Math.max(0, 1 - baseRect.left),
        );

        root.style.width = `${width * pageRect.width}px`;
        editor.style.width = '100%';
        editor.style.height = 'auto';
        editor.style.whiteSpace = 'pre-wrap';
        editor.style.overflowWrap = 'anywhere';
        const contentHeight = (editor.scrollHeight + extraHeight) / pageRect.height;
        next = expandTextBoxRectToContentSize(baseRect, width, contentHeight);
    } finally {
        root.style.width = rootWidth;
        root.style.height = rootHeight;
        editor.style.width = editorWidth;
        editor.style.height = editorHeight;
        editor.style.whiteSpace = editorWhiteSpace;
        editor.style.overflowWrap = editorOverflowWrap;
    }
    draftRect.value = next;
    return annotationRectsEqual(next, props.entity.rect) ? undefined : next;
}

function handleInputEvent(event: Event) {
    handleInput(event);
    if (props.autoSizeDraft) {
        draftRectForContent();
    }
    emit('draft-change');
}

interface IPdfTextBoxAnnotationExpose {commitDraft: () => void;}

const rectStyle = computed(() => ({
    left: `${(draftRect.value ?? props.displayRect ?? props.entity.rect).left * 100}%`,
    top: `${(draftRect.value ?? props.displayRect ?? props.entity.rect).top * 100}%`,
    width: `${(draftRect.value ?? props.displayRect ?? props.entity.rect).width * 100}%`,
    height: `${(draftRect.value ?? props.displayRect ?? props.entity.rect).height * 100}%`,
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
