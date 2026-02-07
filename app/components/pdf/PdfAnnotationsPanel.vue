<template>
    <div class="pdf-annotations-panel">
        <section class="panel-section">
            <div class="panel-head">
                <h3 class="panel-title">Quick Annotations</h3>
                <span class="panel-meta">Okular-style presets</span>
            </div>
            <div class="quick-tool-grid">
                <button
                    v-for="quick in quickTools"
                    :key="quick.id"
                    type="button"
                    class="quick-tool"
                    :title="quick.label"
                    @click="applyQuickTool(quick)"
                >
                    <span class="quick-tool__swatch" :style="{ backgroundColor: quick.swatch }"></span>
                    <span class="quick-tool__label">{{ quick.label }}</span>
                </button>
            </div>
            <div class="quick-actions">
                <UButton
                    icon="i-lucide-highlighter"
                    variant="soft"
                    color="primary"
                    size="sm"
                    class="quick-action"
                    @pointerdown.prevent
                    @mousedown.prevent
                    @click="emit('highlight-selection')"
                >
                    Highlight Selection
                </UButton>
                <UButton
                    icon="i-lucide-message-circle"
                    variant="soft"
                    color="primary"
                    size="sm"
                    class="quick-action"
                    @pointerdown.prevent
                    @mousedown.prevent
                    @click="emit('comment-selection')"
                >
                    Pop-up Note from Selection
                </UButton>
            </div>
        </section>

        <section class="panel-section">
            <h3 class="panel-title">Tool Properties</h3>
            <div class="control-grid">
                <div class="control">
                    <label class="control__label">Highlight Color</label>
                    <input
                        class="control__color"
                        type="color"
                        :value="settings.highlightColor"
                        @input="updateSetting('highlightColor', ($event.target as HTMLInputElement).value)"
                    />
                </div>
                <div class="control">
                    <label class="control__label">Highlight Width <span>{{ settings.highlightThickness }}</span></label>
                    <input
                        class="control__range"
                        type="range"
                        min="4"
                        max="24"
                        step="1"
                        :value="settings.highlightThickness"
                        @input="updateSetting('highlightThickness', Number(($event.target as HTMLInputElement).value))"
                    />
                </div>
                <div class="control">
                    <label class="control__label">Ink Color</label>
                    <input
                        class="control__color"
                        type="color"
                        :value="settings.inkColor"
                        @input="updateSetting('inkColor', ($event.target as HTMLInputElement).value)"
                    />
                </div>
                <div class="control">
                    <label class="control__label">Ink Width <span>{{ settings.inkThickness }}</span></label>
                    <input
                        class="control__range"
                        type="range"
                        min="1"
                        max="16"
                        step="1"
                        :value="settings.inkThickness"
                        @input="updateSetting('inkThickness', Number(($event.target as HTMLInputElement).value))"
                    />
                </div>
            </div>
            <div class="control-flags">
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
        </section>

        <section class="panel-section panel-section--reviews">
            <div class="panel-head">
                <h3 class="panel-title">Reviews</h3>
                <span class="panel-meta">{{ filteredComments.length }}</span>
            </div>

            <div class="reviews-toolbar">
                <UButton
                    icon="i-lucide-file-text"
                    size="xs"
                    :variant="groupByPage ? 'soft' : 'ghost'"
                    :color="groupByPage ? 'primary' : 'neutral'"
                    title="Group by page"
                    @click="groupByPage = !groupByPage"
                />
                <UButton
                    icon="i-lucide-user"
                    size="xs"
                    :variant="groupByAuthor ? 'soft' : 'ghost'"
                    :color="groupByAuthor ? 'primary' : 'neutral'"
                    title="Group by author"
                    @click="groupByAuthor = !groupByAuthor"
                />
                <UButton
                    icon="i-lucide-arrow-down"
                    size="xs"
                    :variant="onlyCurrentPage ? 'soft' : 'ghost'"
                    :color="onlyCurrentPage ? 'primary' : 'neutral'"
                    title="Current page only"
                    @click="onlyCurrentPage = !onlyCurrentPage"
                />
                <div class="reviews-toolbar__spacer"></div>
                <UButton
                    icon="i-lucide-chevrons-down"
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    title="Expand all"
                    @click="expandAll"
                />
                <UButton
                    icon="i-lucide-chevrons-up"
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    title="Collapse all"
                    @click="collapseAll"
                />
            </div>

            <input
                v-model.trim="commentQuery"
                type="search"
                class="reviews-search"
                placeholder="Search annotations"
            />

            <ul v-if="visibleNodes.length > 0" class="reviews-tree">
                <li v-for="node in visibleNodes" :key="node.id">
                    <button
                        v-if="node.type === 'group'"
                        type="button"
                        class="reviews-group"
                        :style="{ paddingLeft: `${node.depth * 0.75 + 0.35}rem` }"
                        @click="toggleGroup(node.id)"
                    >
                        <UIcon
                            :name="isExpanded(node.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                            class="reviews-group__icon"
                        />
                        <span class="reviews-group__label">{{ node.label }}</span>
                        <span class="reviews-group__count">{{ node.count }}</span>
                    </button>

                    <div
                        v-else
                        class="review-item"
                        :style="{ paddingLeft: `${node.depth * 0.75 + 0.35}rem` }"
                    >
                        <button
                            type="button"
                            class="review-item__main"
                            @click="emit('focus-comment', node.comment)"
                            @dblclick="emit('open-note', node.comment)"
                        >
                            <span class="review-item__head">
                                <span class="review-item__page">P{{ node.comment.pageNumber }}</span>
                                <span class="review-item__author">{{ node.comment.author || 'Unknown Author' }}</span>
                                <span class="review-item__time">{{ formatCommentTime(node.comment.modifiedAt) }}</span>
                            </span>
                            <span class="review-item__text">{{ node.comment.text || 'Empty note' }}</span>
                        </button>
                        <div class="review-item__actions">
                            <UButton
                                icon="i-lucide-message-square"
                                size="xs"
                                variant="ghost"
                                color="neutral"
                                title="Open note"
                                @click="emit('open-note', node.comment)"
                            />
                            <UButton
                                icon="i-lucide-copy"
                                size="xs"
                                variant="ghost"
                                color="neutral"
                                title="Copy text"
                                @click="emit('copy-comment', node.comment)"
                            />
                            <UButton
                                icon="i-lucide-trash-2"
                                size="xs"
                                variant="ghost"
                                color="error"
                                title="Delete annotation"
                                @click="emit('delete-comment', node.comment)"
                            />
                        </div>
                    </div>
                </li>
            </ul>

            <p v-else class="reviews-empty">
                No annotations
            </p>
        </section>
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
    settings: IAnnotationSettings;
    comments: IAnnotationCommentSummary[];
    currentPage: number;
}

interface IQuickToolPreset {
    id: string;
    label: string;
    swatch: string;
    tool: TAnnotationTool;
    settings: Partial<IAnnotationSettings>;
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

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'set-tool', tool: TAnnotationTool): void;
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
        swatch: '#ffd54f',
        tool: 'highlight',
        settings: {
            highlightColor: '#ffd54f',
            highlightOpacity: 0.35,
            highlightThickness: 12,
            highlightFree: true,
        },
    },
    {
        id: 'quick-highlight-green',
        label: 'Green Highlighter',
        swatch: '#7cb342',
        tool: 'highlight',
        settings: {
            highlightColor: '#7cb342',
            highlightOpacity: 0.35,
            highlightThickness: 12,
            highlightFree: true,
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

const commentQuery = ref('');
const onlyCurrentPage = ref(false);
const groupByPage = ref(true);
const groupByAuthor = ref(true);
const expandedGroups = ref<string[]>([]);

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

const filteredComments = computed(() => {
    const query = commentQuery.value.trim().toLowerCase();
    const baseComments = onlyCurrentPage.value
        ? props.comments.filter(comment => comment.pageNumber === props.currentPage)
        : props.comments;

    return baseComments
        .filter((comment) => {
            if (!query) {
                return true;
            }

            return (
                comment.text.toLowerCase().includes(query)
                || (comment.author || '').toLowerCase().includes(query)
                || `p${comment.pageNumber}`.includes(query)
            );
        })
        .slice()
        .sort((a, b) => {
            if (a.pageIndex !== b.pageIndex) {
                return a.pageIndex - b.pageIndex;
            }
            const timeA = a.modifiedAt ?? 0;
            const timeB = b.modifiedAt ?? 0;
            if (timeA !== timeB) {
                return timeB - timeA;
            }
            return a.id.localeCompare(b.id);
        });
});

function makeCommentNode(comment: IAnnotationCommentSummary, depth: number): ICommentNode {
    return {
        type: 'comment',
        id: `comment:${comment.id}`,
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

watch(
    allGroupIds,
    (ids) => {
        if (expandedGroups.value.length === 0) {
            expandedGroups.value = [...ids];
            return;
        }

        const current = new Set(expandedGroups.value);
        const next = ids.filter(id => current.has(id));
        const unseen = ids.filter(id => !current.has(id));
        expandedGroups.value = [
            ...next,
            ...unseen,
        ];
    },
    { immediate: true },
);

const visibleNodes = computed(() => flattenVisible(reviewTree.value));

function isExpanded(groupId: string) {
    return expandedGroups.value.includes(groupId);
}

function toggleGroup(groupId: string) {
    if (isExpanded(groupId)) {
        expandedGroups.value = expandedGroups.value.filter(id => id !== groupId);
        return;
    }
    expandedGroups.value = [
        ...expandedGroups.value,
        groupId,
    ];
}

function expandAll() {
    expandedGroups.value = [...allGroupIds.value];
}

function collapseAll() {
    expandedGroups.value = [];
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
    emit('set-tool', quick.tool);
    Object.entries(quick.settings).forEach((entry) => {
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

function formatCommentTime(timestamp: number | null) {
    if (!timestamp) {
        return 'No date';
    }
    return timeFormatter.format(new Date(timestamp));
}
</script>

<style scoped>
.pdf-annotations-panel {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    padding: 0.6rem;
    color: var(--ui-text);
}

.panel-section {
    border: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg, #fff) 86%, var(--ui-bg-elevated, #f8fafc) 14%);
    padding: 0.6rem;
}

.panel-section--reviews {
    min-height: 0;
}

.panel-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.45rem;
}

.panel-title {
    margin: 0;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: var(--ui-text-muted);
}

.panel-meta {
    font-size: 0.68rem;
    color: var(--ui-text-dimmed);
}

.quick-tool-grid {
    display: grid;
    gap: 0.35rem;
    grid-template-columns: 1fr 1fr;
}

.quick-tool {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 2rem;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg, #fff);
    color: inherit;
    padding: 0.25rem 0.4rem;
    text-align: left;
    cursor: pointer;
}

.quick-tool:hover {
    border-color: color-mix(in oklab, var(--ui-primary) 28%, var(--ui-border));
    background: color-mix(in oklab, var(--ui-bg, #fff) 92%, var(--ui-primary) 8%);
}

.quick-tool__swatch {
    width: 0.75rem;
    height: 0.75rem;
    border: 1px solid rgb(0 0 0 / 20%);
    flex-shrink: 0;
}

.quick-tool__label {
    font-size: 0.72rem;
    line-height: 1.25;
}

.quick-actions {
    display: grid;
    gap: 0.35rem;
    margin-top: 0.5rem;
}

.quick-action {
    justify-content: flex-start;
}

.control-grid {
    display: grid;
    gap: 0.45rem;
}

.control {
    display: flex;
    flex-direction: column;
    gap: 0.24rem;
}

.control__label {
    display: flex;
    justify-content: space-between;
    font-size: 0.74rem;
}

.control__color {
    width: 100%;
    height: 1.8rem;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    padding: 0.08rem;
}

.control__range {
    width: 100%;
}

.control-flags {
    display: grid;
    gap: 0.3rem;
    margin-top: 0.35rem;
    font-size: 0.74rem;
}

.reviews-toolbar {
    display: flex;
    align-items: center;
    gap: 0.18rem;
    margin-bottom: 0.45rem;
}

.reviews-toolbar__spacer {
    flex: 1;
}

.reviews-search {
    width: 100%;
    min-height: 1.9rem;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg, #fff);
    color: inherit;
    padding: 0.28rem 0.45rem;
    font-size: 0.75rem;
}

.reviews-tree {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}

.reviews-group {
    width: 100%;
    border: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg, #fff) 90%, var(--ui-bg-elevated, #f8fafc) 10%);
    color: inherit;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 1.8rem;
    padding-right: 0.4rem;
    cursor: pointer;
}

.reviews-group__icon {
    width: 0.8rem;
    height: 0.8rem;
    color: var(--ui-text-dimmed);
}

.reviews-group__label {
    font-size: 0.73rem;
    flex: 1;
    text-align: left;
}

.reviews-group__count {
    font-size: 0.69rem;
    color: var(--ui-text-muted);
}

.review-item {
    border: 1px solid var(--ui-border);
    background: var(--ui-bg, #fff);
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.25rem;
    align-items: stretch;
}

.review-item__main {
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.36rem 0.36rem 0.4rem 0;
    cursor: pointer;
}

.review-item__head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.67rem;
    color: var(--ui-text-dimmed);
    min-width: 0;
}

.review-item__page {
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}

.review-item__author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.review-item__time {
    margin-left: auto;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}

.review-item__text {
    font-size: 0.75rem;
    line-height: 1.3;
    color: var(--ui-text);
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
}

.review-item__actions {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.05rem;
    padding: 0.1rem;
    border-left: 1px solid var(--ui-border);
}

.reviews-empty {
    margin: 0.55rem 0 0;
    font-size: 0.74rem;
    color: var(--ui-text-dimmed);
}
</style>
