<template>
    <div
        ref="panelRootRef"
        class="pdf-annotations-panel"
        @click="closeContextMenu"
        @keydown.capture="handlePanelKeydown"
    >
        <section class="reviews-section">
            <header class="reviews-head">
                <h3 class="reviews-title">Annotations</h3>
                <span class="reviews-count">{{ filteredComments.length }}</span>
            </header>

            <input
                v-model.trim="commentQuery"
                type="search"
                class="reviews-search"
                placeholder="Search notes, authors, page…"
            />

            <div class="reviews-filters">
                <button
                    v-for="filter in reviewQuickFilters"
                    :key="filter.id"
                    type="button"
                    class="reviews-filter"
                    :class="{ 'is-active': reviewQuickFilter === filter.id }"
                    :title="filter.title"
                    @click="setReviewQuickFilter(filter.id)"
                >
                    <span class="reviews-filter__label">{{ filter.label }}</span>
                    <span class="reviews-filter__count">{{ filter.count }}</span>
                </button>
            </div>

            <div
                ref="reviewsListRef"
                class="reviews-list app-scrollbar"
                tabindex="0"
                @click.self="focusReviewsList"
            >
                <p class="reviews-hint">
                    Click to focus. Double-click opens the pop-up note.
                </p>
                <ul v-if="visibleNodes.length > 0" class="reviews-tree">
                    <li v-for="node in visibleNodes" :key="node.id">
                        <button
                            v-if="node.type === 'group'"
                            type="button"
                            class="reviews-group"
                            :data-group-id="node.id"
                            :style="{ paddingLeft: `${node.depth * 0.75 + 0.35}rem` }"
                            @click="toggleGroup(node.id)"
                            @contextmenu.prevent.stop="openGroupContextMenu($event, node)"
                        >
                            <UIcon
                                :name="isExpanded(node.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                                class="reviews-group__icon"
                            />
                            <span class="reviews-group__label">{{ node.label }}</span>
                            <span class="reviews-group__count">{{ node.count }}</span>
                        </button>

                        <button
                            v-else
                            type="button"
                            class="review-item"
                            :class="{ 'is-selected': isCommentSelected(node.comment) }"
                            :data-stable-key="node.comment.stableKey"
                            :style="{ paddingLeft: `${node.depth * 0.75 + 0.35}rem` }"
                            @click="handleReviewItemClick($event, node.comment)"
                            @dblclick.prevent.stop="handleReviewItemDoubleClick($event, node.comment)"
                            @contextmenu.prevent.stop="openCommentContextMenu($event, node.comment)"
                            @focus="handleReviewItemFocus(node.comment)"
                        >
                            <span class="review-item__head">
                                <span class="review-item__meta-left">
                                    <span
                                        class="review-item__type"
                                        :class="`is-${reviewKind(node.comment)}`"
                                    >
                                        {{ reviewKindLabel(node.comment) }}
                                    </span>
                                    <span class="review-item__page">P{{ node.comment.pageNumber }}</span>
                                    <span class="review-item__author">{{ node.comment.author || 'Unknown Author' }}</span>
                                </span>
                                <span class="review-item__time">{{ formatCommentTime(node.comment.modifiedAt) }}</span>
                            </span>
                            <span class="review-item__text">{{ reviewItemText(node.comment) }}</span>
                        </button>
                    </li>
                </ul>

                <p v-else class="reviews-empty">
                    No annotations yet
                </p>
            </div>

            <footer class="reviews-toolbar">
                <div class="reviews-toolbar__line">
                    <span class="reviews-toolbar__label">Group</span>
                    <button
                        type="button"
                        class="reviews-toggle"
                        :class="{ 'is-active': groupByPage }"
                        title="Group by page"
                        @click="groupByPage = !groupByPage"
                    >
                        <UIcon name="i-lucide-file-text" class="reviews-toggle__icon" />
                        <span>By Page</span>
                    </button>
                    <button
                        type="button"
                        class="reviews-toggle"
                        :class="{ 'is-active': groupByAuthor }"
                        title="Group by author"
                        @click="groupByAuthor = !groupByAuthor"
                    >
                        <UIcon name="i-lucide-user" class="reviews-toggle__icon" />
                        <span>By Author</span>
                    </button>
                </div>
                <div class="reviews-toolbar__line">
                    <span class="reviews-toolbar__label">List</span>
                    <button
                        type="button"
                        class="reviews-toggle reviews-toggle--compact"
                        title="Expand all"
                        @click="expandAll"
                    >
                        <UIcon name="i-lucide-chevrons-down" class="reviews-toggle__icon" />
                        <span>Expand</span>
                    </button>
                    <button
                        type="button"
                        class="reviews-toggle reviews-toggle--compact"
                        title="Collapse all"
                        @click="collapseAll"
                    >
                        <UIcon name="i-lucide-chevrons-up" class="reviews-toggle__icon" />
                        <span>Collapse</span>
                    </button>
                </div>
            </footer>
        </section>

        <details class="quick-section" :open="quickSectionOpen" @toggle="handleQuickSectionToggle">
            <summary class="quick-section__summary">
                <span class="quick-section__title">Quick Annotations</span>
                <span class="quick-section__meta">Okular presets</span>
                <UIcon
                    name="i-lucide-chevron-down"
                    class="quick-section__chevron"
                />
            </summary>
            <div class="quick-section__content">
                <div class="quick-section__row quick-section__row--preset">
                    <label class="quick-select-group">
                        <span class="quick-select-group__label">Preset</span>
                        <select
                            v-model="selectedQuickToolId"
                            class="quick-select"
                        >
                            <option
                                v-for="quick in quickTools"
                                :key="quick.id"
                                :value="quick.id"
                            >
                                {{ quick.label }}
                            </option>
                        </select>
                    </label>
                    <button
                        type="button"
                        class="quick-apply-button"
                        @click="applySelectedQuickTool"
                    >
                        Apply
                    </button>
                </div>
                <p class="quick-preset-hint">
                    {{ selectedQuickToolHint }}
                </p>

                <div class="quick-section__row quick-section__row--actions">
                    <button
                        type="button"
                        class="quick-action"
                        @pointerdown.prevent
                        @mousedown.prevent
                        @click="emit('highlight-selection')"
                    >
                        Highlight Selection
                    </button>
                    <button
                        type="button"
                        class="quick-action"
                        @pointerdown.prevent
                        @mousedown.prevent
                        @click="emit('comment-selection')"
                    >
                        Pop-up Note from Selection
                    </button>
                </div>

                <label class="quick-keep-active">
                    <input
                        type="checkbox"
                        :checked="keepActive"
                        @change="emit('update:keep-active', ($event.target as HTMLInputElement).checked)"
                    />
                    Keep Active
                </label>

                <details class="tool-settings" :open="toolSettingsOpen" @toggle="handleToolSettingsToggle">
                    <summary>Current Tool Settings</summary>
                    <div class="tool-settings__grid">
                        <label v-if="showHighlightSettings" class="tool-setting">
                            <span>Highlight Color</span>
                            <input
                                class="tool-setting__color"
                                type="color"
                                :value="settings.highlightColor"
                                @input="updateSetting('highlightColor', ($event.target as HTMLInputElement).value)"
                            />
                        </label>
                        <label v-if="showHighlightSettings" class="tool-setting">
                            <span>Highlight Width {{ settings.highlightThickness }}</span>
                            <input
                                class="tool-setting__range"
                                type="range"
                                min="4"
                                max="24"
                                step="1"
                                :value="settings.highlightThickness"
                                @input="updateSetting('highlightThickness', Number(($event.target as HTMLInputElement).value))"
                            />
                        </label>
                        <label v-if="showInkSettings" class="tool-setting">
                            <span>Ink Color</span>
                            <input
                                class="tool-setting__color"
                                type="color"
                                :value="settings.inkColor"
                                @input="updateSetting('inkColor', ($event.target as HTMLInputElement).value)"
                            />
                        </label>
                        <label v-if="showInkSettings" class="tool-setting">
                            <span>Ink Width {{ settings.inkThickness }}</span>
                            <input
                                class="tool-setting__range"
                                type="range"
                                min="1"
                                max="16"
                                step="1"
                                :value="settings.inkThickness"
                                @input="updateSetting('inkThickness', Number(($event.target as HTMLInputElement).value))"
                            />
                        </label>
                        <label v-if="showTextSettings" class="tool-setting">
                            <span>Text Color</span>
                            <input
                                class="tool-setting__color"
                                type="color"
                                :value="settings.textColor"
                                @input="updateSetting('textColor', ($event.target as HTMLInputElement).value)"
                            />
                        </label>
                        <label v-if="showTextSettings" class="tool-setting">
                            <span>Text Size {{ settings.textSize }}</span>
                            <input
                                class="tool-setting__range"
                                type="range"
                                min="8"
                                max="48"
                                step="1"
                                :value="settings.textSize"
                                @input="updateSetting('textSize', Number(($event.target as HTMLInputElement).value))"
                            />
                        </label>
                        <p v-if="!hasAdjustableToolSettings" class="tool-settings__empty">
                            No adjustable settings for this preset.
                        </p>
                    </div>
                    <div v-if="showHighlightSettings" class="tool-flags">
                        <label>
                            <input
                                type="checkbox"
                                :checked="settings.highlightFree"
                                @change="updateSetting('highlightFree', ($event.target as HTMLInputElement).checked)"
                            />
                            Freehand highlight
                        </label>
                        <label>
                            <input
                                type="checkbox"
                                :checked="settings.highlightShowAll"
                                @change="updateSetting('highlightShowAll', ($event.target as HTMLInputElement).checked)"
                            />
                            Show all highlights
                        </label>
                    </div>
                </details>
            </div>
        </details>

        <div
            v-if="contextMenu.visible"
            class="reviews-context-menu"
            :style="contextMenuStyle"
            @click.stop
        >
            <button
                type="button"
                class="context-action"
                :disabled="!canOpenContextComment"
                @click="openContextNote"
            >
                Open Pop-up Note
            </button>
            <button
                type="button"
                class="context-action"
                :disabled="!canCopyContextComment"
                @click="copyContextNoteText"
            >
                Copy Text to Clipboard
            </button>
            <button type="button" class="context-action context-action--danger" @click="deleteContextComment">
                Delete
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
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
}

interface IQuickToolPreset {
    id: string;
    label: string;
    swatch: string;
    tool?: TAnnotationTool;
    settings?: Partial<IAnnotationSettings>;
    action?: 'highlight-selection' | 'comment-selection';
}

interface IGroupNode {
    type: 'group';
    id: string;
    label: string;
    count: number;
    depth: number;
    children: TTreeNode[];
}

interface ICommentNode {
    type: 'comment';
    id: string;
    depth: number;
    comment: IAnnotationCommentSummary;
}

type TTreeNode = IGroupNode | ICommentNode;
type TReviewKind = 'highlight' | 'ink' | 'text' | 'other';
type TReviewQuickFilter = 'all' | 'with-note' | 'highlight' | 'ink' | 'text' | 'current-page';

interface IReviewQuickFilterItem {
    id: TReviewQuickFilter;
    label: string;
    title: string;
    count: number;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-tool', tool: TAnnotationTool): void;
    (e: 'update:keep-active', value: boolean): void;
    (e: 'update-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }): void;
    (e: 'highlight-selection'): void;
    (e: 'comment-selection'): void;
    (e: 'focus-comment', comment: IAnnotationCommentSummary): void;
    (e: 'open-note', comment: IAnnotationCommentSummary): void;
    (e: 'copy-comment', comment: IAnnotationCommentSummary): void;
    (e: 'delete-comment', comment: IAnnotationCommentSummary): void;
}>();

const quickTools: IQuickToolPreset[] = [
    {
        id: 'quick-highlight-yellow',
        label: 'Yellow Highlighter',
        swatch: '#ffff00',
        tool: 'highlight',
        settings: {
            highlightColor: '#ffff00',
            highlightOpacity: 0.35,
            highlightThickness: 12,
            highlightFree: true,
        },
    },
    {
        id: 'quick-highlight-green',
        label: 'Green Highlighter',
        swatch: '#00ff00',
        tool: 'highlight',
        settings: {
            highlightColor: '#00ff00',
            highlightOpacity: 0.35,
            highlightThickness: 12,
            highlightFree: true,
        },
    },
    {
        id: 'quick-underline',
        label: 'Underline',
        swatch: '#ff0000',
        tool: 'highlight',
        settings: {
            // PDF.js doesn't expose a true underline editor action through our current API.
            // Closest behavior is a thin red text markup tool preset.
            highlightColor: '#ff0000',
            highlightOpacity: 0.22,
            highlightThickness: 4,
            highlightFree: false,
        },
    },
    {
        id: 'quick-text-insert',
        label: 'Insert Text',
        swatch: '#111827',
        tool: 'text',
        settings: {
            textColor: '#111827',
            textSize: 12,
        },
    },
    {
        id: 'quick-inline-note',
        label: 'Inline Note',
        swatch: '#ffd54f',
        tool: 'text',
        settings: {
            textColor: '#111827',
            textSize: 12,
        },
    },
    {
        id: 'quick-popup-note',
        label: 'Pop-up Note',
        swatch: '#d1a80a',
        action: 'comment-selection',
    },
    {
        id: 'quick-ink-pen',
        label: 'Ink Pen',
        swatch: '#198754',
        tool: 'draw',
        settings: {
            inkColor: '#198754',
            inkOpacity: 0.95,
            inkThickness: 2,
        },
    },
];

const selectedQuickToolId = ref(quickTools[0]?.id ?? '');
const commentQuery = ref('');
const reviewQuickFilter = ref<TReviewQuickFilter>('all');
const groupByPage = ref(true);
const groupByAuthor = ref(false);
const collapsedGroupIds = ref<string[]>([]);
const transientExpandedGroupIds = ref<string[]>([]);
const transientSuppressedGroupIds = ref<string[]>([]);
const quickSectionOpen = ref(false);
const toolSettingsOpen = ref(false);
const selectedCommentKeys = ref<string[]>([]);
const selectionAnchorKey = ref<string | null>(null);
const panelRootRef = ref<HTMLElement | null>(null);
const reviewsListRef = ref<HTMLElement | null>(null);

const contextMenu = ref<{
    visible: boolean;
    x: number;
    y: number;
    comments: IAnnotationCommentSummary[];
}>({
    visible: false,
    x: 0,
    y: 0,
    comments: [],
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});
const STORAGE_KEYS = {
    selectedQuickToolId: 'pdf.annotations.quick.default',
    quickSectionOpen: 'pdf.annotations.panel.quickSectionOpen',
    toolSettingsOpen: 'pdf.annotations.panel.toolSettingsOpen',
} as const;

function loadBooleanSetting(key: string, fallback: boolean) {
    if (typeof window === 'undefined') {
        return fallback;
    }
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
        return fallback;
    }
    return raw === '1';
}

function saveBooleanSetting(key: string, value: boolean) {
    if (typeof window === 'undefined') {
        return;
    }
    window.localStorage.setItem(key, value ? '1' : '0');
}

function commentMatchesQuery(comment: IAnnotationCommentSummary, normalizedQuery: string) {
    if (!normalizedQuery) {
        return true;
    }
    return (
        comment.text.toLowerCase().includes(normalizedQuery)
        || (comment.kindLabel || '').toLowerCase().includes(normalizedQuery)
        || (comment.author || '').toLowerCase().includes(normalizedQuery)
        || `p${comment.pageNumber}`.includes(normalizedQuery)
    );
}

function resolveReviewKind(comment: IAnnotationCommentSummary): TReviewKind {
    const subtype = (comment.subtype || '').toLowerCase();
    const label = (comment.kindLabel || '').toLowerCase();

    if (subtype.includes('ink') || label.includes('ink') || label.includes('draw')) {
        return 'ink';
    }
    if (
        subtype.includes('freetext')
        || subtype.includes('text')
        || label.includes('text')
        || label.includes('note')
    ) {
        return 'text';
    }
    if (
        subtype.includes('highlight')
        || subtype.includes('underline')
        || subtype.includes('strike')
        || subtype.includes('squiggly')
        || label.includes('highlight')
        || label.includes('underline')
        || label.includes('markup')
    ) {
        return 'highlight';
    }

    return 'other';
}

function reviewKind(comment: IAnnotationCommentSummary) {
    return resolveReviewKind(comment);
}

function reviewKindLabel(comment: IAnnotationCommentSummary) {
    const kind = resolveReviewKind(comment);
    if (kind === 'highlight') {
        return 'Markup';
    }
    if (kind === 'ink') {
        return 'Ink';
    }
    if (kind === 'text') {
        return 'Text';
    }
    return 'Other';
}

function matchesReviewQuickFilter(comment: IAnnotationCommentSummary, filter: TReviewQuickFilter) {
    if (filter === 'all') {
        return true;
    }
    if (filter === 'with-note') {
        return comment.hasNote === true || comment.text.trim().length > 0;
    }
    if (filter === 'current-page') {
        return comment.pageNumber === props.currentPage;
    }
    return resolveReviewKind(comment) === filter;
}

function setReviewQuickFilter(filterId: TReviewQuickFilter) {
    reviewQuickFilter.value = reviewQuickFilter.value === filterId ? 'all' : filterId;
}

function isCommentVisibleUnderActiveFilters(comment: IAnnotationCommentSummary) {
    if (!matchesReviewQuickFilter(comment, reviewQuickFilter.value)) {
        return false;
    }
    const normalizedQuery = commentQuery.value.trim().toLowerCase();
    return commentMatchesQuery(comment, normalizedQuery);
}

function compareCommentOrder(a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) {
    if (a.pageIndex !== b.pageIndex) {
        return a.pageIndex - b.pageIndex;
    }
    const sortIndexA = typeof a.sortIndex === 'number' ? a.sortIndex : null;
    const sortIndexB = typeof b.sortIndex === 'number' ? b.sortIndex : null;
    if (sortIndexA !== null && sortIndexB !== null && sortIndexA !== sortIndexB) {
        return sortIndexA - sortIndexB;
    }
    if (sortIndexA !== null && sortIndexB === null) {
        return -1;
    }
    if (sortIndexA === null && sortIndexB !== null) {
        return 1;
    }
    const timeA = a.modifiedAt ?? 0;
    const timeB = b.modifiedAt ?? 0;
    if (timeA !== timeB) {
        return timeB - timeA;
    }
    return a.stableKey.localeCompare(b.stableKey);
}

const queryMatchedComments = computed(() => {
    const query = commentQuery.value.trim().toLowerCase();
    return props.comments.filter(comment => commentMatchesQuery(comment, query));
});

const reviewQuickFilters = computed<IReviewQuickFilterItem[]>(() => {
    const source = queryMatchedComments.value;
    const countBy = (filter: TReviewQuickFilter) => (
        source.filter(comment => matchesReviewQuickFilter(comment, filter)).length
    );

    return [
        {
            id: 'all',
            label: 'All',
            title: 'All annotations',
            count: source.length,
        },
        {
            id: 'with-note',
            label: 'With Note',
            title: 'Only annotations that carry a pop-up note',
            count: countBy('with-note'),
        },
        {
            id: 'highlight',
            label: 'Markup',
            title: 'Highlight/underline/text-markup annotations',
            count: countBy('highlight'),
        },
        {
            id: 'ink',
            label: 'Ink',
            title: 'Ink drawing annotations',
            count: countBy('ink'),
        },
        {
            id: 'text',
            label: 'Text',
            title: 'Text and inline note annotations',
            count: countBy('text'),
        },
        {
            id: 'current-page',
            label: 'Current Page',
            title: `Annotations on page ${props.currentPage}`,
            count: countBy('current-page'),
        },
    ];
});

const filteredComments = computed(() => {
    return queryMatchedComments.value
        .filter(comment => matchesReviewQuickFilter(comment, reviewQuickFilter.value))
        .slice()
        .sort(compareCommentOrder);
});

const hasActiveReviewConstraint = computed(() => (
    reviewQuickFilter.value !== 'all'
    || commentQuery.value.trim().length > 0
));

function commentNodeKey(comment: IAnnotationCommentSummary) {
    return `comment:${comment.stableKey}`;
}

function makeCommentNode(comment: IAnnotationCommentSummary, depth: number): ICommentNode {
    return {
        type: 'comment',
        id: commentNodeKey(comment),
        depth,
        comment,
    };
}

function makeGroupNode(id: string, label: string, depth: number, children: TTreeNode[]): IGroupNode {
    const count = children.reduce((total, child) => {
        if (child.type === 'comment') {
            return total + 1;
        }
        return total + child.count;
    }, 0);

    return {
        type: 'group',
        id,
        label,
        count,
        depth,
        children,
    };
}

function groupCommentsByAuthor(comments: IAnnotationCommentSummary[], depth: number, prefix: string) {
    const authorMap = new Map<string, IAnnotationCommentSummary[]>();
    comments.forEach((comment) => {
        const author = comment.author?.trim() || 'Unknown Author';
        const list = authorMap.get(author);
        if (list) {
            list.push(comment);
        } else {
            authorMap.set(author, [comment]);
        }
    });

    return Array
        .from(authorMap.entries())
        .sort((leftEntry, rightEntry) => leftEntry[0].localeCompare(rightEntry[0]))
        .map((entry) => {
            const author = entry[0];
            const authorComments = entry[1];
            return makeGroupNode(
                `${prefix}|author:${author}`,
                author,
                depth,
                authorComments.map(comment => makeCommentNode(comment, depth + 1)),
            );
        });
}

const reviewTree = computed<TTreeNode[]>(() => {
    const comments = filteredComments.value;
    if (!groupByPage.value && !groupByAuthor.value) {
        return comments.map(comment => makeCommentNode(comment, 0));
    }

    if (groupByPage.value) {
        const pageMap = new Map<number, IAnnotationCommentSummary[]>();
        comments.forEach((comment) => {
            const list = pageMap.get(comment.pageNumber);
            if (list) {
                list.push(comment);
            } else {
                pageMap.set(comment.pageNumber, [comment]);
            }
        });

        return Array
            .from(pageMap.entries())
            .sort((leftEntry, rightEntry) => leftEntry[0] - rightEntry[0])
            .map((entry) => {
                const pageNumber = entry[0];
                const pageComments = entry[1];
                const children = groupByAuthor.value
                    ? groupCommentsByAuthor(pageComments, 1, `page:${pageNumber}`)
                    : pageComments.map(comment => makeCommentNode(comment, 1));

                return makeGroupNode(
                    `page:${pageNumber}`,
                    `Page ${pageNumber}`,
                    0,
                    children,
                );
            });
    }

    return groupCommentsByAuthor(comments, 0, 'root');
});

function flattenVisible(nodes: TTreeNode[]): TTreeNode[] {
    const visible: TTreeNode[] = [];

    nodes.forEach((node) => {
        visible.push(node);

        if (node.type === 'group' && isExpanded(node.id)) {
            visible.push(...flattenVisible(node.children));
        }
    });

    return visible;
}

const allGroupIds = computed(() => {
    const ids: string[] = [];

    const walk = (nodes: TTreeNode[]) => {
        nodes.forEach((node) => {
            if (node.type === 'group') {
                ids.push(node.id);
                walk(node.children);
            }
        });
    };

    walk(reviewTree.value);
    return ids;
});

function refreshTransientGroupExpansion() {
    if (!hasActiveReviewConstraint.value) {
        transientExpandedGroupIds.value = [];
        transientSuppressedGroupIds.value = [];
        return;
    }
    const suppressed = new Set(transientSuppressedGroupIds.value);
    transientExpandedGroupIds.value = allGroupIds.value.filter(groupId => !suppressed.has(groupId));
}

watch(
    () => [
        hasActiveReviewConstraint.value,
        allGroupIds.value.join('|'),
    ] as const,
    () => {
        refreshTransientGroupExpansion();
    },
    { immediate: true },
);

const visibleNodes = computed(() => flattenVisible(reviewTree.value));
const commentByStableKey = computed(() => {
    const map = new Map<string, IAnnotationCommentSummary>();
    props.comments.forEach((comment) => {
        map.set(comment.stableKey, comment);
    });
    return map;
});
const visibleCommentKeys = computed(() => (
    visibleNodes.value
        .filter((node): node is ICommentNode => node.type === 'comment')
        .map(node => node.comment.stableKey)
));

function collectCommentsFromNode(node: TTreeNode): IAnnotationCommentSummary[] {
    if (node.type === 'comment') {
        return [node.comment];
    }
    return node.children.flatMap(child => collectCommentsFromNode(child));
}

function normalizeComments(comments: IAnnotationCommentSummary[]) {
    const seen = new Set<string>();
    const normalized: IAnnotationCommentSummary[] = [];
    comments.forEach((comment) => {
        const stableKey = comment.stableKey;
        if (seen.has(stableKey)) {
            return;
        }
        const canonical = commentByStableKey.value.get(stableKey) ?? comment;
        seen.add(stableKey);
        normalized.push(canonical);
    });
    return normalized;
}

function getSelectedComments() {
    return normalizeComments(
        selectedCommentKeys.value
            .map(stableKey => commentByStableKey.value.get(stableKey))
            .filter((candidate): candidate is IAnnotationCommentSummary => !!candidate),
    );
}

function getPrimarySelectedComment() {
    const selectedComments = getSelectedComments();
    if (selectedComments.length === 0) {
        return null;
    }

    const selectedMap = new Map(
        selectedComments.map(comment => [
            comment.stableKey,
            comment,
        ]),
    );

    if (selectionAnchorKey.value) {
        const anchored = selectedMap.get(selectionAnchorKey.value);
        if (anchored) {
            return anchored;
        }
    }

    const selectedKeys = new Set(selectedComments.map(comment => comment.stableKey));
    const firstVisible = visibleCommentKeys.value.find(stableKey => selectedKeys.has(stableKey));
    if (firstVisible) {
        return selectedMap.get(firstVisible) ?? null;
    }

    return selectedComments[0] ?? null;
}

function focusReviewsList() {
    reviewsListRef.value?.focus();
}

function handleReviewItemFocus(comment: IAnnotationCommentSummary) {
    if (!isCommentSelected(comment)) {
        return;
    }
    selectionAnchorKey.value = comment.stableKey;
}

function scrollCommentIntoView(stableKey: string) {
    const container = reviewsListRef.value;
    if (!container) {
        return;
    }
    const target = Array
        .from(container.querySelectorAll<HTMLElement>('.review-item'))
        .find(node => node.dataset.stableKey === stableKey);
    target?.scrollIntoView({ block: 'nearest' });
}

function findGroupPathForCommentStableKey(
    stableKey: string,
    nodes: TTreeNode[],
    ancestorGroupIds: string[] = [],
): string[] | null {
    for (const node of nodes) {
        if (node.type === 'comment') {
            if (node.comment.stableKey === stableKey) {
                return ancestorGroupIds;
            }
            continue;
        }

        const nextAncestors = [
            ...ancestorGroupIds,
            node.id,
        ];
        const nestedPath = findGroupPathForCommentStableKey(stableKey, node.children, nextAncestors);
        if (nestedPath) {
            return nestedPath;
        }
    }

    return null;
}

function ensureCommentGroupsExpanded(stableKey: string) {
    const groupPath = findGroupPathForCommentStableKey(stableKey, reviewTree.value);
    if (!groupPath || groupPath.length === 0) {
        return;
    }
    const collapsed = new Set(collapsedGroupIds.value);
    const suppressed = new Set(transientSuppressedGroupIds.value);
    const transient = new Set(transientExpandedGroupIds.value);
    groupPath.forEach((groupId) => {
        collapsed.delete(groupId);
        suppressed.delete(groupId);
        transient.add(groupId);
    });
    collapsedGroupIds.value = Array.from(collapsed);
    transientSuppressedGroupIds.value = Array.from(suppressed);
    transientExpandedGroupIds.value = Array.from(transient);
}

async function revealActiveComment(stableKey: string) {
    const comment = commentByStableKey.value.get(stableKey);
    if (!comment) {
        return;
    }

    if (!matchesReviewQuickFilter(comment, reviewQuickFilter.value)) {
        reviewQuickFilter.value = 'all';
    }

    if (!isCommentVisibleUnderActiveFilters(comment) && commentQuery.value.trim().length > 0) {
        // Okular-style behavior: document-driven focus should reveal the review entry
        // even when search filter currently hides it.
        commentQuery.value = '';
    }

    ensureCommentGroupsExpanded(stableKey);
    setSelectedComments([comment], stableKey);
    await nextTick();
    scrollCommentIntoView(stableKey);
}

function getCommentAncestorGroupPath(stableKey: string) {
    return findGroupPathForCommentStableKey(stableKey, reviewTree.value) ?? [];
}

function focusGroupButton(groupId: string) {
    const container = reviewsListRef.value;
    if (!container) {
        return;
    }
    const escaped = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
        ? CSS.escape(groupId)
        : groupId.replace(/"/g, '\\"');
    const target = container.querySelector<HTMLElement>(`.reviews-group[data-group-id="${escaped}"]`);
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
}

function findParentGroupId(groupId: string, nodes: TTreeNode[], parentGroupId: string | null = null): string | null {
    for (const node of nodes) {
        if (node.type !== 'group') {
            continue;
        }
        if (node.id === groupId) {
            return parentGroupId;
        }
        const nested = findParentGroupId(groupId, node.children, node.id);
        if (nested !== null) {
            return nested;
        }
    }
    return null;
}

function setSelectedComments(comments: IAnnotationCommentSummary[], anchorStableKey: string | null = null) {
    const normalized = normalizeComments(comments);
    selectedCommentKeys.value = normalized.map(comment => comment.stableKey);
    selectionAnchorKey.value = anchorStableKey ?? normalized.at(-1)?.stableKey ?? null;
}

function toggleSelectedComment(comment: IAnnotationCommentSummary) {
    const key = comment.stableKey;
    const current = new Set(selectedCommentKeys.value);
    if (current.has(key)) {
        current.delete(key);
    } else {
        current.add(key);
    }
    const normalized = normalizeComments(
        Array.from(current).map(stableKey => commentByStableKey.value.get(stableKey)).filter(
            (candidate): candidate is IAnnotationCommentSummary => !!candidate,
        ),
    );
    selectedCommentKeys.value = normalized.map(candidate => candidate.stableKey);
    selectionAnchorKey.value = key;
}

function selectCommentRange(comment: IAnnotationCommentSummary, additive = false) {
    const anchorKey = selectionAnchorKey.value;
    const keys = visibleCommentKeys.value;
    const targetKey = comment.stableKey;
    const targetIndex = keys.indexOf(targetKey);
    if (targetIndex === -1) {
        setSelectedComments([comment], targetKey);
        return;
    }
    const anchorIndex = anchorKey ? keys.indexOf(anchorKey) : -1;
    if (anchorIndex === -1) {
        setSelectedComments([comment], targetKey);
        return;
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const rangeKeys = keys.slice(start, end + 1);
    const rangeComments = normalizeComments(
        rangeKeys
            .map(stableKey => commentByStableKey.value.get(stableKey))
            .filter((candidate): candidate is IAnnotationCommentSummary => !!candidate),
    );

    if (!additive) {
        setSelectedComments(rangeComments, anchorKey);
        return;
    }

    const merged = normalizeComments([
        ...selectedCommentKeys.value
            .map(stableKey => commentByStableKey.value.get(stableKey))
            .filter((candidate): candidate is IAnnotationCommentSummary => !!candidate),
        ...rangeComments,
    ]);
    setSelectedComments(merged, anchorKey);
}

function isCommentSelected(comment: IAnnotationCommentSummary) {
    return selectedCommentKeys.value.includes(comment.stableKey);
}

function isExpanded(groupId: string) {
    if (transientExpandedGroupIds.value.includes(groupId)) {
        return true;
    }
    return !collapsedGroupIds.value.includes(groupId);
}

function toggleGroup(groupId: string) {
    const collapsed = new Set(collapsedGroupIds.value);
    const transient = new Set(transientExpandedGroupIds.value);
    const suppressed = new Set(transientSuppressedGroupIds.value);

    if (isExpanded(groupId)) {
        collapsed.add(groupId);
        if (transient.has(groupId)) {
            transient.delete(groupId);
            suppressed.add(groupId);
        }
        collapsedGroupIds.value = Array.from(collapsed);
        transientExpandedGroupIds.value = Array.from(transient);
        transientSuppressedGroupIds.value = Array.from(suppressed);
        return;
    }
    collapsed.delete(groupId);
    transient.delete(groupId);
    suppressed.delete(groupId);
    collapsedGroupIds.value = Array.from(collapsed);
    transientExpandedGroupIds.value = Array.from(transient);
    transientSuppressedGroupIds.value = Array.from(suppressed);
}

function expandAll() {
    const collapsed = new Set(collapsedGroupIds.value);
    allGroupIds.value.forEach(groupId => collapsed.delete(groupId));
    collapsedGroupIds.value = Array.from(collapsed);
    transientSuppressedGroupIds.value = transientSuppressedGroupIds.value.filter(
        groupId => !allGroupIds.value.includes(groupId),
    );
    refreshTransientGroupExpansion();
}

function collapseAll() {
    const collapsed = new Set(collapsedGroupIds.value);
    allGroupIds.value.forEach(groupId => collapsed.add(groupId));
    collapsedGroupIds.value = Array.from(collapsed);
    const transient = new Set(transientExpandedGroupIds.value);
    const suppressed = new Set(transientSuppressedGroupIds.value);
    allGroupIds.value.forEach((groupId) => {
        transient.delete(groupId);
        suppressed.add(groupId);
    });
    transientExpandedGroupIds.value = Array.from(transient);
    transientSuppressedGroupIds.value = Array.from(suppressed);
}

function updateSetting(
    key: keyof IAnnotationSettings,
    value: IAnnotationSettings[keyof IAnnotationSettings],
) {
    emit('update-setting', {
        key,
        value,
    });
}

function applyQuickTool(quick: IQuickToolPreset) {
    if (quick.action === 'highlight-selection') {
        emit('highlight-selection');
        return;
    }
    if (quick.action === 'comment-selection') {
        emit('comment-selection');
        return;
    }

    if (quick.tool) {
        emit('set-tool', quick.tool);
    }

    Object.entries(quick.settings ?? {}).forEach((entry) => {
        const key = entry[0];
        const value = entry[1];
        if (value === undefined) {
            return;
        }
        updateSetting(
            key as keyof IAnnotationSettings,
            value as IAnnotationSettings[keyof IAnnotationSettings],
        );
    });
}

function applySelectedQuickTool() {
    const quick = quickTools.find(candidate => candidate.id === selectedQuickToolId.value);
    if (!quick) {
        return;
    }
    applyQuickTool(quick);
}

const selectedQuickTool = computed(() => (
    quickTools.find(candidate => candidate.id === selectedQuickToolId.value) ?? quickTools[0] ?? null
));

function quickToolUsageHint(quick: IQuickToolPreset | null) {
    if (!quick) {
        return 'Choose a preset, then apply it.';
    }
    if (quick.action === 'comment-selection') {
        return 'Creates a pop-up note from the current text selection.';
    }
    if (quick.action === 'highlight-selection') {
        return 'Highlights the currently selected text.';
    }
    if (quick.tool === 'highlight') {
        return 'Switches to text markup mode using this preset.';
    }
    if (quick.tool === 'draw') {
        return 'Switches to ink drawing mode with this pen preset.';
    }
    if (quick.tool === 'text') {
        return 'Switches to text-note mode with this style.';
    }
    return 'Applies the selected quick annotation preset.';
}

const selectedQuickToolHint = computed(() => quickToolUsageHint(selectedQuickTool.value));
const effectiveToolForSettings = computed<TAnnotationTool>(() => {
    if (props.tool !== 'none') {
        return props.tool;
    }
    return selectedQuickTool.value?.tool ?? 'none';
});
const showHighlightSettings = computed(() => effectiveToolForSettings.value === 'highlight');
const showInkSettings = computed(() => effectiveToolForSettings.value === 'draw');
const showTextSettings = computed(() => effectiveToolForSettings.value === 'text');
const hasAdjustableToolSettings = computed(() => (
    showHighlightSettings.value || showInkSettings.value || showTextSettings.value
));

function handleReviewItemClick(event: MouseEvent, comment: IAnnotationCommentSummary) {
    closeContextMenu();
    focusReviewsList();
    if (event.shiftKey) {
        selectCommentRange(comment, event.metaKey || event.ctrlKey);
    } else if (event.metaKey || event.ctrlKey) {
        toggleSelectedComment(comment);
    } else {
        setSelectedComments([comment], comment.stableKey);
    }
    emit('focus-comment', comment);
}

function handleReviewItemDoubleClick(_event: MouseEvent, comment: IAnnotationCommentSummary) {
    closeContextMenu();
    setSelectedComments([comment], comment.stableKey);
    emit('focus-comment', comment);
    emit('open-note', comment);
}

function reviewItemText(comment: IAnnotationCommentSummary) {
    const noteText = comment.text.trim();
    if (noteText) {
        return noteText;
    }
    if (comment.hasNote) {
        return 'Empty note';
    }
    const kind = reviewKindLabel(comment);
    return `${kind} annotation`;
}

function formatCommentTime(timestamp: number | null) {
    if (!timestamp) {
        return 'No date';
    }
    return timeFormatter.format(new Date(timestamp));
}

const contextMenuStyle = computed(() => ({
    left: `${contextMenu.value.x}px`,
    top: `${contextMenu.value.y}px`,
}));
const contextMenuComments = computed(() => normalizeComments(contextMenu.value.comments));
const canOpenContextComment = computed(() => contextMenuComments.value.length === 1);

const canCopyContextComment = computed(() => {
    const text = canOpenContextComment.value
        ? contextMenuComments.value[0]?.text?.trim()
        : '';
    return Boolean(text);
});

function openCommentContextMenu(event: MouseEvent, comment: IAnnotationCommentSummary) {
    if (!isCommentSelected(comment)) {
        setSelectedComments([comment], comment.stableKey);
    } else if (!selectionAnchorKey.value) {
        selectionAnchorKey.value = comment.stableKey;
    }
    const selectedComments = normalizeComments(
        selectedCommentKeys.value
            .map(stableKey => commentByStableKey.value.get(stableKey))
            .filter((candidate): candidate is IAnnotationCommentSummary => !!candidate),
    );
    const comments = selectedComments.length > 0 ? selectedComments : [comment];
    openContextMenuAt(event.clientX, event.clientY, comments);
    emit('focus-comment', comment);
}

function openGroupContextMenu(event: MouseEvent, node: IGroupNode) {
    const comments = normalizeComments(collectCommentsFromNode(node));
    if (comments.length === 0) {
        return;
    }
    const focusComment = comments[0];
    if (!focusComment) {
        return;
    }
    setSelectedComments(comments, focusComment.stableKey);
    openContextMenuAt(event.clientX, event.clientY, comments);
    emit('focus-comment', focusComment);
}

function openContextMenuAt(clientX: number, clientY: number, comments: IAnnotationCommentSummary[]) {
    const width = 230;
    const height = 124;
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);

    contextMenu.value = {
        visible: true,
        x: Math.min(Math.max(margin, clientX), maxX),
        y: Math.min(Math.max(margin, clientY), maxY),
        comments: normalizeComments(comments),
    };
}

function closeContextMenu() {
    if (!contextMenu.value.visible) {
        return;
    }
    contextMenu.value = {
        visible: false,
        x: 0,
        y: 0,
        comments: [],
    };
}

function openContextNote() {
    if (!canOpenContextComment.value) {
        return;
    }
    const comment = contextMenuComments.value[0];
    if (!comment) {
        return;
    }
    emit('open-note', comment);
    closeContextMenu();
}

function copyContextNoteText() {
    if (!canOpenContextComment.value) {
        return;
    }
    const comment = contextMenuComments.value[0];
    if (!comment) {
        return;
    }
    emit('copy-comment', comment);
    closeContextMenu();
}

function deleteContextComment() {
    const comments = contextMenuComments.value;
    if (comments.length === 0) {
        return;
    }
    comments.forEach((comment) => {
        emit('delete-comment', comment);
    });
    selectedCommentKeys.value = selectedCommentKeys.value.filter(stableKey => !comments.some(comment => comment.stableKey === stableKey));
    if (selectionAnchorKey.value && !selectedCommentKeys.value.includes(selectionAnchorKey.value)) {
        selectionAnchorKey.value = selectedCommentKeys.value.at(0) ?? null;
    }
    closeContextMenu();
}

function deleteSelectedComments() {
    const comments = getSelectedComments();
    if (comments.length === 0) {
        return;
    }
    comments.forEach((comment) => {
        emit('delete-comment', comment);
    });
    closeContextMenu();
}

function selectAllVisibleComments() {
    const comments = normalizeComments(
        visibleCommentKeys.value
            .map(stableKey => commentByStableKey.value.get(stableKey))
            .filter((candidate): candidate is IAnnotationCommentSummary => !!candidate),
    );
    if (comments.length === 0) {
        return;
    }
    const anchor = comments[0]?.stableKey ?? null;
    setSelectedComments(comments, anchor);
    const focusComment = comments[0];
    if (focusComment) {
        emit('focus-comment', focusComment);
        scrollCommentIntoView(focusComment.stableKey);
    }
}

function moveSelection(step: number, extendRange: boolean) {
    const keys = visibleCommentKeys.value;
    if (keys.length === 0) {
        return;
    }

    const selectedSet = new Set(selectedCommentKeys.value);
    let currentIndex = -1;

    if (selectionAnchorKey.value && selectedSet.has(selectionAnchorKey.value)) {
        currentIndex = keys.indexOf(selectionAnchorKey.value);
    }

    if (currentIndex === -1 && selectedSet.size > 0) {
        const selectedIndexes = keys
            .map((stableKey, index) => (selectedSet.has(stableKey) ? index : -1))
            .filter(index => index >= 0);
        if (selectedIndexes.length > 0) {
            currentIndex = step > 0
                ? Math.max(...selectedIndexes)
                : Math.min(...selectedIndexes);
        }
    }

    if (currentIndex === -1) {
        currentIndex = step >= 0 ? -1 : keys.length;
    }

    const nextIndex = Math.min(keys.length - 1, Math.max(0, currentIndex + step));
    const nextStableKey = keys[nextIndex];
    if (!nextStableKey) {
        return;
    }
    const nextComment = commentByStableKey.value.get(nextStableKey);
    if (!nextComment) {
        return;
    }

    if (extendRange) {
        if (!selectionAnchorKey.value) {
            selectionAnchorKey.value = nextStableKey;
        }
        selectCommentRange(nextComment);
    } else {
        setSelectedComments([nextComment], nextStableKey);
    }

    emit('focus-comment', nextComment);
    scrollCommentIntoView(nextStableKey);
}

function selectEdgeComment(edge: 'start' | 'end') {
    const keys = visibleCommentKeys.value;
    if (keys.length === 0) {
        return;
    }
    const targetKey = edge === 'start'
        ? keys[0]
        : keys[keys.length - 1];
    if (!targetKey) {
        return;
    }
    const targetComment = commentByStableKey.value.get(targetKey);
    if (!targetComment) {
        return;
    }
    setSelectedComments([targetComment], targetKey);
    emit('focus-comment', targetComment);
    scrollCommentIntoView(targetKey);
}

function toggleGroupFromKeyboard(target: EventTarget | null, key: 'ArrowLeft' | 'ArrowRight') {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    const groupButton = target.closest<HTMLElement>('.reviews-group');
    if (groupButton) {
        const groupId = groupButton.dataset.groupId ?? null;
        if (!groupId) {
            return false;
        }

        if (key === 'ArrowRight') {
            if (!isExpanded(groupId)) {
                toggleGroup(groupId);
            }
            return true;
        }

        if (isExpanded(groupId)) {
            toggleGroup(groupId);
            return true;
        }

        const parentGroupId = findParentGroupId(groupId, reviewTree.value);
        if (parentGroupId) {
            focusGroupButton(parentGroupId);
        }
        return true;
    }

    const primaryComment = getPrimarySelectedComment();
    if (!primaryComment || key !== 'ArrowLeft') {
        return false;
    }
    const ancestorPath = getCommentAncestorGroupPath(primaryComment.stableKey);
    const deepestExpandedAncestor = [...ancestorPath].reverse().find(groupId => isExpanded(groupId));
    if (!deepestExpandedAncestor) {
        return false;
    }
    toggleGroup(deepestExpandedAncestor);
    focusGroupButton(deepestExpandedAncestor);
    return true;
}

function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    const tagName = target.tagName;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
        return true;
    }
    return Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'));
}

function isInReviewsSection(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    return Boolean(target.closest('.reviews-section'));
}

function handlePanelKeydown(event: KeyboardEvent) {
    const key = event.key;
    const target = event.target;

    if (key === 'Escape') {
        if (contextMenu.value.visible) {
            event.preventDefault();
            closeContextMenu();
            return;
        }
        if (selectedCommentKeys.value.length > 0 && isInReviewsSection(target)) {
            event.preventDefault();
            selectedCommentKeys.value = [];
            selectionAnchorKey.value = null;
        }
        return;
    }

    if (!isInReviewsSection(target)) {
        return;
    }

    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && key.toLowerCase() === 'a') {
        if (isTypingTarget(target)) {
            return;
        }
        event.preventDefault();
        selectAllVisibleComments();
        return;
    }

    if (isTypingTarget(target)) {
        return;
    }

    if (key === 'ArrowDown') {
        event.preventDefault();
        moveSelection(1, event.shiftKey);
        return;
    }

    if (key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(-1, event.shiftKey);
        return;
    }

    if (key === 'PageDown') {
        event.preventDefault();
        moveSelection(8, event.shiftKey);
        return;
    }

    if (key === 'PageUp') {
        event.preventDefault();
        moveSelection(-8, event.shiftKey);
        return;
    }

    if (key === 'Home') {
        event.preventDefault();
        selectEdgeComment('start');
        return;
    }

    if (key === 'End') {
        event.preventDefault();
        selectEdgeComment('end');
        return;
    }

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const handled = toggleGroupFromKeyboard(target, key);
        if (handled) {
            event.preventDefault();
        }
        return;
    }

    if (key === 'Enter') {
        const primaryComment = getPrimarySelectedComment();
        if (!primaryComment) {
            return;
        }
        event.preventDefault();
        emit('focus-comment', primaryComment);
        emit('open-note', primaryComment);
        return;
    }

    if (key === 'Delete' || key === 'Backspace') {
        if (event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }
        if (selectedCommentKeys.value.length === 0) {
            return;
        }
        event.preventDefault();
        deleteSelectedComments();
    }
}

function handleWindowPointerDown(event: PointerEvent) {
    const target = event.target instanceof HTMLElement ? event.target : null;

    if (!contextMenu.value.visible) {
        return;
    }

    if (!target) {
        closeContextMenu();
        return;
    }

    if (target.closest('.reviews-context-menu')) {
        return;
    }

    closeContextMenu();
}

function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
        closeContextMenu();
    }
}

function handleToolSettingsToggle(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLDetailsElement)) {
        return;
    }
    toolSettingsOpen.value = target.open;
    saveBooleanSetting(STORAGE_KEYS.toolSettingsOpen, toolSettingsOpen.value);
}

function handleQuickSectionToggle(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLDetailsElement)) {
        return;
    }
    quickSectionOpen.value = target.open;
    saveBooleanSetting(STORAGE_KEYS.quickSectionOpen, quickSectionOpen.value);
}

onMounted(() => {
    if (typeof window !== 'undefined') {
        const storedQuickToolId = window.localStorage.getItem(STORAGE_KEYS.selectedQuickToolId);
        if (storedQuickToolId && quickTools.some(tool => tool.id === storedQuickToolId)) {
            selectedQuickToolId.value = storedQuickToolId;
        }
    }

    groupByPage.value = true;
    groupByAuthor.value = false;
    collapsedGroupIds.value = [];
    quickSectionOpen.value = loadBooleanSetting(STORAGE_KEYS.quickSectionOpen, false);
    toolSettingsOpen.value = loadBooleanSetting(STORAGE_KEYS.toolSettingsOpen, false);

    window.addEventListener('pointerdown', handleWindowPointerDown);
    window.addEventListener('keydown', handleWindowKeydown);
});

onBeforeUnmount(() => {
    window.removeEventListener('pointerdown', handleWindowPointerDown);
    window.removeEventListener('keydown', handleWindowKeydown);
});

watch(selectedQuickToolId, (nextId) => {
    if (typeof window === 'undefined') {
        return;
    }
    window.localStorage.setItem(STORAGE_KEYS.selectedQuickToolId, nextId);
});

watch(
    () => props.comments,
    (comments) => {
        const availableStableKeys = new Set(comments.map(comment => comment.stableKey));
        selectedCommentKeys.value = selectedCommentKeys.value.filter(stableKey => availableStableKeys.has(stableKey));
        const activeStableKey = props.activeCommentStableKey ?? null;
        if (activeStableKey && availableStableKeys.has(activeStableKey)) {
            void revealActiveComment(activeStableKey);
        }

        if (selectionAnchorKey.value && !availableStableKeys.has(selectionAnchorKey.value)) {
            selectionAnchorKey.value = selectedCommentKeys.value.at(-1) ?? null;
        }

        if (!contextMenu.value.visible || contextMenu.value.comments.length === 0) {
            return;
        }

        const nextContextComments = normalizeComments(
            contextMenu.value.comments
                .map(comment => commentByStableKey.value.get(comment.stableKey))
                .filter((candidate): candidate is IAnnotationCommentSummary => !!candidate),
        );

        if (nextContextComments.length === 0) {
            closeContextMenu();
            return;
        }

        contextMenu.value = {
            ...contextMenu.value,
            comments: nextContextComments,
        };
    },
);

watch(
    () => props.activeCommentStableKey,
    (stableKey) => {
        if (!stableKey) {
            return;
        }
        void revealActiveComment(stableKey);
    },
    { immediate: true },
);
</script>

<style scoped>
.pdf-annotations-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    height: 100%;
    min-height: 0;
    padding: 0.55rem;
    color: var(--ui-text);
    background: var(--ui-bg, #fff);
    overflow: auto;
}

.reviews-section {
    flex: 1 1 auto;
    min-height: 12rem;
    display: grid;
    grid-template-rows: auto auto auto minmax(7rem, 1fr) auto;
    border: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg, #fff) 94%, #eef2f7 6%);
    overflow: hidden;
}

.reviews-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.45rem 0.5rem;
    border-bottom: 1px solid var(--ui-border);
}

.reviews-title {
    margin: 0;
    font-size: 0.78rem;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--ui-text-muted);
}

.reviews-count {
    font-size: 0.76rem;
    color: var(--ui-text-dimmed);
    font-variant-numeric: tabular-nums;
}

.reviews-search {
    width: calc(100% - 1rem);
    margin: 0.5rem;
    min-height: 2rem;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg, #fff);
    color: inherit;
    padding: 0.32rem 0.5rem;
    font-size: 0.78rem;
    outline: none;
}

.reviews-search:focus {
    border-color: color-mix(in oklab, var(--ui-primary) 36%, var(--ui-border));
}

.reviews-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.22rem;
    padding: 0 0.5rem 0.45rem;
}

.reviews-filter {
    border: 1px solid var(--ui-border);
    background: var(--ui-bg, #fff);
    color: var(--ui-text-muted);
    font-size: 0.68rem;
    line-height: 1;
    min-height: 1.55rem;
    padding: 0 0.36rem;
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    cursor: pointer;
}

.reviews-filter:hover {
    border-color: color-mix(in oklab, var(--ui-primary) 26%, var(--ui-border));
    color: var(--ui-text);
}

.reviews-filter.is-active {
    border-color: color-mix(in oklab, var(--ui-primary) 42%, var(--ui-border));
    color: var(--ui-text);
    background: color-mix(in oklab, var(--ui-bg, #fff) 89%, var(--ui-primary) 11%);
}

.reviews-filter__label {
    white-space: nowrap;
}

.reviews-filter__count {
    min-width: 1.1rem;
    padding: 0.08rem 0.18rem;
    border-radius: 999px;
    font-size: 0.64rem;
    text-align: center;
    color: var(--ui-text-dimmed);
    background: color-mix(in oklab, var(--ui-bg, #fff) 87%, #dbe4f3 13%);
}

.reviews-list {
    min-height: 7rem;
    overflow: auto;
    padding: 0 0.35rem 0.45rem;
}

.reviews-hint {
    margin: 0.3rem 0.35rem 0.45rem;
    font-size: 0.68rem;
    color: var(--ui-text-dimmed);
}

.reviews-tree {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
}

.reviews-group {
    width: 100%;
    min-height: 1.9rem;
    border: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg, #fff) 92%, #e6ebf4 8%);
    color: inherit;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding-right: 0.42rem;
    cursor: pointer;
    text-align: left;
}

.reviews-group__icon {
    width: 0.86rem;
    height: 0.86rem;
    color: var(--ui-text-dimmed);
}

.reviews-group__label {
    flex: 1;
    font-size: 0.75rem;
}

.reviews-group__count {
    font-size: 0.71rem;
    color: var(--ui-text-muted);
}

.review-item {
    width: 100%;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg, #fff);
    color: inherit;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.22rem;
    padding: 0.34rem 0.42rem 0.4rem;
    cursor: pointer;
}

.review-item:hover {
    border-color: color-mix(in oklab, var(--ui-primary) 28%, var(--ui-border));
    background: color-mix(in oklab, var(--ui-bg, #fff) 94%, var(--ui-primary) 6%);
}

.review-item.is-selected {
    border-color: color-mix(in oklab, var(--ui-primary) 42%, var(--ui-border));
    background: color-mix(in oklab, var(--ui-bg, #fff) 88%, var(--ui-primary) 12%);
}

.review-item__head {
    display: flex;
    align-items: flex-start;
    gap: 0.34rem;
    justify-content: space-between;
    min-width: 0;
    font-size: 0.68rem;
    color: var(--ui-text-dimmed);
}

.review-item__meta-left {
    min-width: 0;
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.28rem;
}

.review-item__type {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--ui-border);
    border-radius: 0.2rem;
    padding: 0.06rem 0.24rem;
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--ui-text-muted);
    background: color-mix(in oklab, var(--ui-bg, #fff) 90%, #e5e7eb 10%);
}

.review-item__type.is-highlight {
    border-color: rgb(182 157 36 / 0.55);
    background: rgb(254 246 197 / 0.9);
    color: rgb(120 90 18);
}

.review-item__type.is-ink {
    border-color: rgb(23 118 74 / 0.4);
    background: rgb(221 247 232 / 0.95);
    color: rgb(24 99 67);
}

.review-item__type.is-text {
    border-color: rgb(59 130 246 / 0.4);
    background: rgb(224 236 255 / 0.95);
    color: rgb(40 84 158);
}

.review-item__page {
    font-variant-numeric: tabular-nums;
    color: var(--ui-text-muted);
}

.review-item__author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.review-item__time {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    font-size: 0.64rem;
    color: var(--ui-text-dimmed);
}

.review-item__text {
    font-size: 0.77rem;
    line-height: 1.34;
    color: var(--ui-text);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.reviews-empty {
    margin: 0.4rem 0.25rem;
    font-size: 0.76rem;
    color: var(--ui-text-dimmed);
}

.reviews-toolbar {
    display: grid;
    gap: 0.28rem;
    border-top: 1px solid var(--ui-border);
    padding: 0.38rem 0.4rem;
    background: color-mix(in oklab, var(--ui-bg, #fff) 92%, #eef2f7 8%);
}

.reviews-toolbar__line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.24rem;
}

.reviews-toolbar__label {
    font-size: 0.65rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ui-text-dimmed);
    min-width: 2.45rem;
}

.reviews-toggle {
    min-height: 1.78rem;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg, #fff);
    color: var(--ui-text-muted);
    font-size: 0.72rem;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.42rem;
    cursor: pointer;
}

.reviews-toggle__icon {
    width: 0.78rem;
    height: 0.78rem;
}

.reviews-toggle:hover {
    border-color: color-mix(in oklab, var(--ui-primary) 28%, var(--ui-border));
    color: var(--ui-text);
    background: color-mix(in oklab, var(--ui-bg, #fff) 95%, var(--ui-primary) 5%);
}

.reviews-toggle.is-active {
    color: var(--ui-text);
    border-color: color-mix(in oklab, var(--ui-primary) 42%, var(--ui-border));
    background: color-mix(in oklab, var(--ui-bg, #fff) 88%, var(--ui-primary) 12%);
}

.reviews-toggle--compact {
    font-size: 0.67rem;
    padding-inline: 0.36rem;
}

.quick-section {
    flex: 0 0 auto;
    border: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg, #fff) 94%, #eef2f7 6%);
    min-height: 0;
    overflow: visible;
}

.quick-section__summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    padding: 0.46rem 0.5rem;
    cursor: pointer;
    list-style: none;
    border-bottom: 1px solid var(--ui-border);
}

.quick-section__summary::-webkit-details-marker {
    display: none;
}

.quick-section[open] .quick-section__summary {
    background: color-mix(in oklab, var(--ui-bg, #fff) 90%, #eef2f7 10%);
}

.quick-section__content {
    display: grid;
    gap: 0.45rem;
    padding: 0.5rem;
    align-content: start;
}

.quick-section__title {
    font-size: 0.73rem;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--ui-text-muted);
}

.quick-section__meta {
    font-size: 0.7rem;
    color: var(--ui-text-dimmed);
    margin-left: auto;
}

.quick-section__chevron {
    width: 0.86rem;
    height: 0.86rem;
    color: var(--ui-text-dimmed);
    transition: transform 0.14s ease;
}

.quick-section[open] .quick-section__chevron {
    transform: rotate(180deg);
}

.quick-section__row {
    display: grid;
    gap: 0.25rem;
}

.quick-section__row--preset {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 0.35rem;
}

.quick-section__row--actions {
    display: grid;
    gap: 0.28rem;
    grid-template-columns: 1fr;
}

.quick-select-group {
    display: grid;
    gap: 0.24rem;
}

.quick-select-group__label {
    font-size: 0.72rem;
    color: var(--ui-text-muted);
    letter-spacing: 0.04em;
    text-transform: uppercase;
}

.quick-select {
    width: 100%;
    min-height: 2rem;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg, #fff);
    color: inherit;
    padding: 0 0.45rem;
    font-size: 0.78rem;
}

.quick-select:focus {
    outline: none;
    border-color: color-mix(in oklab, var(--ui-primary) 35%, var(--ui-border));
}

.quick-apply-button,
.quick-action,
.context-action {
    border: 1px solid var(--ui-border);
    background: var(--ui-bg, #fff);
    color: inherit;
    min-height: 2rem;
    font-size: 0.76rem;
    padding: 0 0.5rem;
    cursor: pointer;
}

.quick-action:hover,
.quick-apply-button:hover,
.context-action:hover {
    background: color-mix(in oklab, var(--ui-bg, #fff) 93%, var(--ui-primary) 7%);
}

.quick-action {
    text-align: left;
}

.quick-apply-button {
    min-width: 4.3rem;
    font-weight: 600;
}

.quick-preset-hint {
    margin: 0;
    font-size: 0.72rem;
    color: var(--ui-text-dimmed);
    line-height: 1.35;
}

.quick-keep-active {
    display: flex;
    align-items: center;
    gap: 0.38rem;
    font-size: 0.75rem;
    color: var(--ui-text-muted);
}

.tool-settings {
    border-top: 1px dashed var(--ui-border);
    padding-top: 0.42rem;
}

.tool-settings > summary {
    cursor: pointer;
    list-style: none;
    font-size: 0.74rem;
    color: var(--ui-text-muted);
}

.tool-settings > summary::-webkit-details-marker {
    display: none;
}

.tool-settings__grid {
    display: grid;
    gap: 0.42rem;
    margin-top: 0.42rem;
}

.tool-setting {
    display: grid;
    gap: 0.2rem;
    font-size: 0.74rem;
}

.tool-setting__color {
    width: 100%;
    height: 1.9rem;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    padding: 0.08rem;
}

.tool-setting__range {
    width: 100%;
}

.tool-settings__empty {
    margin: 0;
    font-size: 0.74rem;
    color: var(--ui-text-dimmed);
}

.tool-flags {
    display: grid;
    gap: 0.25rem;
    margin-top: 0.35rem;
    font-size: 0.74rem;
}

.reviews-context-menu {
    position: fixed;
    z-index: 70;
    min-width: 220px;
    display: grid;
    gap: 1px;
    border: 1px solid var(--ui-border);
    background: var(--ui-border);
    box-shadow:
        0 10px 24px rgb(15 23 42 / 20%),
        0 3px 8px rgb(15 23 42 / 15%);
}

.context-action {
    text-align: left;
    border: none;
    min-height: 2rem;
    padding: 0 0.6rem;
}

.context-action:disabled {
    color: var(--ui-text-dimmed);
    cursor: default;
    background: var(--ui-bg, #fff);
}

.context-action--danger {
    color: #b42318;
}
</style>
