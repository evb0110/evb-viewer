<template>
    <div class="notes-panel" @click="closeContextMenu">
        <section class="notes-section notes-tools">
            <header class="notes-section-header">
                <h3 class="notes-section-title">{{ t('annotations.create') }}</h3>
                <p class="notes-section-description">{{ t('annotations.createDescription') }}</p>
            </header>

            <div class="tool-grid">
                <button
                    v-for="toolItem in toolItems"
                    :key="toolItem.id"
                    type="button"
                    class="tool-button"
                    :class="{ 'is-active': tool === toolItem.id }"
                    @click="emit('set-tool', tool === toolItem.id ? 'none' : toolItem.id)"
                >
                    <UIcon :name="toolItem.icon" class="tool-button-icon" />
                    <span class="tool-button-label">{{ toolItem.label }}</span>
                </button>
            </div>

            <label class="keep-active-toggle">
                <input
                    type="checkbox"
                    :checked="keepActive"
                    @change="emit('update:keep-active', ($event.target as HTMLInputElement).checked)"
                />
                {{ t('annotations.keepActive') }}
            </label>
        </section>

        <section class="notes-section notes-style">
            <header class="notes-section-header">
                <h3 class="notes-section-title">{{ t('annotations.style') }}</h3>
                <p class="notes-section-description">{{ t('annotations.styleDescription') }}</p>
            </header>

            <div class="style-row">
                <label class="style-label" for="annotation-color-input">{{ t('annotations.color') }}</label>
                <input
                    id="annotation-color-input"
                    class="style-color"
                    type="color"
                    :value="activeToolColor"
                    @input="handleColorInput(($event.target as HTMLInputElement).value)"
                />
            </div>

            <div class="swatch-row">
                <button
                    v-for="swatch in colorSwatches"
                    :key="swatch"
                    type="button"
                    class="swatch"
                    :style="{ backgroundColor: swatch }"
                    :title="swatch"
                    @click="handleColorInput(swatch)"
                />
            </div>

            <div v-if="activeWidthControl" class="style-row style-row-width">
                <label class="style-label" for="annotation-width-input">
                    {{ activeWidthControl.label }} {{ activeWidthValue }}
                </label>
                <div class="style-width-control">
                    <button
                        type="button"
                        class="style-step-button"
                        :aria-label="t('annotations.decreaseWidth')"
                        @click="nudgeWidth(-activeWidthControl.step)"
                    >
                        -
                    </button>
                    <input
                        id="annotation-width-input"
                        class="style-range"
                        type="range"
                        :min="activeWidthControl.min"
                        :max="activeWidthControl.max"
                        :step="activeWidthControl.step"
                        :value="activeWidthValue"
                        @input="handleWidthInput(Number(($event.target as HTMLInputElement).value))"
                    />
                    <button
                        type="button"
                        class="style-step-button"
                        :aria-label="t('annotations.increaseWidth')"
                        @click="nudgeWidth(activeWidthControl.step)"
                    >
                        +
                    </button>
                </div>
            </div>

            <div v-if="tool === 'draw'" class="draw-style-row">
                <span class="style-label">{{ t('annotations.penType') }}</span>
                <div class="draw-style-list">
                    <button
                        v-for="preset in drawStylePresets"
                        :key="preset.id"
                        type="button"
                        class="draw-style-button"
                        :class="{ 'is-active': activeDrawStyle === preset.id }"
                        @click="applyDrawStyle(preset.id)"
                    >
                        {{ preset.label }}
                    </button>
                </div>
            </div>
        </section>

        <section class="notes-section notes-sticky">
            <header class="notes-section-header">
                <h3 class="notes-section-title">{{ t('annotations.stickyNotes') }}</h3>
                <p class="notes-section-description">{{ t('annotations.stickyDescription') }}</p>
            </header>

            <div class="sticky-actions">
                <button
                    type="button"
                    class="sticky-action"
                    @click="emit('comment-selection')"
                >
                    <UIcon name="i-lucide-message-circle" class="sticky-action-icon" />
                    <span>{{ t('annotations.addNoteToSelection') }}</span>
                </button>
                <button
                    type="button"
                    class="sticky-action"
                    :class="{ 'is-active': placingPageNote }"
                    @click="emit('start-place-note')"
                >
                    <UIcon name="i-lucide-plus" class="sticky-action-icon" />
                    <span>{{ placingPageNote ? t('annotations.cancelPlaceMode') : t('annotations.placeNoteOnPage') }}</span>
                </button>
            </div>

            <p class="sticky-hint">
                {{ placingPageNote ? t('annotations.placeHint') : t('annotations.defaultHint') }}
            </p>
        </section>

        <section v-if="pagesWithNotes.length > 0" class="notes-section notes-pages">
            <header class="notes-section-header">
                <h3 class="notes-section-title">{{ t('annotations.whereNotes') }}</h3>
                <p class="notes-section-description">{{ t('annotations.whereNotesDescription') }}</p>
            </header>

            <div class="page-chip-list">
                <button
                    v-for="item in pagesWithNotes"
                    :key="item.pageNumber"
                    type="button"
                    class="page-chip"
                    :class="{ 'is-current': item.pageNumber === currentPage }"
                    @click="focusFirstCommentOnPage(item.pageNumber)"
                >
                    <span class="page-chip-label">{{ t('annotations.page') }} {{ item.pageNumber }}</span>
                    <span class="page-chip-count">• {{ t('annotations.noteCount', item.noteCount) }}</span>
                </button>
            </div>
        </section>

        <section class="notes-section notes-list-section">
            <UCollapsible :default-open="false" :unmount-on-hide="false">
                <template #default="{ open }">
                    <button
                        type="button"
                        class="notes-list-trigger"
                        :aria-expanded="open ? 'true' : 'false'"
                    >
                        <span class="notes-list-trigger-meta">
                            <h3 class="notes-section-title">{{ t('annotations.notesList') }}</h3>
                            <span class="notes-count">{{ filteredComments.length }}</span>
                        </span>
                        <UIcon
                            name="i-lucide-chevron-down"
                            class="notes-list-chevron"
                            :class="{ 'is-open': open }"
                        />
                    </button>
                </template>

                <template #content>
                    <input
                        v-model.trim="query"
                        type="search"
                        class="notes-search"
                        :placeholder="t('annotations.searchNotes')"
                    />

                    <div class="notes-list app-scrollbar" @click.self="selectedStableKey = null">
                        <button
                            v-for="comment in filteredComments"
                            :key="comment.stableKey"
                            type="button"
                            class="note-item"
                            :class="{ 'is-selected': selectedStableKey === comment.stableKey }"
                            @click="selectComment(comment)"
                            @dblclick.prevent.stop="openComment(comment)"
                            @contextmenu.prevent.stop="openItemContextMenu($event, comment)"
                        >
                            <span class="note-item-top">
                                <span class="note-item-page">P{{ comment.pageNumber }}</span>
                                <span class="note-item-type">{{ commentTypeLabel(comment) }}</span>
                            </span>
                            <span class="note-item-text">{{ notePreview(comment) }}</span>
                            <span class="note-item-meta">
                                <span>{{ comment.author || appSettings.authorName || t('annotations.unknownAuthor') }}</span>
                                <span v-if="comment.modifiedAt">{{ formatTime(comment.modifiedAt) }}</span>
                            </span>
                        </button>

                        <p v-if="filteredComments.length === 0" class="notes-empty">
                            {{ t('annotations.noNotesFound') }}
                        </p>
                    </div>

                    <div class="selection-actions">
                        <button
                            type="button"
                            class="selection-action"
                            :disabled="!selectedComment"
                            @click="openSelectedComment"
                        >
                            {{ t('annotations.openNote') }}
                        </button>
                        <button
                            type="button"
                            class="selection-action"
                            :disabled="!canCopySelectedComment"
                            @click="copySelectedComment"
                        >
                            {{ t('annotations.copyText') }}
                        </button>
                        <button
                            type="button"
                            class="selection-action is-danger"
                            :disabled="!selectedComment"
                            @click="deleteSelectedComment"
                        >
                            {{ t('annotations.delete') }}
                        </button>
                    </div>
                </template>
            </UCollapsible>
        </section>

        <div
            v-if="contextMenu.visible"
            class="notes-context-menu"
            :style="contextMenuStyle"
            @click.stop
        >
            <button
                type="button"
                class="context-menu-action"
                :disabled="!contextMenu.comment"
                @click="openContextComment"
            >
                {{ t('annotations.openNote') }}
            </button>
            <button
                type="button"
                class="context-menu-action"
                :disabled="!contextMenu.comment"
                @click="copyContextComment"
            >
                {{ t('annotations.copyText') }}
            </button>
            <button
                type="button"
                class="context-menu-action is-danger"
                :disabled="!contextMenu.comment"
                @click="deleteContextComment"
            >
                {{ t('annotations.delete') }}
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    ref,
    watch,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';

interface IProps {
    tool: TAnnotationTool;
    keepActive: boolean;
    settings: IAnnotationSettings;
    comments: IAnnotationCommentSummary[];
    currentPage: number;
    activeCommentStableKey?: string | null;
    placingPageNote?: boolean;
}

type TDrawStyle = 'pen' | 'pencil' | 'marker';

interface IToolItem {
    id: TAnnotationTool;
    label: string;
    icon: string;
    hint: string;
}

interface IWidthControl {
    key: 'inkThickness' | 'highlightThickness' | 'shapeStrokeWidth' | 'textSize';
    min: number;
    max: number;
    step: number;
    label: string;
}

interface IPageAnnotationOverview {
    pageNumber: number;
    noteCount: number;
}

interface IDrawStylePreset {
    id: TDrawStyle;
    label: string;
    thickness: number;
    opacity: number;
}

const { t } = useI18n();
const { settings: appSettings } = useSettings();

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-tool', tool: TAnnotationTool): void;
    (e: 'update:keep-active', value: boolean): void;
    (e: 'update-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }): void;
    (e: 'comment-selection'): void;
    (e: 'focus-comment', comment: IAnnotationCommentSummary): void;
    (e: 'open-note', comment: IAnnotationCommentSummary): void;
    (e: 'copy-comment', comment: IAnnotationCommentSummary): void;
    (e: 'delete-comment', comment: IAnnotationCommentSummary): void;
    (e: 'start-place-note'): void;
}>();

const toolItems = computed<IToolItem[]>(() => [
    {
        id: 'draw',
        label: t('annotations.draw'),
        icon: 'i-lucide-pen-tool',
        hint: 'Freehand pen or pencil drawing',
    },
    {
        id: 'text',
        label: t('annotations.text'),
        icon: 'i-lucide-type',
        hint: 'Place free text on the page',
    },
    {
        id: 'highlight',
        label: t('annotations.highlight'),
        icon: 'i-lucide-highlighter',
        hint: 'Highlight text selection',
    },
    {
        id: 'underline',
        label: t('annotations.underline'),
        icon: 'i-lucide-underline',
        hint: 'Underline text selection',
    },
    {
        id: 'strikethrough',
        label: t('annotations.strikethrough'),
        icon: 'i-lucide-strikethrough',
        hint: 'Cross out text selection',
    },
    {
        id: 'rectangle',
        label: t('annotations.rectangle'),
        icon: 'i-lucide-square',
        hint: 'Draw rectangle shapes',
    },
    {
        id: 'circle',
        label: t('annotations.circle'),
        icon: 'i-lucide-circle',
        hint: 'Draw circle shapes',
    },
    {
        id: 'line',
        label: t('annotations.line'),
        icon: 'i-lucide-minus',
        hint: 'Draw straight lines',
    },
    {
        id: 'arrow',
        label: t('annotations.arrow'),
        icon: 'i-lucide-arrow-up-right',
        hint: 'Draw arrows',
    },
]);

const colorSwatches = [
    '#111827',
    '#ef4444',
    '#f59e0b',
    '#eab308',
    '#22c55e',
    '#06b6d4',
    '#3b82f6',
    '#8b5cf6',
    '#ec4899',
];

const drawStylePresets = computed<IDrawStylePreset[]>(() => [
    {
        id: 'pen',
        label: t('annotations.pen'),
        thickness: 2,
        opacity: 0.95,
    },
    {
        id: 'pencil',
        label: t('annotations.pencil'),
        thickness: 1,
        opacity: 0.55,
    },
    {
        id: 'marker',
        label: t('annotations.marker'),
        thickness: 6,
        opacity: 0.42,
    },
]);

const query = ref('');
const selectedStableKey = ref<string | null>(null);

const tool = computed(() => props.tool);
const keepActive = computed(() => props.keepActive);
const currentPage = computed(() => props.currentPage);
const placingPageNote = computed(() => props.placingPageNote ?? false);

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

const contextMenu = ref<{
    visible: boolean;
    x: number;
    y: number;
    comment: IAnnotationCommentSummary | null;
}>({
    visible: false,
    x: 0,
    y: 0,
    comment: null,
});

function closeContextMenu() {
    contextMenu.value = {
        visible: false,
        x: 0,
        y: 0,
        comment: null,
    };
}

const contextMenuStyle = computed(() => ({
    left: `${contextMenu.value.x}px`,
    top: `${contextMenu.value.y}px`,
}));

watch(
    () => props.activeCommentStableKey,
    (stableKey) => {
        selectedStableKey.value = stableKey ?? null;
    },
    { immediate: true },
);

watch(
    () => props.comments,
    (comments) => {
        if (!selectedStableKey.value) {
            return;
        }
        const stillExists = comments.some(comment => (
            comment.stableKey === selectedStableKey.value
            && isTextNoteComment(comment)
        ));
        if (!stillExists) {
            selectedStableKey.value = null;
        }
    },
    { deep: true },
);

function updateSetting<K extends keyof IAnnotationSettings>(key: K, value: IAnnotationSettings[K]) {
    emit('update-setting', {
        key,
        value,
    });
}

function isShapeTool(tool: TAnnotationTool) {
    return tool === 'rectangle' || tool === 'circle' || tool === 'line' || tool === 'arrow';
}

function containsWord(text: string, word: string) {
    return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

function isTextNoteComment(comment: IAnnotationCommentSummary) {
    if (comment.hasNote === true) {
        return true;
    }

    const subtype = (comment.subtype ?? '').toLowerCase();
    const label = (comment.kindLabel ?? '').toLowerCase();

    return (
        subtype.includes('popup')
        || subtype.includes('text')
        || subtype.includes('note')
        || containsWord(label, 'note')
        || containsWord(label, 'comment')
        || containsWord(label, 'sticky')
    );
}

function compareComments(left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) {
    if (left.pageIndex !== right.pageIndex) {
        return left.pageIndex - right.pageIndex;
    }

    const leftSort = typeof left.sortIndex === 'number' ? left.sortIndex : null;
    const rightSort = typeof right.sortIndex === 'number' ? right.sortIndex : null;

    if (leftSort !== null && rightSort !== null && leftSort !== rightSort) {
        return leftSort - rightSort;
    }

    if (leftSort !== null && rightSort === null) {
        return -1;
    }

    if (leftSort === null && rightSort !== null) {
        return 1;
    }

    const leftModified = left.modifiedAt ?? 0;
    const rightModified = right.modifiedAt ?? 0;
    if (leftModified !== rightModified) {
        return rightModified - leftModified;
    }

    return left.stableKey.localeCompare(right.stableKey);
}

const sortedComments = computed(() => props.comments.slice().sort(compareComments));
const noteComments = computed(() => sortedComments.value.filter(isTextNoteComment));

function matchesQuery(comment: IAnnotationCommentSummary, normalizedQuery: string) {
    if (!normalizedQuery) {
        return true;
    }

    return (
        comment.text.toLowerCase().includes(normalizedQuery)
        || (comment.kindLabel ?? '').toLowerCase().includes(normalizedQuery)
        || (comment.author ?? '').toLowerCase().includes(normalizedQuery)
        || `p${comment.pageNumber}`.includes(normalizedQuery)
    );
}

const filteredComments = computed(() => {
    const normalizedQuery = query.value.trim().toLowerCase();
    return noteComments.value.filter(comment => matchesQuery(comment, normalizedQuery));
});

const pagesWithNotes = computed<IPageAnnotationOverview[]>(() => {
    const map = new Map<number, IPageAnnotationOverview>();

    noteComments.value.forEach((comment) => {
        const current = map.get(comment.pageNumber);
        if (current) {
            current.noteCount += 1;
            return;
        }

        map.set(comment.pageNumber, {
            pageNumber: comment.pageNumber,
            noteCount: 1,
        });
    });

    return Array
        .from(map.values())
        .sort((left, right) => left.pageNumber - right.pageNumber);
});

function focusFirstCommentOnPage(pageNumber: number) {
    const comment = noteComments.value.find(item => item.pageNumber === pageNumber);
    if (!comment) {
        return;
    }
    selectComment(comment);
}

function commentTypeLabel(comment: IAnnotationCommentSummary) {
    const kind = comment.kindLabel?.trim();
    if (kind) {
        return kind;
    }

    const subtype = (comment.subtype ?? '').toLowerCase();
    if (subtype.includes('highlight')) {
        return t('annotations.highlightLabel');
    }
    if (subtype.includes('underline')) {
        return t('annotations.underlineLabel');
    }
    if (subtype.includes('strike')) {
        return t('annotations.strikeOutLabel');
    }
    if (subtype.includes('squiggly')) {
        return t('annotations.squiggleLabel');
    }
    if (subtype.includes('ink')) {
        return t('annotations.inkLabel');
    }
    if (subtype.includes('text') || subtype.includes('popup') || subtype.includes('note')) {
        return t('annotations.stickyNoteLabel');
    }
    if (subtype.includes('square') || subtype.includes('rectangle')) {
        return t('annotations.rectangleLabel');
    }
    if (subtype.includes('circle')) {
        return t('annotations.circleLabel');
    }
    if (subtype.includes('line')) {
        return t('annotations.lineLabel');
    }
    if (subtype.includes('arrow')) {
        return t('annotations.arrowLabel');
    }

    return t('annotations.annotationLabel');
}

function notePreview(comment: IAnnotationCommentSummary) {
    const text = comment.text.trim();
    if (!text) {
        return t('annotations.emptyNote');
    }

    return text;
}

function formatTime(timestamp: number) {
    return timeFormatter.format(timestamp);
}

function selectComment(comment: IAnnotationCommentSummary) {
    selectedStableKey.value = comment.stableKey;
    emit('focus-comment', comment);
    closeContextMenu();
}

function openComment(comment: IAnnotationCommentSummary) {
    selectedStableKey.value = comment.stableKey;
    emit('focus-comment', comment);
    emit('open-note', comment);
    closeContextMenu();
}

const selectedComment = computed(() => {
    if (!selectedStableKey.value) {
        return null;
    }
    return noteComments.value.find(comment => comment.stableKey === selectedStableKey.value) ?? null;
});

const canCopySelectedComment = computed(() => {
    const comment = selectedComment.value;
    return Boolean(comment && comment.text.trim().length > 0);
});

function openSelectedComment() {
    if (!selectedComment.value) {
        return;
    }
    openComment(selectedComment.value);
}

function copySelectedComment() {
    if (!selectedComment.value || !selectedComment.value.text.trim()) {
        return;
    }
    emit('copy-comment', selectedComment.value);
}

function deleteSelectedComment() {
    if (!selectedComment.value) {
        return;
    }
    emit('delete-comment', selectedComment.value);
    selectedStableKey.value = null;
}

function openContextComment() {
    if (!contextMenu.value.comment) {
        return;
    }
    openComment(contextMenu.value.comment);
}

function openItemContextMenu(event: MouseEvent, comment: IAnnotationCommentSummary) {
    selectedStableKey.value = comment.stableKey;
    const width = 168;
    const height = 120;
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);

    contextMenu.value = {
        visible: true,
        x: Math.min(Math.max(margin, event.clientX), maxX),
        y: Math.min(Math.max(margin, event.clientY), maxY),
        comment,
    };
}

function copyContextComment() {
    if (!contextMenu.value.comment || !contextMenu.value.comment.text.trim()) {
        return;
    }
    emit('copy-comment', contextMenu.value.comment);
    closeContextMenu();
}

function deleteContextComment() {
    if (!contextMenu.value.comment) {
        return;
    }
    emit('delete-comment', contextMenu.value.comment);
    closeContextMenu();
}

const activeToolColor = computed(() => {
    if (props.tool === 'draw') {
        return props.settings.inkColor;
    }
    if (props.tool === 'text') {
        return props.settings.textColor;
    }
    if (props.tool === 'underline') {
        return props.settings.underlineColor;
    }
    if (props.tool === 'strikethrough') {
        return props.settings.strikethroughColor;
    }
    if (isShapeTool(props.tool)) {
        return props.settings.shapeColor;
    }

    return props.settings.highlightColor;
});

const activeWidthControl = computed<IWidthControl | null>(() => {
    if (props.tool === 'draw') {
        return {
            key: 'inkThickness',
            min: 1,
            max: 24,
            step: 1,
            label: t('annotations.drawThickness'),
        };
    }

    if (props.tool === 'highlight') {
        return {
            key: 'highlightThickness',
            min: 4,
            max: 24,
            step: 1,
            label: t('annotations.thickness'),
        };
    }

    if (isShapeTool(props.tool)) {
        return {
            key: 'shapeStrokeWidth',
            min: 1,
            max: 10,
            step: 0.5,
            label: t('annotations.stroke'),
        };
    }

    if (props.tool === 'text') {
        return {
            key: 'textSize',
            min: 8,
            max: 72,
            step: 1,
            label: t('annotations.textSize'),
        };
    }

    return null;
});

const activeWidthValue = computed(() => {
    if (!activeWidthControl.value) {
        return 0;
    }
    return props.settings[activeWidthControl.value.key];
});

const activeDrawStyle = computed<TDrawStyle>(() => {
    const thickness = props.settings.inkThickness;
    const opacity = props.settings.inkOpacity;

    if (thickness >= 5 || opacity <= 0.45) {
        return 'marker';
    }

    if (thickness <= 1.5 || opacity < 0.75) {
        return 'pencil';
    }

    return 'pen';
});

function handleColorInput(color: string) {
    if (props.tool === 'draw') {
        updateSetting('inkColor', color);
        return;
    }

    if (props.tool === 'underline') {
        updateSetting('underlineColor', color);
        return;
    }

    if (props.tool === 'text') {
        updateSetting('textColor', color);
        return;
    }

    if (props.tool === 'strikethrough') {
        updateSetting('strikethroughColor', color);
        return;
    }

    if (isShapeTool(props.tool)) {
        updateSetting('shapeColor', color);
        return;
    }

    updateSetting('highlightColor', color);
}

function handleWidthInput(width: number) {
    const control = activeWidthControl.value;
    if (!control) {
        return;
    }

    updateSetting(control.key, width);
}

function nudgeWidth(delta: number) {
    const control = activeWidthControl.value;
    if (!control) {
        return;
    }

    const next = Math.max(
        control.min,
        Math.min(control.max, activeWidthValue.value + delta),
    );
    updateSetting(control.key, next);
}

function applyDrawStyle(style: TDrawStyle) {
    const preset = drawStylePresets.value.find(item => item.id === style);
    if (!preset) {
        return;
    }

    emit('set-tool', 'draw');
    updateSetting('inkThickness', preset.thickness);
    updateSetting('inkOpacity', preset.opacity);
}
</script>

<style scoped>
.notes-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    min-height: 100%;
    overflow: visible;
    box-sizing: border-box;
    position: relative;
}

.notes-section {
    border: 1px solid var(--ui-border-muted);
    border-radius: 0.7rem;
    background: color-mix(in srgb, var(--ui-bg) 94%, var(--ui-bg-muted) 6%);
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
}

.notes-section-header {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}

.notes-section-title {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.2;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-highlighted);
}

.notes-section-description {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.35;
    color: var(--ui-text-muted);
}

.tool-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.4rem;
}

.tool-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.5rem;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 0.8rem;
    font-weight: 600;
    min-height: 2.1rem;
    cursor: pointer;
}

.tool-button:hover {
    border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border) 60%);
    color: var(--ui-text-highlighted);
}

.tool-button.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 60%, var(--ui-border) 40%);
    background: color-mix(in srgb, var(--ui-primary) 18%, var(--ui-bg) 82%);
    color: var(--ui-text-highlighted);
}

.tool-button-icon {
    font-size: 0.95rem;
}

.tool-button-label {
    white-space: nowrap;
}

.keep-active-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.82rem;
    color: var(--ui-text-muted);
}

.sticky-actions {
    display: grid;
    grid-template-columns: repeat(1, minmax(0, 1fr));
    gap: 0.45rem;
}

.sticky-action {
    border: 1px solid var(--ui-border);
    border-radius: 0.5rem;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    min-height: 2.1rem;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
}

.sticky-action:hover {
    border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border) 60%);
}

.sticky-action.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 70%, var(--ui-border) 30%);
    background: color-mix(in srgb, var(--ui-primary) 20%, var(--ui-bg) 80%);
}

.sticky-action-icon {
    font-size: 0.9rem;
}

.sticky-hint {
    margin: 0;
    font-size: 0.78rem;
    color: var(--ui-text-toned);
}

.style-row {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
}

.style-label {
    font-size: 0.8rem;
    color: var(--ui-text-muted);
}

.style-color {
    width: 100%;
    height: 2rem;
    border-radius: 0.45rem;
    border: 1px solid var(--ui-border);
    background: transparent;
    cursor: pointer;
}

.swatch-row {
    display: grid;
    grid-template-columns: repeat(9, minmax(0, 1fr));
    gap: 0.25rem;
}

.swatch {
    border: 1px solid color-mix(in srgb, var(--ui-border) 80%, #000 20%);
    border-radius: 0.3rem;
    height: 1.1rem;
    cursor: pointer;
}

.style-range {
    width: 100%;
}

.style-width-control {
    display: flex;
    align-items: center;
    gap: 0.45rem;
}

.style-step-button {
    border: 1px solid var(--ui-border);
    border-radius: 0.4rem;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    width: 1.8rem;
    height: 1.8rem;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
}

.style-step-button:hover {
    border-color: color-mix(in srgb, var(--ui-primary) 55%, var(--ui-border) 45%);
}

.draw-style-row {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
}

.draw-style-list {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.35rem;
}

.draw-style-button {
    border: 1px solid var(--ui-border);
    border-radius: 0.45rem;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    min-height: 1.9rem;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
}

.draw-style-button.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 65%, var(--ui-border) 35%);
    color: var(--ui-text-highlighted);
    background: color-mix(in srgb, var(--ui-primary) 14%, var(--ui-bg) 86%);
}

.page-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
}

.page-chip {
    border: 1px solid var(--ui-border);
    border-radius: 999px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.76rem;
    padding: 0.22rem 0.55rem;
    cursor: pointer;
}

.page-chip.is-current {
    border-color: color-mix(in srgb, var(--ui-primary) 70%, var(--ui-border) 30%);
    color: var(--ui-text-highlighted);
}

.page-chip-label {
    font-weight: 600;
}

.page-chip-count {
    color: var(--ui-text-toned);
}

.notes-list-header {
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
}

.notes-list-trigger {
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.55rem;
    cursor: pointer;
}

.notes-list-trigger-meta {
    min-width: 0;
    flex: 1 1 auto;
    display: inline-flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.55rem;
}

.notes-list-chevron {
    flex: 0 0 auto;
    font-size: 0.95rem;
    color: var(--ui-text-toned);
    transition: transform 0.18s ease;
}

.notes-list-chevron.is-open {
    transform: rotate(180deg);
}

.notes-count {
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--ui-text-highlighted);
}

.notes-search {
    width: 100%;
    border: 1px solid var(--ui-border);
    border-radius: 0.5rem;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    font-size: 0.82rem;
    padding: 0.45rem 0.55rem;
}

.notes-list {
    max-height: 20rem;
    min-height: 7rem;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding-right: 0.1rem;
}

.note-item {
    border: 1px solid var(--ui-border);
    border-radius: 0.55rem;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    text-align: left;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    cursor: pointer;
}

.note-item.is-selected {
    border-color: color-mix(in srgb, var(--ui-primary) 75%, var(--ui-border) 25%);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ui-primary) 30%, transparent 70%);
}

.note-item-top {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
    font-size: 0.72rem;
}

.note-item-page {
    font-weight: 700;
    color: var(--ui-text-highlighted);
}

.note-item-type {
    color: var(--ui-text-muted);
}

.note-item-text {
    font-size: 0.8rem;
    line-height: 1.35;
    color: var(--ui-text-highlighted);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.note-item-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem;
    font-size: 0.7rem;
    color: var(--ui-text-toned);
}

.notes-empty {
    margin: 0;
    border: 1px dashed var(--ui-border);
    border-radius: 0.5rem;
    padding: 0.65rem;
    font-size: 0.8rem;
    color: var(--ui-text-muted);
}

.selection-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.4rem;
}

.selection-action {
    border: 1px solid var(--ui-border);
    border-radius: 0.45rem;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    min-height: 2rem;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
}

.selection-action:disabled {
    cursor: not-allowed;
    opacity: 0.5;
}

.selection-action.is-danger {
    color: color-mix(in srgb, #ef4444 65%, var(--ui-text-highlighted) 35%);
}

.notes-context-menu {
    position: fixed;
    z-index: 1400;
    min-width: 10.5rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.55rem;
    background: var(--ui-bg);
    box-shadow: 0 14px 30px color-mix(in srgb, var(--ui-bg-inverted) 20%, transparent 80%);
    padding: 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}

.context-menu-action {
    border: 1px solid transparent;
    border-radius: 0.4rem;
    background: transparent;
    color: var(--ui-text-highlighted);
    font-size: 0.77rem;
    text-align: left;
    padding: 0.35rem 0.45rem;
    cursor: pointer;
}

.context-menu-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.context-menu-action:hover:not(:disabled) {
    border-color: var(--ui-border);
    background: color-mix(in srgb, var(--ui-bg-muted) 55%, var(--ui-bg) 45%);
}

.context-menu-action.is-danger {
    color: color-mix(in srgb, #ef4444 68%, var(--ui-text-highlighted) 32%);
}

@media (width <= 860px) {
    .tool-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .swatch-row {
        grid-template-columns: repeat(6, minmax(0, 1fr));
    }
}
</style>
