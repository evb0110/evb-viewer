<template>
    <div class="model-picker-content" data-model-picker-content>
        <div v-if="!isSearching && railInstances.length" ref="rail" class="picker-rail" role="toolbar" aria-orientation="vertical" :aria-label="t('assistant.providers')" @keydown="handleRailKeydown">
            <span v-if="indicatorTop !== null" class="rail-indicator" :style="{ top: `${indicatorTop}px` }" aria-hidden="true" />
            <AppTooltip :text="t('assistant.favorites')" :content="railTooltip">
                <button type="button" class="rail-button" data-rail-tab="favorites" :aria-label="t('assistant.favorites')" :aria-pressed="tab === 'favorites'" :tabindex="tab === 'favorites' ? 0 : -1" @click="selectTab('favorites')">
                    <UIcon name="i-ph-star-fill" class="rail-star" />
                </button>
            </AppTooltip>
            <span class="rail-separator" aria-hidden="true" />
            <AppTooltip v-for="instance in railInstances" :key="instance.id" :text="describeInstance(instance)" :content="railTooltip">
                <button type="button" class="rail-button" :data-rail-tab="instance.id" :aria-label="describeInstance(instance)" :aria-pressed="tab === instance.id" :disabled="!isPickableInstance(instance)" :tabindex="tab === instance.id ? 0 : -1" @click="selectTab(instance.id)">
                    <AssistantProviderIcon class="rail-icon" :provider="instance.driver" :badge="instanceBadge(instance, instances)" />
                </button>
            </AppTooltip>
        </div>
        <div class="picker-list-column" :class="{ 'has-rail': !isSearching && railInstances.length }">
            <div class="picker-search">
                <UIcon name="i-ph-magnifying-glass" class="search-icon" />
                <input ref="search" v-model="query" class="search-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true" :aria-controls="listId" :aria-activedescendant="highlighted ? optionId(highlighted) : undefined" :placeholder="t('assistant.searchModels')" :aria-label="t('assistant.searchModels')" @keydown="handleSearchKeydown">
            </div>
            <div :id="listId" ref="list" class="picker-list app-scrollbar" role="listbox" :aria-label="t('assistant.searchModels')">
                <template v-for="(row, index) in rows" :key="row.key">
                    <div
                        v-if="row.kind === 'model'"
                        :id="optionId(row.key)"
                        class="picker-row"
                        role="option"
                        :aria-selected="row.key === activeKey"
                        :data-highlighted="row.key === highlighted || undefined"
                        @pointermove="highlighted = row.key"
                        @click="pick(row.item)"
                    >
                        <AssistantProviderIcon class="row-icon" :provider="row.item.instance.driver" :badge="instanceBadge(row.item.instance, instances)" />
                        <span class="row-name" :title="row.item.model.label">{{ row.item.model.label }}<span class="sr-only">, {{ row.item.instance.label }}</span></span>
                        <UIcon v-if="row.key === activeKey" name="i-ph-check" class="row-check" />
                        <span class="row-trailing">
                            <button type="button" class="row-star" :class="{ 'is-favorite': row.item.isFavorite, 'on-hover': tab === 'favorites' && !isSearching }" :aria-label="t(row.item.isFavorite ? 'assistant.removeFavorite' : 'assistant.addFavorite')" @keydown.stop @click.stop="toggleFavorite(row.item.instance.id, row.item.model.id)">
                                <UIcon :name="row.item.isFavorite ? 'i-ph-star-fill' : 'i-ph-star'" />
                            </button>
                            <kbd v-if="jumpLabels.get(row.key)" class="row-kbd">{{ jumpLabels.get(row.key) }}</kbd>
                        </span>
                    </div>
                    <div
                        v-else
                        :id="optionId(row.key)"
                        class="picker-row is-more"
                        role="option"
                        :aria-selected="false"
                        :aria-expanded="row.expanded"
                        :data-highlighted="row.key === highlighted || undefined"
                        :data-index="index"
                        @pointermove="highlighted = row.key"
                        @click="toggleLegacy"
                    >
                        {{ t(row.expanded ? 'assistant.showLess' : 'assistant.showMore') }}
                    </div>
                </template>
                <p v-if="!rows.length" class="picker-empty">{{ t(tab === 'favorites' && !isSearching ? 'assistant.noFavorites' : 'assistant.noModelsFound') }}</p>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core';
import type {
    IAssistantInstanceStatus, IAssistantSelection,
} from '@contracts/assistant';
import AssistantProviderIcon from '@app/modules/agent-panel/components/AssistantProviderIcon.vue';
import { useAssistantModelFavorites } from '@app/modules/agent-panel/composables/useAssistantModelFavorites';
import {
    instanceBadge,
    isPickableInstance,
    modelJumpIndex,
    modelJumpLabel,
    modelPickerKey,
    rankModelSearch,
    type IModelPickerItem,
    type TModelPickerTab,
} from '@app/modules/agent-panel/utils/assistantModelPicker';
import { useTypedI18n } from '@app/composables/useTypedI18n';

type TRow = { kind: 'model'; key: string; item: IModelPickerItem } | { kind: 'more'; key: string; expanded: boolean };

const props = defineProps<{
    instances: IAssistantInstanceStatus[];
    selection: IAssistantSelection | null;
}>();
const emit = defineEmits<{
    pick: [instanceId: string, modelId: string];
    focusEffort: [];
    close: [];
}>();
const { t } = useTypedI18n();
const listId = useId();
const search = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const rail = ref<HTMLElement | null>(null);
const query = ref('');
const {
    favoriteKeys, toggleFavorite,
} = useAssistantModelFavorites();
// Beside the rail, like T3 Code, so the list stays readable under the pointer.
const railTooltip = {
    side: 'left',
    sideOffset: 8,
} as const;
const stateKeys = {
    checking: 'assistant.stateChecking',
    ready: 'assistant.stateReady',
    warning: 'assistant.stateWarning',
    error: 'assistant.stateError',
    disabled: 'assistant.stateDisabled',
    missing: 'assistant.stateMissing',
} as const;

const railInstances = computed(() => props.instances.filter(instance => instance.enabled && instance.state !== 'disabled'));
const activeKey = computed(() => props.selection ? modelPickerKey(props.selection.instanceId, props.selection.model) : null);
const items = computed(() => props.instances.filter(isPickableInstance).flatMap(instance => instance.models.map((model): IModelPickerItem => {
    const key = modelPickerKey(instance.id, model.id);
    return {
        key,
        instance,
        model,
        isFavorite: favoriteKeys.value.has(key),
    };
})));
// Opens on Favorites when one can be picked, else on the selected model's provider (T3 Code).
const chosenTab = ref<TModelPickerTab | null>(null);
const tab = computed((): TModelPickerTab => chosenTab.value
    ?? (items.value.some(item => item.isFavorite) ? 'favorites' : (props.selection?.instanceId ?? railInstances.value[0]?.id ?? 'favorites')));
// Older models stay folded unless the selected model is one of them; each toggle flips that default.
const toggledLegacy = ref(new Set<string>());
const activeItem = computed(() => items.value.find(item => item.key === activeKey.value));
function isLegacyExpanded(instanceId: string) {
    const holdsActive = activeItem.value?.instance.id === instanceId && activeItem.value.model.isLegacy === true && !activeItem.value.isFavorite;
    return holdsActive !== toggledLegacy.value.has(instanceId);
}
const isSearching = computed(() => query.value.trim().length > 0);

const rows = computed((): TRow[] => {
    if (isSearching.value) return rankModelSearch(items.value, query.value).map(item => ({
        kind: 'model',
        key: item.key,
        item,
    }));
    if (tab.value === 'favorites') return items.value.filter(item => item.isFavorite).map(item => ({
        kind: 'model',
        key: item.key,
        item,
    }));
    const own = items.value.filter(item => item.instance.id === tab.value);
    const current = [
        ...own.filter(item => item.isFavorite),
        ...own.filter(item => !item.isFavorite && !item.model.isLegacy),
    ];
    const legacy = own.filter(item => !item.isFavorite && item.model.isLegacy);
    const expanded = isLegacyExpanded(tab.value);
    return [
        ...[
            ...current,
            ...(expanded ? legacy : []),
        ].map((item): TRow => ({
            kind: 'model',
            key: item.key,
            item,
        })),
        ...(legacy.length ? [{
            kind: 'more' as const,
            key: `more:${tab.value}`,
            expanded,
        }] : []),
    ];
});
const modelRows = computed(() => rows.value.flatMap(row => row.kind === 'model' ? [row] : []));
const jumpLabels = computed(() => new Map(modelRows.value.slice(0, 9).map((row, index) => [
    row.key,
    modelJumpLabel(index),
])));
const highlighted = ref<string | null>(null);
// A changed list highlights the selected model when it shows, else the first row.
watch(rows, value => {
    if (value.some(row => row.key === highlighted.value)) return;
    highlighted.value = value.find(row => row.key === activeKey.value)?.key ?? value[0]?.key ?? null;
}, { immediate: true });

const indicatorTop = ref<number | null>(null);
watch([
    tab,
    rail,
    railInstances,
], async () => {
    await nextTick();
    const button = Array.from(rail.value?.querySelectorAll<HTMLElement>('[data-rail-tab]') ?? []).find(item => item.dataset.railTab === tab.value);
    indicatorTop.value = button ? button.offsetTop + button.offsetHeight / 2 - 10 : null;
}, { immediate: true });

function optionId(key: string) {
    return `${listId}-${Array.from(key).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7).toString(36)}`;
}

function describeInstance(instance: IAssistantInstanceStatus) {
    if (isPickableInstance(instance)) return instance.label;
    return `${instance.label}: ${t(stateKeys[instance.state])}${instance.message ? `. ${instance.message}` : ''}`;
}

function focusSearch() {
    search.value?.focus({ preventScroll: true });
}

function selectTab(next: TModelPickerTab) {
    chosenTab.value = next;
    requestAnimationFrame(focusSearch);
}

function toggleLegacy() {
    const next = new Set(toggledLegacy.value);
    if (next.has(tab.value)) next.delete(tab.value);
    else next.add(tab.value);
    toggledLegacy.value = next;
}

function pick(item: IModelPickerItem) {
    emit('pick', item.instance.id, item.model.id);
}

function scrollHighlightedIntoView() {
    nextTick(() => list.value?.querySelector('[data-highlighted]')?.scrollIntoView({ block: 'nearest' }));
}

function moveHighlight(step: 1 | -1) {
    const index = rows.value.findIndex(row => row.key === highlighted.value);
    const next = rows.value[Math.min(rows.value.length - 1, Math.max(0, index + step))];
    if (!next) return;
    highlighted.value = next.key;
    scrollHighlightedIntoView();
}

function handleSearchKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
        return;
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        const row = rows.value.find(candidate => candidate.key === highlighted.value);
        if (row?.kind === 'model') pick(row.item);
        else if (row) toggleLegacy();
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        emit('close');
        return;
    }
    if (plain && ((event.key === 'ArrowLeft' && !event.shiftKey && !query.value) || (event.key === 'Tab' && event.shiftKey))) {
        const button = rail.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)')
            ?? rail.value?.querySelector<HTMLButtonElement>('button:not(:disabled)');
        if (button) {
            event.preventDefault();
            button.focus();
        }
        return;
    }
    // Right at the end of the text moves into the effort column; a highlighted model is picked first.
    if (plain && !event.shiftKey && event.key === 'ArrowRight' && search.value?.selectionStart === query.value.length) {
        event.preventDefault();
        const row = rows.value.find(candidate => candidate.key === highlighted.value);
        if (row?.kind === 'model' && row.key !== activeKey.value) pick(row.item);
        else emit('focusEffort');
    }
}

function handleRailKeydown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowRight') {
        event.preventDefault();
        focusSearch();
        return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(rail.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = buttons.findIndex(button => button === document.activeElement);
    const next = buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    event.preventDefault();
    next?.focus();
}

// Capture gives the picker's ⌘1–⌘9 priority over the app's own shortcuts while it is open.
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    const index = modelJumpIndex(event);
    if (index === null) return;
    event.preventDefault();
    event.stopPropagation();
    const row = modelRows.value[index];
    if (row) pick(row.item);
}, { capture: true });

defineExpose({ focusSearch });
</script>

<style scoped>
.model-picker-content {
    display: flex;
    width: calc(var(--app-assistant-picker-rail-width) + var(--app-assistant-picker-list-width));
    max-width: 100%;
    min-height: 0;
    flex-direction: row;
    overflow: hidden;
}

.picker-rail {
    position: relative;
    display: flex;
    width: var(--app-assistant-picker-rail-width);
    flex: 0 0 auto;
    flex-direction: column;
    gap: var(--app-space-sm);
    padding: var(--app-space-sm);
    overflow: hidden auto;
    background: color-mix(in oklab, var(--ui-bg-muted) 30%, transparent);
    scrollbar-width: none;
}

.rail-indicator {
    position: absolute;
    right: var(--app-space-sm);
    z-index: var(--app-z-local-raised);
    width: var(--app-space-3xs);
    height: var(--app-space-15xl);
    border-radius: var(--app-radius-full);
    background: var(--ui-primary);
    pointer-events: none;
    transition: top 200ms ease-out;
}

.rail-button {
    display: flex;
    width: 100%;
    aspect-ratio: 1;
    align-items: center;
    justify-content: center;
    border-radius: var(--app-radius-md);
    color: var(--ui-text);
    cursor: pointer;
    font-size: var(--app-space-15xl);
    transition: background-color 120ms ease;
}

.rail-button:hover,
.rail-button:focus-visible {
    outline: none;
    background: color-mix(in oklab, var(--ui-text) 10%, transparent);
}

.rail-button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
}

.rail-button:disabled:hover {
    background: transparent;
}

.rail-star {
    width: var(--app-assistant-provider-icon-size);
    height: var(--app-assistant-provider-icon-size);
}

.rail-separator {
    border-bottom: 1px solid var(--ui-border);
}

.picker-list-column {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    background: color-mix(in oklab, var(--ui-bg-muted) 40%, transparent);
}

.picker-list-column.has-rail {
    border-left: 1px solid var(--ui-border);
}

.picker-search {
    display: flex;
    align-items: center;
    gap: var(--app-space-3xl);
    margin: var(--app-space-6xl) var(--app-space-9xl) 0;
    padding-bottom: var(--app-space-lg);
    border-bottom: 1px solid var(--ui-border);
}

.picker-search:focus-within {
    border-bottom-color: var(--ui-primary);
}

.search-icon {
    flex: 0 0 auto;
    color: var(--ui-text-muted);
}

.search-input {
    min-width: 0;
    flex: 1 1 auto;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--ui-text);
    font-size: var(--app-text-size-body);
}

.search-input::placeholder {
    color: var(--ui-text-dimmed);
}

.picker-list {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    gap: var(--app-space-3xs);
    padding: var(--app-space-lg) var(--app-space-sm) var(--app-space-lg) var(--app-space-3xl);
    overflow: hidden auto;
    overscroll-behavior: contain;
}

.picker-row {
    display: flex;
    min-height: var(--app-assistant-picker-row-height);
    flex: 0 0 auto;
    align-items: center;
    gap: var(--app-space-3xl);
    padding: 0 var(--app-space-3xl);
    border-radius: var(--app-radius-xs);
    color: var(--ui-text);
    cursor: pointer;
    font-size: var(--app-text-size-body);
}

.picker-row[data-highlighted] {
    background: color-mix(in oklab, var(--ui-text) 9%, transparent);
}

.picker-row.is-more {
    color: var(--ui-text-muted);
}

.picker-row.is-more[data-highlighted] {
    color: var(--ui-text);
}

.row-icon {
    font-size: var(--app-text-size-body);
}

.row-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.row-check {
    flex: 0 0 auto;
}

.row-trailing {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--app-space-lg);
    margin-left: auto;
}

.row-star {
    display: flex;
    padding: var(--app-space-3xs);
    border-radius: var(--app-radius-xs);
    color: var(--ui-text-muted);
    cursor: pointer;
    opacity: 0;
}

.picker-row:hover .row-star,
.picker-row[data-highlighted] .row-star,
.row-star:focus-visible,
.row-star.is-favorite {
    opacity: 1;
}

.row-star.is-favorite {
    color: var(--ui-warning);
}

.row-star.is-favorite.on-hover {
    opacity: 0;
}

.picker-row:hover .row-star.on-hover,
.row-star.on-hover:focus-visible {
    opacity: 1;
}

.row-kbd {
    padding: var(--app-space-3xs) var(--app-space-sm);
    border-radius: var(--app-radius-xs);
    background: var(--ui-bg-accented);
    color: var(--ui-text-muted);
    font-family: inherit;
    font-size: var(--app-text-size-caption);
}

.picker-empty {
    margin: 0;
    padding: var(--app-space-3xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
}
</style>
