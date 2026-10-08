<template>
    <div class="document-search-bar flex flex-col gap-1.5 px-2 py-1.5">
        <AppSearchInput
            ref="inputRef"
            v-model="searchQuery"
            class="w-full"
            icon="i-ph-magnifying-glass"
            :aria-label="t('documentSourceSidebar.searchPlaceholder')"
            :placeholder="t('search.placeholder')"
            autofocus
            @cleared="onQueryCleared"
            @keydown.enter.exact.prevent="onSearch"
            @keydown.shift.enter="onPrevious"
        >
            <template #actions>
                <AppTooltip :text="t('search.previousMatch')" :delay-duration="1200">
                    <UButton
                        icon="i-ph-caret-up"
                        variant="ghost"
                        color="neutral"
                        size="xs"
                        class="min-w-auto px-1"
                        :disabled="totalMatches === 0"
                        :aria-label="t('search.previousMatchLabel')"
                        @click="onPrevious"
                    />
                </AppTooltip>
                <AppTooltip :text="t('search.nextMatch')" :delay-duration="1200">
                    <UButton
                        icon="i-ph-caret-down"
                        variant="ghost"
                        color="neutral"
                        size="xs"
                        class="min-w-auto px-1"
                        :disabled="totalMatches === 0"
                        :aria-label="t('search.nextMatchLabel')"
                        @click="onNext"
                    />
                </AppTooltip>
            </template>
        </AppSearchInput>

        <div class="flex items-center gap-1">
            <div class="search-toggle-group">
                <UButton
                    label="Aa"
                    variant="ghost"
                    color="neutral"
                    size="xs"
                    class="search-toggle"
                    :class="{ 'is-active': options.matchCase }"
                    :aria-pressed="options.matchCase"
                    :aria-label="t('search.caseSensitive')"
                    @click="toggleOption('matchCase')"
                />
                <UButton
                    label="W"
                    variant="ghost"
                    color="neutral"
                    size="xs"
                    class="search-toggle"
                    :class="{ 'is-active': options.wholeWord }"
                    :aria-pressed="options.wholeWord"
                    :aria-label="t('search.wholeWord')"
                    @click="toggleOption('wholeWord')"
                />
                <UButton
                    label=".*"
                    variant="ghost"
                    color="neutral"
                    size="xs"
                    class="search-toggle"
                    :class="{ 'is-active': options.useRegex }"
                    :aria-pressed="options.useRegex"
                    :aria-label="t('search.regex')"
                    @click="toggleOption('useRegex')"
                />
            </div>

            <div class="ml-auto">
                <AppTooltip :text="t('search.runSearchHint')" :delay-duration="1200">
                    <UButton
                        :label="t('search.runSearch')"
                        variant="outline"
                        color="primary"
                        size="xs"
                        class="search-run-button"
                        :disabled="!searchQuery.trim()"
                        :aria-label="t('search.runSearch')"
                        @click="onSearchButton"
                    />
                </AppTooltip>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { IResolvedSearchMatchOptions } from '@contracts/search';
import AppSearchInput from '@app/components/AppSearchInput.vue';

const { t } = useTypedI18n();

interface IProps {
    modelValue: string;
    totalMatches: number;
    options: IResolvedSearchMatchOptions;
}

interface IDocumentSearchBarExpose {focus: () => void;}

const {
    modelValue,
    options,
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:modelValue': [value: string];
    'update:options': [value: IResolvedSearchMatchOptions];
    search: [];
    next: [];
    previous: [];
}>();

const inputRef = useTemplateRef<{focus: () => void}>('inputRef');

const searchQuery = computed({
    get: () => modelValue,
    set: (value: string) => {
        if (value === modelValue) {
            return;
        }
        emit('update:modelValue', value);
    },
});

function focus() {
    inputRef.value?.focus();
}

function onQueryCleared() {
    emit('search');
}

function onSearch() {
    emit('search');
}

function onSearchButton() {
    emit('search');
    focus();
}

function onNext() {
    emit('next');
}

function onPrevious() {
    emit('previous');
}

function toggleOption(key: keyof IProps['options']) {
    emit('update:options', {
        ...options,
        [key]: !options[key],
    });
    focus();
}

defineExpose<IDocumentSearchBarExpose>({ focus });
</script>

<style scoped>
.search-toggle-group {
    display: inline-flex;
    align-items: stretch;
    height: var(--app-control-height-xs);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-md);
    overflow: hidden;
}

.search-toggle {
    min-width: auto;
    border-radius: 0;
    padding-inline: var(--app-sidebar-row-padding-inline);
    font-size: var(--app-sidebar-caption-font-size);
    font-weight: 600;
}

.search-toggle + .search-toggle {
    border-left: 1px solid var(--ui-border);
}

.search-toggle:hover {
    background: var(--app-sidebar-control-hover-bg);
    color: var(--ui-text);
}

.search-toggle.is-active {
    background: var(--app-search-toggle-active-bg);
    color: var(--ui-primary);
}

.search-run-button {
    height: var(--app-control-height-xs);
    font-size: var(--app-sidebar-caption-font-size);
    font-weight: 600;
}
</style>
