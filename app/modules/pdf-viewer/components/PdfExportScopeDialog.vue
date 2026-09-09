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
            <div class="flex flex-col gap-4">
                <URadioGroup
                    v-model="scope"
                    :legend="t('export.scopeLabel')"
                    :items="scopeOptions"
                    :ui="radioGroupUi"
                />

                <UFormField
                    v-if="scope === 'range'"
                    :error="rangeError"
                    class="mt-1"
                    :ui="rangeFieldUi"
                >
                    <UInput
                        v-model="rangeInput"
                        :placeholder="t('export.rangePlaceholder')"
                        @blur="rangeTouched = true"
                    />
                </UFormField>

                <p class="m-0 mt-1 text-xs text-muted">
                    {{ exportSummary }}
                </p>
            </div>
        </template>

        <template #footer>
            <UButton
                color="neutral"
                variant="outline"
                :label="t('common.cancel')"
                @click="open = false"
            />
            <UButton
                color="primary"
                :label="dialogActionLabel"
                :disabled="totalPages <= 0"
                @click="handleSubmit"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">

import { parsePageRangeInput } from '@app/utils/document-viewer/pageLabels';
import { createPageSelectionFromRange } from '@app/utils/pdfPageSelection';
import { usePdfPageScopeSelection } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfPageScopeSelection';
import type { TPageSelection } from '@pdf-core/pdfPageSelection';
import { pageSelectionCount } from '@pdf-core/pdfPageSelection';

type TExportMode = 'images' | 'multipage-tiff';

const open = defineModel<boolean>('open', { required: true });

const {
    currentPage,
    mode,
    selectedPageSelection = null,
    selectedPages,
    totalPages,
} = defineProps<{
    mode: TExportMode;
    totalPages: number;
    currentPage: number;
    selectedPages: number[];
    selectedPageSelection?: TPageSelection | null | undefined;
}>();

const emit = defineEmits<{submit: [payload: { pageSelection?: TPageSelection }];}>();

const { t } = useTypedI18n();

const radioGroupUi = {
    fieldset: 'gap-y-2',
    legend: 'mb-0.5 text-xs text-muted font-normal',
    item: 'items-center',
    label: 'font-normal',
} as const;

const rangeFieldUi = { error: 'mt-1 text-xs' } as const;

const dialogTitle = computed(() => (
    mode === 'images'
        ? t('dialogs.exportImages')
        : t('dialogs.exportMultiPageTiff')
));

const dialogActionLabel = computed(() => (
    mode === 'images'
        ? t('export.exportImagesAction')
        : t('export.exportTiffAction')
));

const rangeSelection = computed(() => createPageSelectionFromRange(
    parsePageRangeInput(rangeInput.value, totalPages),
    totalPages,
));

const {
    scope,
    rangeInput,
    rangeTouched,
    normalizedSelectedPageSelection,
    resetScopeForOpen,
    resolveScopedPageSelection,
} = usePdfPageScopeSelection({
    totalPages: () => totalPages,
    currentPage: () => currentPage,
    selectedPages: () => selectedPages,
    selectedPageSelection: () => selectedPageSelection ?? null,
    resolveRangeSelection: () => rangeSelection.value,
});

const scopeOptions = computed(() => {
    const options = [
        {
            value: 'all',
            label: t('export.scopeAll', { count: totalPages }),
        },
        {
            value: 'current',
            label: t('export.scopeCurrent', { page: currentPage }),
        },
        {
            value: 'range',
            label: t('export.scopeRange'),
        },
    ];

    if (pageSelectionCount(normalizedSelectedPageSelection.value) > 0) {
        options.push({
            value: 'selected',
            label: t('export.scopeSelected', { count: pageSelectionCount(normalizedSelectedPageSelection.value) }),
        });
    }

    return options;
});

const rangeError = computed(() => (
    scope.value === 'range'
    && rangeTouched.value
    && rangeInput.value.trim().length > 0
    && rangeSelection.value === null
        ? t('export.invalidRange')
        : false
));

const exportSummary = computed(() => {
    if (scope.value === 'all') {
        return t('export.summaryAll', { count: totalPages });
    }
    if (scope.value === 'current') {
        return t('export.summaryCurrent', { page: currentPage });
    }
    if (scope.value === 'selected') {
        return t('export.summarySelected', { count: pageSelectionCount(normalizedSelectedPageSelection.value) });
    }
    if (rangeSelection.value) {
        return t('export.summaryRange', { count: pageSelectionCount(rangeSelection.value) });
    }
    return t('export.summaryRangeHint');
});

function handleSubmit() {
    if (totalPages <= 0) {
        return;
    }

    if (scope.value === 'range' && !rangeSelection.value) {
        rangeTouched.value = true;
        return;
    }

    const pageSelection = resolveScopedPageSelection();
    if (pageSelection === null) {
        rangeTouched.value = true;
        return;
    }

    emit('submit', {...(pageSelection !== undefined ? { pageSelection } : {})});
    open.value = false;
}

watch(open, (isOpen) => {
    if (!isOpen) {
        return;
    }

    resetScopeForOpen();
});
</script>
