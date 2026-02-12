<template>
    <div class="notes-panel" @click="commentsList?.closeContextMenu()">
        <PdfAnnotationToolbar
            :tool="tool"
            :keep-active="keepActive"
            @set-tool="emit('set-tool', $event)"
            @update:keep-active="emit('update:keep-active', $event)"
        />

        <PdfAnnotationStyleEditor
            :tool="tool"
            :settings="settings"
            @set-tool="emit('set-tool', $event)"
            @update-setting="emit('update-setting', $event)"
        />

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
                    @click="commentsList?.focusFirstCommentOnPage(item.pageNumber)"
                >
                    <span class="page-chip-label">{{ t('annotations.page') }} {{ item.pageNumber }}</span>
                    <span class="page-chip-count">• {{ t('annotations.noteCount', item.noteCount) }}</span>
                </button>
            </div>
        </section>

        <PdfAnnotationCommentsList
            ref="commentsList"
            :comments="comments"
            :active-comment-stable-key="activeCommentStableKey"
            :author-name="appSettings.authorName"
            @focus-comment="emit('focus-comment', $event)"
            @open-note="emit('open-note', $event)"
            @copy-comment="emit('copy-comment', $event)"
            @delete-comment="emit('delete-comment', $event)"
        />
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    ref,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import PdfAnnotationCommentsList from '@app/components/pdf/PdfAnnotationCommentsList.vue';

interface IProps {
    tool: TAnnotationTool;
    keepActive: boolean;
    settings: IAnnotationSettings;
    comments: IAnnotationCommentSummary[];
    currentPage: number;
    activeCommentStableKey?: string | null;
    placingPageNote?: boolean;
}

interface IPageAnnotationOverview {
    pageNumber: number;
    noteCount: number;
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

const commentsList = ref<InstanceType<typeof PdfAnnotationCommentsList> | null>(null);

const currentPage = computed(() => props.currentPage);
const placingPageNote = computed(() => props.placingPageNote ?? false);

const pagesWithNotes = computed<IPageAnnotationOverview[]>(() => {
    const noteComments = commentsList.value?.noteComments ?? [];
    const map = new Map<number, IPageAnnotationOverview>();

    noteComments.forEach((comment) => {
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
</style>
