<template>
    <PdfContextMenuBase
        class="annotation-context-menu"
        :visible="menu.visible"
        :style="style"
        variant="grid"
        min-width="var(--app-context-menu-preferred-width)"
        :accessible-label="t('contextMenu.annotationMenu')"
    >
        <template v-if="menu.comment">
            <p class="pdf-context-menu__section-title">
                <span
                    v-if="menu.comment.color"
                    class="annotation-context-menu-color-swatch"
                    :style="{ background: menu.comment.color }"
                />
                {{ annotationLabel }}
            </p>
            <button
                v-if="canOpenNote && !isImageComment"
                type="button"
                class="pdf-context-menu__action"
                role="menuitem"
                @click="openNote"
            >
                {{ t('contextMenu.openPopUpNote') }}
            </button>
            <button
                v-if="!isImageComment"
                type="button"
                class="pdf-context-menu__action"
                role="menuitem"
                :disabled="!canCopy"
                @click="copyText"
            >
                {{ t('contextMenu.copyTextToClipboard') }}
            </button>
            <div
                v-if="canEditColor"
                class="annotation-context-menu-color-row"
            >
                <span class="annotation-context-menu-color-label">{{ t('annotationProperties.color') }}</span>
                <div class="annotation-context-menu-color-swatches">
                    <button
                        v-for="swatch in ANNOTATION_COLOR_SWATCHES"
                        :key="swatch"
                        type="button"
                        class="annotation-context-menu-color-button"
                        :class="{ 'is-active': normalizeColorValue(swatch) === normalizeColorValue(editableColor) }"
                        :style="{ backgroundColor: swatch }"
                        :aria-label="swatch"
                        :aria-pressed="normalizeColorValue(swatch) === normalizeColorValue(editableColor)"
                        @click="updateColor(swatch)"
                    />
                </div>
            </div>
            <button
                type="button"
                class="pdf-context-menu__action pdf-context-menu__action--danger"
                role="menuitem"
                @click="deleteAnnotation"
            >
                {{ deleteLabel }}
            </button>
            <div class="pdf-context-menu__divider" />
        </template>

        <template v-if="menu.hasSelection">
            <p class="pdf-context-menu__section-title">
                {{ t('contextMenu.markupSelection') }}
            </p>
            <button
                type="button"
                class="pdf-context-menu__action"
                role="menuitem"
                :disabled="!canCopySelection"
                @click="copySelectionText"
            >
                {{ t('contextMenu.copyTextToClipboard') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                role="menuitem"
                @click="markupHighlight"
            >
                {{ t('contextMenu.highlight') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                role="menuitem"
                @click="markupUnderline"
            >
                {{ t('contextMenu.underline') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                role="menuitem"
                @click="markupStrikethrough"
            >
                {{ t('contextMenu.strikethrough') }}
            </button>
            <button
                type="button"
                class="pdf-context-menu__action"
                role="menuitem"
                @click="markupSquiggly"
            >
                {{ t('contextMenu.squiggly') }}
            </button>
            <div class="pdf-context-menu__divider" />
        </template>

        <p class="pdf-context-menu__section-title">
            {{ t('contextMenu.addNote') }}
        </p>
        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            :disabled="!canCreateFree"
            @click="createFreeNote"
        >
            {{ t('contextMenu.addNoteHere') }}
        </button>
        <button
            v-if="menu.hasSelection"
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            @click="createSelectionNote"
        >
            {{ t('contextMenu.addNoteToSelection') }}
        </button>
        <div class="pdf-context-menu__divider" />
        <p class="pdf-context-menu__section-title">
            {{ t('contextMenu.insertImage') }}
        </p>
        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            :disabled="!canInsertImage"
            @click="insertImageFromFile"
        >
            {{ t('contextMenu.insertImageFromFile') }}
        </button>
        <button
            type="button"
            class="pdf-context-menu__action"
            role="menuitem"
            :disabled="!canInsertImage"
            @click="pasteImageFromClipboard"
        >
            {{ t('contextMenu.pasteImageFromClipboard') }}
        </button>
    </PdfContextMenuBase>
</template>

<script setup lang="ts">
import PdfContextMenuBase from '@app/modules/pdf-viewer/components/PdfContextMenuBase.vue';
import type { TAnnotationTool } from '@app/types/annotations';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { parseCssRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/parseCssRgbColor';
import { rgbToHex } from '@app/modules/pdf-viewer/engine/text-markup-color/rgbToHex';
import type { IAnnotationContextMenuState } from '@app/types/pdfContextMenu';
import { isNoteEligibleComment } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isNoteEligibleComment';

const {
    menu,
    style,
    canCopy,
    canCopySelection,
    canCreateFree,
    canInsertImage,
    annotationLabel,
    deleteLabel,
    isImageComment = false,
} = defineProps<{
    menu: IAnnotationContextMenuState;
    style: Record<string, string>;
    canCopy: boolean;
    canCopySelection: boolean;
    canCreateFree: boolean;
    canInsertImage: boolean;
    annotationLabel: string;
    deleteLabel: string;
    isImageComment?: boolean;
}>();

const emit = defineEmits<{
    'open-note': [];
    'copy-text': [];
    'copy-selection-text': [];
    'delete': [];
    'update-color': [color: string];
    'markup': [tool: TAnnotationTool];
    'create-free-note': [];
    'create-selection-note': [];
    'insert-image-from-file': [];
    'paste-image-from-clipboard': [];
}>();

const { t } = useTypedI18n();

const EDITABLE_COLOR_SUBTYPES = new Set([
    'highlight',
    'underline',
    'strikeout',
    'strikethrough',
    'squiggly',
    'text',
]);

function getFallbackColorForSubtype(subtype: string | null | undefined) {
    const normalizedSubtype = subtype?.trim().toLowerCase() ?? '';
    if (normalizedSubtype === 'underline') {
        return DEFAULT_ANNOTATION_SETTINGS.underlineColor;
    }
    if (normalizedSubtype === 'strikeout' || normalizedSubtype === 'strikethrough') {
        return DEFAULT_ANNOTATION_SETTINGS.strikethroughColor;
    }
    if (normalizedSubtype === 'squiggly') {
        return DEFAULT_ANNOTATION_SETTINGS.squigglyColor;
    }
    if (normalizedSubtype === 'text') {
        return DEFAULT_ANNOTATION_SETTINGS.textColor;
    }
    return DEFAULT_ANNOTATION_SETTINGS.highlightColor;
}

const canOpenNote = computed(() => {
    const comment = menu.comment;
    return isNoteEligibleComment(comment);
});

function normalizeColorInputValue(
    color: string | null | undefined,
    subtype: string | null | undefined,
) {
    const value = color?.trim() ?? '';
    const parsed = parseCssRgbColor(value);
    if (parsed) {
        return rgbToHex(parsed);
    }
    const match = /^#(?<hex>[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
    const hex = match?.groups?.hex;
    if (!hex) {
        return getFallbackColorForSubtype(subtype);
    }
    return hex.length === 3
        ? `#${hex.split('').map(channel => channel + channel).join('')}`
        : `#${hex}`;
}

const canEditColor = computed(() => {
    const subtype = menu.comment?.subtype?.trim().toLowerCase() ?? '';
    return EDITABLE_COLOR_SUBTYPES.has(subtype);
});

const editableColor = computed(() => normalizeColorInputValue(
    menu.comment?.color,
    menu.comment?.subtype,
));

function normalizeColorValue(color: string | null | undefined) {
    return color?.trim().toLowerCase() ?? '';
}

function openNote() {
    emit('open-note');
}

function copyText() {
    emit('copy-text');
}

function copySelectionText() {
    emit('copy-selection-text');
}

function deleteAnnotation() {
    emit('delete');
}

function updateColor(color: string) {
    emit('update-color', color);
}

function markupHighlight() {
    emit('markup', 'highlight');
}

function markupUnderline() {
    emit('markup', 'underline');
}

function markupStrikethrough() {
    emit('markup', 'strikethrough');
}

function markupSquiggly() {
    emit('markup', 'squiggly');
}

function createFreeNote() {
    emit('create-free-note');
}

function createSelectionNote() {
    emit('create-selection-note');
}

function insertImageFromFile() {
    emit('insert-image-from-file');
}

function pasteImageFromClipboard() {
    emit('paste-image-from-clipboard');
}
</script>

<style scoped>
.annotation-context-menu-color-swatch {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: var(--app-space-3xs);
    flex-shrink: 0;
    border: 1px solid var(--app-pdf-context-menu-swatch-border);
}

.annotation-context-menu-color-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--app-space-2xl);
    padding: var(--app-space-4xl) var(--app-space-5xl);
    background: var(--app-pdf-context-menu-item-bg);
    font-size: var(--app-text-size-body-sm);
    border-block: var(--app-hairline-height) solid var(--app-pdf-context-menu-divider);
}

.annotation-context-menu-color-label {
    color: var(--ui-text);
}

.annotation-context-menu-color-swatches {
    display: grid;
    grid-template-columns: repeat(9, var(--app-annotation-context-swatch-size));
    gap: var(--app-space-sm);
}

.annotation-context-menu-color-button {
    width: var(--app-annotation-context-swatch-size);
    height: var(--app-annotation-context-swatch-size);
    padding: 0;
    border: 1px solid color-mix(in oklab, var(--app-pdf-color-swatch-border) 45%, transparent);
    border-radius: 0.3rem;
    cursor: pointer;
}

.annotation-context-menu-color-button.is-active {
    border-color: var(--app-sidebar-bg);
    box-shadow:
        0 0 0 1px var(--app-sidebar-bg),
        0 0 0 3px var(--ui-text);
}
</style>
