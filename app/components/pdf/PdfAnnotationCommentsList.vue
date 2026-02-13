<template>
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
                            <span class="note-item-page">{{ t('annotations.page') }} {{ comment.pageNumber }}</span>
                            <span class="note-item-type">{{ commentTypeLabel(comment) }}</span>
                        </span>
                        <span class="note-item-text">{{ notePreview(comment) }}</span>
                        <span class="note-item-meta">
                            <span>{{ comment.author || authorName || t('annotations.unknownAuthor') }}</span>
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

        <PdfAnnotationCommentsContextMenu
            :visible="contextMenu.visible"
            :x="contextMenu.x"
            :y="contextMenu.y"
            :comment="contextMenu.comment"
            @open="openContextComment"
            @copy="copyContextComment"
            @delete="deleteContextComment"
        />
    </section>
</template>

<script setup lang="ts">
import {
    computed,
    ref,
    watch,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';
import {
    isTextNoteComment,
    compareComments,
    matchesCommentQuery,
} from '@app/utils/pdf-annotation-comments';

interface IProps {
    comments: IAnnotationCommentSummary[];
    activeCommentStableKey?: string | null;
    authorName?: string | null;
}

const { t } = useI18n();
const { clampToViewport } = useContextMenuPosition();

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'focus-comment', comment: IAnnotationCommentSummary): void;
    (e: 'open-note', comment: IAnnotationCommentSummary): void;
    (e: 'copy-comment', comment: IAnnotationCommentSummary): void;
    (e: 'delete-comment', comment: IAnnotationCommentSummary): void;
}>();

const query = ref('');
const selectedStableKey = ref<string | null>(null);

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

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

const authorName = computed(() => props.authorName ?? null);

function closeContextMenu() {
    contextMenu.value = {
        visible: false,
        x: 0,
        y: 0,
        comment: null,
    };
}

watch(
    () => props.activeCommentStableKey,
    (stableKey) => {
        selectedStableKey.value = stableKey ?? null;
    },
    { immediate: true },
);

const sortedComments = computed(() => props.comments.slice().sort(compareComments));
const noteComments = computed(() => sortedComments.value.filter(isTextNoteComment));

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

const filteredComments = computed(() => {
    const normalizedQuery = query.value.trim().toLowerCase();
    return noteComments.value.filter(comment => matchesCommentQuery(comment, normalizedQuery));
});

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
    const clamped = clampToViewport(event.clientX, event.clientY, 168, 120);

    contextMenu.value = {
        visible: true,
        x: clamped.x,
        y: clamped.y,
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

defineExpose({
    closeContextMenu,
    focusFirstCommentOnPage(pageNumber: number) {
        const comment = noteComments.value.find(item => item.pageNumber === pageNumber);
        if (!comment) {
            return;
        }
        selectComment(comment);
    },
    noteComments,
});
</script>

<style scoped>
.notes-section {
    border: 1px solid var(--ui-border-muted);
    border-radius: 0.7rem;
    background: var(--ui-bg);
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
}

.notes-section-title {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.2;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ui-text-highlighted);
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
    color: color-mix(in srgb, var(--ui-error) 65%, var(--ui-text-highlighted) 35%);
}
</style>
