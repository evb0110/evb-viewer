<template>
    <UModal
        v-model:open="open"
        :title="dialogTitle"
        :ui="{ footer: 'justify-end gap-2' }"
    >
        <template #description>
            <span class="sr-only">
                {{ t('export.dialogDescription') }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-2">
                <p class="m-0 mb-0.5 text-xs text-muted">
                    {{ t('export.scopeLabel') }}
                </p>

                <label class="flex items-center gap-2 text-sm text-default">
                    <input
                        v-model="scope"
                        type="radio"
                        value="all"
                    >
                    <span>{{ t('export.scopeAll', { count: totalPages }) }}</span>
                </label>

                <label class="flex items-center gap-2 text-sm text-default">
                    <input
                        v-model="scope"
                        type="radio"
                        value="current"
                    >
                    <span>{{ t('export.scopeCurrent', { page: currentPage }) }}</span>
                </label>

                <label class="flex items-center gap-2 text-sm text-default">
                    <input
                        v-model="scope"
                        type="radio"
                        value="range"
                    >
                    <span>{{ t('export.scopeRange') }}</span>
                </label>

                <label
                    v-if="normalizedSelectedPages.length > 0"
                    class="flex items-center gap-2 text-sm text-default"
                >
                    <input
                        v-model="scope"
                        type="radio"
                        value="selected"
                    >
                    <span>{{ t('export.scopeSelected', { count: normalizedSelectedPages.length }) }}</span>
                </label>

                <UInput
                    v-if="scope === 'range'"
                    v-model="rangeInput"
                    :placeholder="t('export.rangePlaceholder')"
                    class="mt-1"
                    @blur="rangeTouched = true"
                />

                <p
                    v-if="scope === 'range' && rangeTouched && rangeInput.trim() && rangePages === null"
                    class="m-0 text-xs text-error"
                >
                    {{ t('export.invalidRange') }}
                </p>

                <p class="m-0 mt-1 text-xs text-muted">
                    {{ exportSummary }}
                </p>
            </div>
        </template>

        <template #footer>
            <UButton
                color="neutral"
                variant="ghost"
                :label="t('common.cancel')"
                @click="open = false"
            />
            <UButton
                color="primary"
                :label="dialogActionLabel"
                :disabled="props.totalPages <= 0"
                @click="handleSubmit"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
import {
    computed,
    ref,
    watch,
} from 'vue';
import { parsePageRangeInput } from '@app/utils/pdf-page-labels';

type TExportScope = 'all' | 'current' | 'range' | 'selected';
type TExportMode = 'images' | 'multipage-tiff';

const open = defineModel<boolean>('open', { required: true });

const props = defineProps<{
    mode: TExportMode;
    totalPages: number;
    currentPage: number;
    selectedPages: number[];
}>();

const emit = defineEmits<{submit: [payload: { pageNumbers?: number[] }];}>();

const { t } = useTypedI18n();

const scope = ref<TExportScope>('all');
const rangeInput = ref('');
const rangeTouched = ref(false);

const normalizedSelectedPages = computed(() => Array.from(new Set(props.selectedPages))
    .filter(page => Number.isInteger(page) && page >= 1 && page <= props.totalPages)
    .sort((left, right) => left - right));

const dialogTitle = computed(() => (
    props.mode === 'images'
        ? t('dialogs.exportImages')
        : t('dialogs.exportMultiPageTiff')
));

const dialogActionLabel = computed(() => (
    props.mode === 'images'
        ? t('export.exportImagesAction')
        : t('export.exportTiffAction')
));

const rangePages = computed(() => {
    const parsed = parsePageRangeInput(rangeInput.value, props.totalPages);
    if (!parsed) {
        return null;
    }

    const pages: number[] = [];
    for (let page = parsed.startPage; page <= parsed.endPage; page += 1) {
        pages.push(page);
    }
    return pages;
});

const exportSummary = computed(() => {
    if (scope.value === 'all') {
        return t('export.summaryAll', { count: props.totalPages });
    }
    if (scope.value === 'current') {
        return t('export.summaryCurrent', { page: props.currentPage });
    }
    if (scope.value === 'selected') {
        return t('export.summarySelected', { count: normalizedSelectedPages.value.length });
    }
    if (rangePages.value) {
        return t('export.summaryRange', { count: rangePages.value.length });
    }
    return t('export.summaryRangeHint');
});

function handleSubmit() {
    if (props.totalPages <= 0) {
        return;
    }

    if (scope.value === 'range' && !rangePages.value) {
        rangeTouched.value = true;
        return;
    }

    let pageNumbers: number[] | undefined;
    if (scope.value === 'current') {
        pageNumbers = [props.currentPage];
    } else if (scope.value === 'selected') {
        pageNumbers = normalizedSelectedPages.value;
    } else if (scope.value === 'range') {
        pageNumbers = rangePages.value ?? undefined;
    }

    emit('submit', { pageNumbers });
    open.value = false;
}

watch(open, (isOpen) => {
    if (!isOpen) {
        return;
    }

    scope.value = normalizedSelectedPages.value.length > 0 ? 'selected' : 'all';
    rangeInput.value = '';
    rangeTouched.value = false;
});

watch(normalizedSelectedPages, (pages) => {
    if (scope.value === 'selected' && pages.length === 0) {
        scope.value = 'all';
    }
});

watch(scope, () => {
    rangeTouched.value = false;
});
</script>
