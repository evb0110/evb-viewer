<template>
    <div
        ref="rootRef"
        class="pdf-annotation-editor-entity pdf-annotation-editor-text-box"
        :class="{
            'is-selected': selected,
            'is-editing': editing,
        }"
        :style="rectStyle"
        dir="auto"
        :data-annotation-id="entity.identity.id"
        data-annotation-kind="text-box"
        :aria-label="entity.text || t('annotations.annotationLabel')"
        @mousedown.stop
        @pointerdown.stop="emit('pointer-down', $event)"
        @dblclick.stop="!editing && emit('edit', $event)"
    >
        <span
            v-if="editing && !paintsOriginal && !nativeAppearance"
            :style="inputFrameStyle"
            aria-hidden="true"
        ></span>
        <div
            v-if="editing"
            ref="editorRef"
            class="pdf-annotation-editor-text-box__editor"
            contenteditable="true"
            dir="auto"
            role="textbox"
            :aria-label="entity.text || t('annotations.text')"
            spellcheck="false"
            @compositionstart="emit('draft-change', inlineEdit.draftText.value)"
            @compositionend="handleInputEvent"
            @input="handleInputEvent"
            @keydown="handleKeydown"
            @blur="handleBlur"
        ></div>
        <template v-else>{{ recoveredDraftText ?? entity.text }}</template>
    </div>
</template>

<script setup lang="ts">
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { toPdfScaledCssLength } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { useTextBoxInlineEdit } from '@app/modules/pdf-viewer/annotations/editor/useTextBoxInlineEdit';
import {
    annotationRectsEqual,
    annotationInlineCapacity,
    rotateAnnotationPointAround,
    rotatedAnnotationBounds,
    type TAnnotationResizeHandle,
    expandTextBoxRectToContentSize,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';

interface ITextBoxCommitDraft {
    readonly text: string;
    readonly rect?: IAnnotationMarkerRect;
    readonly restoreFocus?: boolean;
}

const props = defineProps<{
    entity: ITextBoxEntity;
    selected: boolean;
    editing?: boolean;
    originalAppearance?: boolean;
    nativeAppearance?: boolean;
    recoveredDraftText?: string | null;
    recoveredDraftRect?: IAnnotationMarkerRect | null;
    autoSizeDraft?: boolean;
    caretPoint?: {
        clientX: number;
        clientY: number
    } | null;
    displayRect?: IAnnotationMarkerRect | undefined;
    displayFontSize?: number | undefined;
    commitDraft?: (draft?: ITextBoxCommitDraft) => void | Promise<void>;
}>();
const emit = defineEmits<{
    'pointer-down': [event: PointerEvent];
    edit: [point: {
        clientX: number;
        clientY: number
    }];
    'draft-change': [text: string];
}>();
const { t } = useTypedI18n();
const editing = computed(() => props.editing ?? false);
const paintsOriginal = computed(() => props.entity.readOnly === true || props.originalAppearance === true);
const rootRef = ref<HTMLElement | null>(null);
const draftRect = ref<IAnnotationMarkerRect | null>(null);
const inlineEdit = useTextBoxInlineEdit({
    entity: computed(() => props.entity),
    editing,
    recoveredDraftText: computed(() => props.recoveredDraftText ?? null),
    caretPoint: computed(() => props.caretPoint ?? null),
    onCommit: (text, options) => {
        const rect = draftRect.value ?? props.recoveredDraftRect ?? (text !== props.entity.text ? draftRectForContent() : undefined);
        if (!props.commitDraft) throw new Error('Missing text draft completion owner');
        return props.commitDraft({
            text,
            restoreFocus: options?.restoreFocus ?? false,
            ...(rect ? {rect: {...rect}} : {}),
        });
    },
    onCancel: () => props.commitDraft?.(),
});
const {
    commit,
    editorRef,
    handleInput,
    handleKeydown,
    handleBlur,
} = inlineEdit;

watch(editing, async (value) => {
    draftRect.value = props.recoveredDraftRect ?? null;
    if (value && !props.recoveredDraftRect && (props.autoSizeDraft || props.recoveredDraftText != null && props.recoveredDraftText !== props.entity.text)) { await nextTick(); draftRectForContent(); }
}, {immediate: true});
onMounted(() => {
    void document.fonts?.ready.then(() => {if (editing.value && (draftRect.value || props.autoSizeDraft || inlineEdit.draftText.value !== props.entity.text)) {draftRectForContent();}});
});

watch(() => props.entity.fontSize, async () => {
    if (editing.value) { await nextTick(); draftRectForContent(); }
});

watch(() => props.entity.rect, async (rect, previous) => {
    if (annotationRectsEqual(rect, previous)) return;
    draftRect.value = editing.value ? rect : null;
    if (editing.value) { await nextTick(); draftRectForContent(); }
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
        !root
        || !editor
        || !pageRect
        || pageRect.width <= 0
        || pageRect.height <= 0
        || !Number.isFinite(pageRect.width)
        || !Number.isFinite(pageRect.height)
    ) {
        emit('draft-change', inlineEdit.draftText.value);
        return undefined;
    }
    const viewRotation = Number(page?.dataset.viewRotation ?? 0);
    const rotated = viewRotation === 90 || viewRotation === 270;
    const pageWidth = rotated ? pageRect.height : pageRect.width;
    const pageHeight = rotated ? pageRect.width : pageRect.height;
    const styles = getComputedStyle(root);
    const extraWidth = pixels(styles.paddingLeft)
        + pixels(styles.paddingRight)
        + pixels(styles.borderLeftWidth)
        + pixels(styles.borderRightWidth);
    const extraHeight = pixels(styles.paddingTop)
        + pixels(styles.paddingBottom)
        + pixels(styles.borderTopWidth)
        + pixels(styles.borderBottomWidth);

    const rootStyle = root.style.cssText;
    const editorStyle = editor.style.cssText;
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
            pixels(getComputedStyle(editor).width),
        );
        const intrinsicWidth = (Math.ceil(intrinsicEditorWidth) + extraWidth) / pageWidth;
        const baseRect = props.autoSizeDraft ? props.entity.rect : draftRect.value ?? props.entity.rect;
        const width = Math.min(
            props.autoSizeDraft ? Math.max(baseRect.width, intrinsicWidth) : baseRect.width,
            annotationInlineCapacity(baseRect, props.entity.rotation, {
                width: pageWidth,
                height: pageHeight,
            }),
        );

        root.style.width = `${width * pageWidth}px`;
        editor.style.width = '100%';
        editor.style.height = 'auto';
        editor.style.whiteSpace = 'pre-wrap';
        editor.style.overflowWrap = 'anywhere';
        const contentHeight = (editor.scrollHeight + extraHeight) / pageHeight;
        next = props.entity.rotation
            ? {
                ...baseRect,
                width,
                height: Math.max(props.entity.rect.height, contentHeight),
            }
            : expandTextBoxRectToContentSize({
                ...baseRect,
                height: props.entity.rect.height,
            }, width, contentHeight);
        if (props.entity.rotation) {
            const center = {
                x: baseRect.left + baseRect.width / 2,
                y: baseRect.top + baseRect.height / 2,
            };
            const nextCenter = rotateAnnotationPointAround({
                x: baseRect.left + next.width / 2,
                y: baseRect.top + next.height / 2,
            }, center, props.entity.rotation, {
                width: pageWidth,
                height: pageHeight,
            });
            next = {
                ...next,
                left: nextCenter.x - next.width / 2,
                top: nextCenter.y - next.height / 2,
            };
            const bounds = rotatedAnnotationBounds(next, props.entity.rotation, {
                width: pageWidth,
                height: pageHeight,
            });
            next.left += bounds.left < 0 ? -bounds.left : Math.min(0, 1 - bounds.left - bounds.width);
            next.top += bounds.top < 0 ? -bounds.top : Math.min(0, 1 - bounds.top - bounds.height);
        }
    } finally {
        root.style.cssText = rootStyle;
        editor.style.cssText = editorStyle;
    }
    draftRect.value = next;
    emit('draft-change', inlineEdit.draftText.value);
    return annotationRectsEqual(next, props.entity.rect) ? undefined : next;
}

function handleInputEvent(event: Event) {
    if (event instanceof InputEvent && event.isComposing) return;
    handleInput(event);
    draftRectForContent();
}

function fitRectToContent(rect: IAnnotationMarkerRect, handle?: TAnnotationResizeHandle, fontSize = props.entity.fontSize): IAnnotationMarkerRect | null {
    const root = rootRef.value;
    const layer = root?.closest<HTMLElement>('.pdf-annotation-editor-layer');
    const bounds = layer?.getBoundingClientRect();
    if (!root || !bounds?.width || !bounds.height) {
        return rect;
    }
    const rotation = Number(layer?.dataset.viewRotation ?? 0);
    const swapped = rotation === 90 || rotation === 270;
    const pageWidth = swapped ? bounds.height : bounds.width;
    const pageHeight = swapped ? bounds.width : bounds.height;
    const measurement = root.cloneNode(false) as HTMLElement;
    measurement.textContent = (editing.value ? inlineEdit.draftText.value : props.entity.text) || '\u00a0';
    measurement.removeAttribute('data-annotation-id');
    Object.assign(measurement.style, {
        width: `${rect.width * pageWidth}px`,
        height: 'auto',
        fontSize: toPdfScaledCssLength(fontSize),
        visibility: 'hidden',
        pointerEvents: 'none',
        transform: 'none',
    });
    root.parentElement?.append(measurement);
    try {
        const contentHeight = measurement.scrollHeight / pageHeight;
        const height = (handle === 'e' || handle === 'w' || fontSize !== props.entity.fontSize) && contentHeight > 0
            ? contentHeight
            : Math.max(rect.height, contentHeight);
        const anchorY = handle?.includes('n') ? 1 : !handle || handle.includes('s') ? 0 : 0.5;
        const center = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
        const nextCenter = rotateAnnotationPointAround({
            x: center.x,
            y: center.y + (height - rect.height) * (0.5 - anchorY),
        }, center, props.entity.rotation, {
            width: pageWidth,
            height: pageHeight,
        });
        const fitted = {
            ...rect,
            left: nextCenter.x - rect.width / 2,
            top: nextCenter.y - height / 2,
            height,
        };
        const footprint = rotatedAnnotationBounds(fitted, props.entity.rotation, {
            width: pageWidth,
            height: pageHeight,
        });
        if (!handle && footprint.width <= 1 && footprint.height <= 1) {
            fitted.left += footprint.left < 0 ? -footprint.left : Math.min(0, 1 - footprint.left - footprint.width);
            fitted.top += footprint.top < 0 ? -footprint.top : Math.min(0, 1 - footprint.top - footprint.height);
            return fitted;
        }
        return footprint.left < -1e-8 || footprint.top < -1e-8 || footprint.left + footprint.width > 1 + 1e-8 || footprint.top + footprint.height > 1 + 1e-8
            ? null
            : fitted;
    } finally { measurement.remove(); }
}

// Keep the browser editor's content inset; the page renderer owns frame ink.
const frameInsets = computed(() => {
    const insets = props.entity.readOnly ? undefined : props.entity.frame?.insets;
    return insets?.map((_, side) => insets[(side + props.entity.rotation / 90) % 4]!);
});
const inputFrameStyle = computed(() => props.entity.frame && frameInsets.value ? {
    position: 'absolute' as const,
    inset: frameInsets.value.map(inset => toPdfScaledCssLength(inset)).join(' '),
    boxShadow: props.entity.frame.borderColor ? `inset 0 0 0 ${toPdfScaledCssLength(props.entity.frame.borderWidth)} ${props.entity.frame.borderColor}` : 'none',
    background: props.entity.frame.background ?? 'transparent',
    zIndex: -1,
    pointerEvents: 'none' as const,
} : undefined);
const framePadding = computed(() => {
    const frame = props.entity.frame;
    return frame && frameInsets.value
        ? {padding: frameInsets.value.map((inset, side) => (
            `calc(${toPdfScaledCssLength(inset + frame.borderWidth)} + ${side % 2 ? 0.3 : 0.15}em)`
        )).join(' ')}
        : {};
});

const rectStyle = computed(() => ({
    left: `${(props.displayRect ?? draftRect.value ?? props.recoveredDraftRect ?? props.entity.rect).left * 100}%`,
    top: `${(props.displayRect ?? draftRect.value ?? props.recoveredDraftRect ?? props.entity.rect).top * 100}%`,
    width: `${(props.displayRect ?? draftRect.value ?? props.recoveredDraftRect ?? props.entity.rect).width * 100}%`,
    height: `${(props.displayRect ?? draftRect.value ?? props.recoveredDraftRect ?? props.entity.rect).height * 100}%`,
    // Resting text stays selectable and accessible; only the real editor paints DOM glyphs.
    color: !editing.value || paintsOriginal.value || props.nativeAppearance ? 'transparent' : props.entity.color ?? 'var(--ui-text)',
    caretColor: props.entity.color ?? 'var(--ui-text)',
    cursor: props.entity.readOnly ? 'default' : undefined,
    fontSize: toPdfScaledCssLength(props.displayFontSize ?? props.entity.fontSize),
    transform: `rotate(${props.entity.rotation}deg)`,
    ...framePadding.value,
}));

defineExpose({
    commitDraft: commit,
    getDraftRect: () => toRaw(draftRect.value ?? props.recoveredDraftRect ?? props.entity.rect),
    get pendingCompletion() { return inlineEdit.pendingCompletion; },
    fitRectToContent,
});
</script>

<style scoped>
.pdf-annotation-editor-text-box:not(.is-editing)::selection {
    color: transparent;
    background: var(--app-pdf-text-selection-bg);
}
</style>
