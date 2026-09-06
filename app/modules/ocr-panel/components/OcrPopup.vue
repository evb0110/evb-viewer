<template>
    <UModal
        v-model:open="isOpen"
        :title="t('ocr.runTitle')"
        :dismissible="!progress.isRunning && !isExporting"
        :ui="{ content: 'sm:max-w-3xl top-16 translate-y-0 max-h-[calc(100dvh-5rem)]', footer: 'justify-end gap-2' }"
    >
        <template #description>
            <span class="sr-only">
                {{ t('ocr.dialogDescription') }}
            </span>
        </template>

        <AppTooltip
            v-if="!hideTrigger"
            :text="triggerTooltip"
            :delay-duration="1200"
        >
            <UButton
                :class="[
                    'ocr-trigger',
                    {
                        'is-active': isOpen || progress.isRunning,
                    },
                ]"
                :disabled="disabled && !progress.isRunning"
                color="neutral"
                variant="ghost"
                size="md"
                square
                :icon="triggerButtonIcon"
                :aria-label="triggerTooltip"
                :aria-pressed="isOpen || progress.isRunning"
                type="button"
                :ui="{ leadingIcon: progress.isRunning ? 'size-5 animate-spin' : 'size-5' }"
            />
        </AppTooltip>
        <span v-else class="hidden-trigger" aria-hidden="true" />

        <template #body>
            <div class="ocr-body flex flex-col gap-4">
                <!-- CONFIGURE / ERROR STATE (config stays editable so errors stay recoverable) -->
                <template v-if="viewState === 'configure' || viewState === 'error'">
                    <!-- Error banner -->
                    <div
                        v-if="viewState === 'error'"
                        class="error"
                        role="alert"
                        aria-live="assertive"
                    >
                        <UIcon name="i-ph-warning-circle" class="size-4" />
                        <div class="error-content flex flex-1 flex-col gap-2">
                            <span class="error-text">{{ effectiveError }}</span>
                            <span
                                v-if="hasLanguageDownloadFailure"
                                class="error-retry-hint"
                            >
                                {{ t('ocr.languagePicker.retryDownload') }}
                            </span>
                            <AppTooltip :text="copyLogsTooltip" :delay-duration="1200">
                                <UButton
                                    icon="i-ph-copy"
                                    variant="ghost"
                                    color="neutral"
                                    size="xs"
                                    class="copy-logs"
                                    :loading="isCopyingLogs"
                                    :aria-label="t('ocr.copyLogs')"
                                    @click="handleCopyLogs"
                                />
                            </AppTooltip>
                        </div>
                    </div>

                    <!-- Page Range Selection -->
                    <div
                        class="section"
                    >
                        <URadioGroup
                            v-model="settings.pageRange"
                            name="pageRange"
                            :legend="t('ocr.pages')"
                            :items="pageRangeOptions"
                            value-key="value"
                            variant="table"
                            orientation="horizontal"
                            indicator="hidden"
                            :ui="segmentedRadioGroupUi"
                        />
                        <div
                            class="custom-range-reveal"
                            :class="{ 'is-open': showCustomRange }"
                        >
                            <div class="custom-range-reveal-inner">
                                <UInput
                                    v-model="settings.customRange"
                                    :placeholder="t('ocr.customRangePlaceholder')"
                                    size="sm"
                                    class="custom-input"
                                    :disabled="!showCustomRange"
                                    :tabindex="showCustomRange ? 0 : -1"
                                    :aria-hidden="!showCustomRange"
                                />
                            </div>
                        </div>
                    </div>

                    <div class="section">
                        <URadioGroup
                            v-model="settings.supersessionPolicy"
                            name="ocrSupersessionPolicy"
                            :items="supersessionPolicyItems"
                            value-key="value"
                            :ui="listRadioGroupUi"
                        >
                            <template #legend>
                                {{ t('ocr.supersession.label') }}
                                <OcrSettingHelpTooltip
                                    :trigger-label="t('ocr.settingHelpAria', { setting: t('ocr.supersession.label') })"
                                    :options="supersessionPolicyHelpItems"
                                />
                            </template>
                        </URadioGroup>
                        <p class="policy-hint" aria-live="polite">
                            {{ selectedSupersessionDescription }}
                        </p>
                        <div
                            class="supersession-acknowledgement"
                            :class="{ 'is-hidden': settings.supersessionPolicy !== 'replace-all' }"
                        >
                            <UCheckbox
                                v-model="settings.replaceAllAcknowledged"
                                :label="t('ocr.supersession.replaceAllAcknowledgement')"
                            />
                        </div>
                    </div>

                    <!-- Quality Profile Selection -->
                    <div
                        class="section"
                    >
                        <URadioGroup
                            v-model="settings.qualityProfile"
                            name="ocrQualityProfile"
                            :legend="t('ocr.qualityProfile.label')"
                            :items="qualityProfileItems"
                            value-key="value"
                            variant="table"
                            orientation="horizontal"
                            indicator="hidden"
                            :ui="segmentedRadioGroupUi"
                        >
                            <template #legend>
                                {{ t('ocr.qualityProfile.label') }}
                                <OcrSettingHelpTooltip
                                    :trigger-label="t('ocr.settingHelpAria', { setting: t('ocr.qualityProfile.label') })"
                                    :options="qualityProfileHelpItems"
                                />
                            </template>
                        </URadioGroup>
                    </div>

                    <!-- OCR tuning -->
                    <div class="section-row">
                        <div class="section">
                            <URadioGroup
                                v-model="settings.preprocessingMode"
                                name="ocrPreprocessingMode"
                                :legend="t('ocr.preprocessing.label')"
                                :items="preprocessingModeItems"
                                value-key="value"
                                variant="table"
                                orientation="horizontal"
                                indicator="hidden"
                                :ui="segmentedRadioGroupUi"
                            >
                                <template #legend>
                                    {{ t('ocr.preprocessing.label') }}
                                    <OcrSettingHelpTooltip
                                        :trigger-label="t('ocr.settingHelpAria', { setting: t('ocr.preprocessing.label') })"
                                        :options="preprocessingModeHelpItems"
                                    />
                                </template>
                            </URadioGroup>
                        </div>

                        <div class="section">
                            <UFormField
                                :label="t('ocr.pageSegmentation.label')"
                                :ui="formFieldUi"
                            >
                                <template #label>
                                    {{ t('ocr.pageSegmentation.label') }}
                                    <OcrSettingHelpTooltip
                                        :trigger-label="t('ocr.settingHelpAria', { setting: t('ocr.pageSegmentation.label') })"
                                        :options="pageSegmentationHelpItems"
                                    />
                                </template>
                                <USelect
                                    id="ocr-page-segmentation-mode"
                                    v-model="pageSegmentationModeSelectValue"
                                    :items="pageSegmentationItems"
                                    value-key="value"
                                    class="w-full"
                                    size="sm"
                                />
                            </UFormField>
                        </div>
                    </div>

                    <!-- Language Selection -->
                    <div class="section language-picker">
                        <div class="language-picker-header">
                            <span class="label">{{ t('ocr.languages') }}</span>
                            <AppSearchInput
                                v-if="showLanguageSearch"
                                v-model="languageSearchQuery"
                                icon="i-ph-magnifying-glass"
                                :placeholder="t('ocr.languagePicker.searchPlaceholder')"
                                :aria-label="t('ocr.languagePicker.searchPlaceholder')"
                                size="sm"
                                class="language-search"
                            />
                        </div>
                        <div class="language-picker-list app-scrollbar app-scroll-region--balanced">
                            <UCheckboxGroup
                                v-if="languagePickerItems.length > 0"
                                v-model="selectedLanguagesModel"
                                :legend="t('ocr.languages')"
                                :items="languagePickerItems"
                                value-key="value"
                                size="sm"
                                variant="card"
                                orientation="horizontal"
                                indicator="hidden"
                                :ui="languageChipGroupUi"
                            >
                                <template #label="{ item }">
                                    <span class="chip-name">{{ item.label }}</span>
                                    <span class="chip-code">{{ item.value }}</span>
                                    <span
                                        v-if="item.modelState === 'missing'"
                                        class="chip-state"
                                    >
                                        <UIcon name="i-ph-download-simple" class="size-3" />
                                        {{ t('ocr.languagePicker.downloadSizeHint') }}
                                    </span>
                                    <UIcon
                                        v-else-if="item.modelState === 'downloading'"
                                        name="i-ph-circle-notch"
                                        class="chip-spinner size-3 animate-spin"
                                        :aria-label="t('ocr.languageModelState.downloading')"
                                    />
                                    <span
                                        v-else-if="item.modelState === 'error'"
                                        class="chip-state is-error"
                                    >
                                        <UIcon name="i-ph-warning-circle" class="size-3" />
                                        {{ t('ocr.languagePicker.downloadFailed') }}
                                    </span>
                                </template>
                            </UCheckboxGroup>
                            <p v-else class="language-empty">
                                {{ t('ocr.languagePicker.noResults') }}
                            </p>
                        </div>
                        <p
                            v-if="showMultipleLanguagesHint"
                            class="language-accuracy-hint"
                            role="status"
                        >
                            <UIcon name="i-ph-info" class="size-4" />
                            {{ t('ocr.languagePicker.multiLanguageHint') }}
                        </p>
                    </div>
                </template>

                <!-- RUNNING STATE -->
                <div
                    v-else-if="viewState === 'running' || viewState === 'applying'"
                    class="ocr-progress-panel flex flex-col gap-3"
                    role="status"
                    aria-live="polite"
                >
                    <AppProgressBar :value="progressPercent" />
                    <span class="progress-text">{{ viewState === 'applying' ? applyingStatusText : progressStatusText }}</span>
                </div>

                <!-- RESULTS STATE -->
                <div
                    v-else
                    class="ocr-results-panel flex flex-col items-center gap-3"
                    role="status"
                    aria-live="polite"
                >
                    <UIcon
                        :name="hasResultWarning ? 'i-ph-warning-circle' : 'i-ph-check-circle'"
                        :class="[
                            'results-icon size-8',
                            { 'is-warning': hasResultWarning },
                        ]"
                    />
                    <span class="results-text">{{ resultStatusText }}</span>
                    <div
                        v-if="hasResultWarning"
                        class="results-warning"
                        role="alert"
                        aria-live="assertive"
                    >
                        <span class="results-warning-text">{{ effectiveError }}</span>
                        <AppTooltip :text="copyLogsTooltip" :delay-duration="1200">
                            <UButton
                                icon="i-ph-copy"
                                variant="ghost"
                                color="neutral"
                                size="xs"
                                class="copy-logs"
                                :loading="isCopyingLogs"
                                :aria-label="t('ocr.copyLogs')"
                                @click="handleCopyLogs"
                            />
                        </AppTooltip>
                    </div>
                </div>
            </div>
        </template>

        <template #footer>
            <template v-if="viewState === 'running' || viewState === 'applying'">
                <UButton
                    v-if="viewState === 'running'"
                    color="neutral"
                    variant="outline"
                    icon="i-ph-x"
                    :label="t('ocr.cancel')"
                    :disabled="progress.status === 'cancel-requested'"
                    @click="handleCancel"
                />
            </template>
            <template v-else-if="viewState === 'results'">
                <UButton
                    v-if="isExporting"
                    color="neutral"
                    variant="outline"
                    icon="i-ph-x"
                    :label="t('ocr.cancel')"
                    @click="handleCancelDocxExport"
                />
                <UButton
                    color="primary"
                    icon="i-ph-file-text"
                    :label="t('ocr.exportDocx')"
                    :loading="isExporting"
                    :disabled="isExporting || !workingCopyPath"
                    @click="handleExportDocx"
                />
                <UButton
                    color="neutral"
                    variant="outline"
                    :label="t('common.close')"
                    :disabled="isExporting"
                    @click="handleCloseResults"
                />
            </template>
            <template v-else>
                <UButton
                    color="neutral"
                    variant="outline"
                    :label="t('common.cancel')"
                    @click="isOpen = false"
                />
                <UButton
                    color="primary"
                    icon="i-ph-play"
                    :label="t('ocr.start')"
                    :disabled="!canRunOcr"
                    @click="handleRunOcr"
                />
            </template>
        </template>
    </UModal>
</template>

<script setup lang="ts">
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';

import type { TDocumentRef } from '@contracts/documentRef';
import type {
    TOcrPreprocessingMode,
    TOcrQualityProfile,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import type { TTranslationKey } from '@i18n-app';
import AppProgressBar from '@app/components/AppProgressBar.vue';
import OcrSettingHelpTooltip from '@app/modules/ocr-panel/components/OcrSettingHelpTooltip.vue';
import type { IOcrPopupAgentExpose } from '@app/types/ocrPopupAgentExpose';
import { OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE } from '@app/modules/ocr-panel/runtime/ocrPopupSettings';
import { useOcrPopupPresenter } from '@app/modules/ocr-panel/runtime/useOcrPopupPresenter';
import { getReaderCommandToolbarIcon } from '@app/utils/readerCommandIcons';
import type {
    IOcrSearchablePdfResult,
    TOcrPageRange,
} from '@app/utils/ocr/ocrTypes';
import AppSearchInput from '@app/components/AppSearchInput.vue';

const { t } = useTypedI18n();
type TOcrQualityProfileLabelKey = Extract<TTranslationKey, `ocr.qualityProfile.options.${string}`>;
type TOcrPreprocessingModeLabelKey = Extract<TTranslationKey, `ocr.preprocessing.options.${string}`>;
type TOcrPageSegmentationLabelKey = Extract<TTranslationKey, `ocr.pageSegmentation.options.${string}`>;
type TOcrQualityProfileHelpKey = Extract<TTranslationKey, `ocr.qualityProfile.help.${string}`>;
type TOcrPreprocessingModeHelpKey = Extract<TTranslationKey, `ocr.preprocessing.help.${string}`>;
type TOcrPageSegmentationHelpKey = Extract<TTranslationKey, `ocr.pageSegmentation.help.${string}`>;
type TOcrSupersessionLabelKey = Extract<TTranslationKey, `ocr.supersession.options.${string}`>;
type TOcrSupersessionDescriptionKey = Extract<TTranslationKey, `ocr.supersession.descriptions.${string}`>;

const ocrQualityProfileOptions = [
    'balanced',
    'accurate',
    'poor-scan',
] as const satisfies readonly TOcrQualityProfile[];

const ocrPreprocessingModeOptions = [
    'off',
    'clean',
] as const satisfies readonly TOcrPreprocessingMode[];

const ocrSupersessionPolicies = [
    'missing-only',
    'replace-evb',
    'replace-all',
] as const satisfies readonly TOcrTextSupersessionPolicy[];

const ocrPageSegmentationOptions = [
    {
        value: '',
        labelKey: 'ocr.pageSegmentation.options.auto',
        helpKey: 'ocr.pageSegmentation.help.auto',
    },
    {
        value: '6',
        labelKey: 'ocr.pageSegmentation.options.singleBlock',
        helpKey: 'ocr.pageSegmentation.help.singleBlock',
    },
    {
        value: '11',
        labelKey: 'ocr.pageSegmentation.options.sparseText',
        helpKey: 'ocr.pageSegmentation.help.sparseText',
    },
] as const satisfies ReadonlyArray<{
    value: string;
    labelKey: TOcrPageSegmentationLabelKey;
    helpKey: TOcrPageSegmentationHelpKey;
}>;
const formFieldUi = { label: 'label ocr-setting-legend' } as const;
const listRadioGroupUi = {
    fieldset: 'gap-y-1.5',
    legend: 'label ocr-setting-legend',
    item: 'items-center',
    label: 'font-normal',
} as const;
const segmentedRadioGroupUi = {
    fieldset: 'w-full gap-x-1',
    legend: 'label ocr-setting-legend',
    item: 'flex-1 cursor-pointer items-center justify-center px-2 py-1.5',
    label: 'w-full truncate text-center text-xs font-medium',
} as const;
const languageChipGroupUi = {
    fieldset: 'w-full flex-wrap gap-1.5',
    legend: 'sr-only',
    item: 'language-chip',
    label: 'language-chip-label font-normal text-xs',
} as const;

interface IProps {
    pdfDocument: IPdfDocument | null;
    currentPage: number;
    totalPages: number;
    workingCopyPath: TDocumentRef | null;
    open: boolean;
    isExportingDocx?: boolean;
    externalError?: string | null;
    disabled?: boolean;
    hideTrigger?: boolean;
}

const {
    currentPage,
    disabled = false,
    externalError = undefined,
    hideTrigger = false,
    isExportingDocx,
    open,
    pdfDocument,
    totalPages,
    workingCopyPath,
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:open': [value: boolean];
    'update:running': [value: boolean];
    ocrComplete: [payload: IOcrSearchablePdfResult & {
        sourceWorkingCopyPath: TDocumentRef;
        sourcePageToRestore: number;
    }];
    'export-docx': [selectedLanguages: string[]];
    'cancel-docx-export': [];
}>();

const isOpen = computed({
    get: () => open,
    set: (value: boolean) => emit('update:open', value),
});
const isExporting = computed(() => isExportingDocx ?? false);
const {
    settings,
    progress,
    progressPercent,
    viewState,
    effectiveError,
    canRunOcr,
    showCustomRange,
    isCopyingLogs,
    copyLogsTooltip,
    showSuccessState,
    progressStatusText,
    applyingStatusText,
    triggerTooltip,
    hasResultWarning,
    resultStatusText,
    languageSearchQuery,
    languagePickerItems,
    showLanguageSearch,
    showMultipleLanguagesHint,
    hasLanguageDownloadFailure,
    selectedLanguagesModel,
    pageSegmentationModeSelectValue,
    handleCopyLogs,
    handleRunOcr,
    handleCancel,
    handleExportDocx,
    handleCancelDocxExport,
    handleCloseResults,
    runOcrForAgent,
    cancelOcrForAgent,
    getAgentOcrSnapshot,
} = useOcrPopupPresenter({
    isOpen,
    context: {
        pdfDocument: () => pdfDocument,
        currentPage: () => currentPage,
        totalPages: () => totalPages,
        workingCopyPath: () => workingCopyPath,
        disabled: () => disabled,
        externalError: () => externalError,
    },
    events: {
        onRunningChange: value => emit('update:running', value),
        onOcrComplete: payload => emit('ocrComplete', payload),
        onExportDocx: selectedLanguages => emit('export-docx', selectedLanguages),
        onCancelDocxExport: () => emit('cancel-docx-export'),
    },
});

const triggerIcon = computed(() => (
    showSuccessState.value ? 'ph:check-circle' : getReaderCommandToolbarIcon('ocr')
));
const triggerButtonIcon = computed(() => (
    progress.value.isRunning ? 'ph:circle-notch' : triggerIcon.value
));
const pageRangeOptions = computed<Array<{
    value: TOcrPageRange;
    label: string;
}>>(() => [
    {
        value: 'all',
        label: t('ocr.allPages', { total: totalPages }),
    },
    {
        value: 'current',
        label: t('ocr.currentPage', { page: currentPage }),
    },
    {
        value: 'custom',
        label: t('ocr.customRange'),
    },
]);
const qualityProfileItems = computed<Array<{
    value: TOcrQualityProfile;
    label: string;
}>>(() => ocrQualityProfileOptions.map(profile => ({
    value: profile,
    label: t(getQualityProfileLabelKey(profile), undefined),
})));
const preprocessingModeItems = computed<Array<{
    value: TOcrPreprocessingMode;
    label: string;
}>>(() => ocrPreprocessingModeOptions.map(mode => ({
    value: mode,
    label: t(getPreprocessingModeLabelKey(mode), undefined),
})));
const supersessionPolicyItems = computed<Array<{
    value: TOcrTextSupersessionPolicy;
    label: string;
}>>(() => ocrSupersessionPolicies.map(policy => ({
    value: policy,
    label: t(getSupersessionLabelKey(policy), undefined),
})));
const supersessionPolicyHelpItems = computed(() => ocrSupersessionPolicies.map(policy => ({
    label: t(getSupersessionLabelKey(policy), undefined),
    description: t(getSupersessionDescriptionKey(policy), undefined),
})));
const selectedSupersessionDescription = computed(() => t(
    getSupersessionDescriptionKey(settings.value.supersessionPolicy),
    undefined,
));
const pageSegmentationItems = computed<Array<{
    value: string;
    label: string;
}>>(() => ocrPageSegmentationOptions.map(option => ({
    value: option.value === ''
        ? OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE
        : option.value,
    label: t(option.labelKey, undefined),
})));
const qualityProfileHelpItems = computed(() => ocrQualityProfileOptions.map(profile => ({
    label: t(getQualityProfileLabelKey(profile), undefined),
    description: t(getQualityProfileHelpKey(profile), undefined),
})));
const preprocessingModeHelpItems = computed(() => ocrPreprocessingModeOptions.map(mode => ({
    label: t(getPreprocessingModeLabelKey(mode), undefined),
    description: t(getPreprocessingModeHelpKey(mode), undefined),
})));
const pageSegmentationHelpItems = computed(() => ocrPageSegmentationOptions.map(option => ({
    label: t(option.labelKey, undefined),
    description: t(option.helpKey, undefined),
})));
function getQualityProfileLabelKey(profile: TOcrQualityProfile): TOcrQualityProfileLabelKey {
    return `ocr.qualityProfile.options.${profile}`;
}

function getQualityProfileHelpKey(profile: TOcrQualityProfile): TOcrQualityProfileHelpKey {
    return `ocr.qualityProfile.help.${profile}`;
}

function getPreprocessingModeLabelKey(mode: TOcrPreprocessingMode): TOcrPreprocessingModeLabelKey {
    return `ocr.preprocessing.options.${mode}`;
}

function getPreprocessingModeHelpKey(mode: TOcrPreprocessingMode): TOcrPreprocessingModeHelpKey {
    return `ocr.preprocessing.help.${mode}`;
}

function getSupersessionLabelKey(policy: TOcrTextSupersessionPolicy): TOcrSupersessionLabelKey {
    return `ocr.supersession.options.${policy}`;
}

function getSupersessionDescriptionKey(policy: TOcrTextSupersessionPolicy): TOcrSupersessionDescriptionKey {
    return `ocr.supersession.descriptions.${policy}`;
}

defineExpose<IOcrPopupAgentExpose>({
    runOcrForAgent,
    cancelOcrForAgent,
    getAgentOcrSnapshot,
});
</script>

<style scoped>
.hidden-trigger {
    display: block;
    width: var(--toolbar-control-height, var(--app-toolbar-control-size));
    height: var(--toolbar-control-height, var(--app-toolbar-control-size));
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
}

.ocr-trigger {
    width: var(--toolbar-control-height, var(--app-toolbar-control-size));
    height: var(--toolbar-control-height, var(--app-toolbar-control-size));
}

.ocr-trigger.is-active {
    background: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
    color: var(--app-toolbar-control-hover-fg);
}

.ocr-trigger:disabled {
    color: var(--app-toolbar-control-disabled-fg);
    opacity: var(--app-toolbar-control-disabled-opacity);
}

.label,
:deep(.label) {
    font-size: var(--app-text-size-micro);
    color: var(--ui-text-muted);
    margin-bottom: var(--app-space-3xl);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

:deep(.ocr-setting-legend) {
    display: flex;
    align-items: center;
    gap: var(--app-space-sm);
}

.custom-range-reveal {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.18s ease;
}

.custom-range-reveal.is-open {
    grid-template-rows: 1fr;
    padding-top: var(--app-space-3xl);
}

.custom-range-reveal-inner {
    overflow: hidden;
    min-height: 0;
}

.custom-input {
    width: 100%;
}

.supersession-acknowledgement {
    margin-top: var(--app-space-3xl);
    padding: var(--app-space-lg);
    border: 1px solid var(--ui-warning);
    border-radius: var(--app-radius-md);
    background: color-mix(in srgb, var(--ui-warning) 8%, transparent);
    transition: opacity 0.18s ease;
}

/* Kept in layout at every policy so choosing "replace all" reveals the
   acknowledgement without moving the controls below it. */
.supersession-acknowledgement.is-hidden {
    visibility: hidden;
    opacity: 0;
}

.section-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--app-space-12xl);
    align-items: start;
}

.policy-hint {
    min-height: 2lh;
    margin-top: var(--app-space-3xl);
    padding-inline-start: var(--app-space-6xl);
    border-inline-start: 2px solid var(--ui-border);
    font-size: var(--app-text-size-kicker);
    line-height: 1.4;
    color: var(--ui-text-muted);
}

.language-picker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-6xl);
    margin-bottom: var(--app-space-3xl);
}

.language-picker-header .label {
    margin-bottom: 0;
}

.language-search {
    width: 100%;
    max-width: var(--app-settings-select-max-size);
}

/* The scroll region must stay on this element rather than the checkbox group's
   <fieldset>: a scrollable fieldset ignores the wheel everywhere except over a
   chip, so the gaps and padding swallowed it. */
.language-picker-list {
    max-height: var(--app-ocr-language-picker-max-height);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--app-space-3xs);
}

:deep(.language-chip) {
    flex: none;
    width: auto;
    padding: var(--app-space-xs) var(--app-space-8xl);
    border-radius: var(--app-radius-full);
    transition:
        border-color 0.12s ease,
        background-color 0.12s ease;
}

:deep(.language-chip:hover) {
    border-color: color-mix(in oklab, var(--ui-border) 60%, var(--ui-text-muted));
}

:deep(.language-chip:has([data-state="checked"])) {
    border-color: var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 8%, transparent);
}

:deep(.language-chip:has([data-state="checked"]) .language-chip-label) {
    color: var(--ui-primary);
}

:deep(.language-chip-label) {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
    white-space: nowrap;
}

.chip-code {
    padding-inline-start: var(--app-space-sm);
    border-inline-start: var(--app-hairline-height) solid var(--ui-border);
    color: var(--ui-text-dimmed);
    font-size: var(--app-text-size-tiny);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
}

.chip-state {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-3xs);
    font-size: var(--app-text-size-micro);
    color: var(--ui-text-muted);
}

.chip-state.is-error {
    color: var(--ui-error);
}

.chip-spinner {
    color: var(--ui-primary);
}

.language-empty,
.language-accuracy-hint {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.language-empty {
    padding: var(--app-space-6xl);
    text-align: center;
}

.language-accuracy-hint {
    display: flex;
    align-items: flex-start;
    gap: var(--app-space-sm);
    margin-top: var(--app-space-3xl);
}

.ocr-progress-panel {
    padding: var(--app-space-9xl) 0;
}

.progress-text {
    font-size: var(--app-text-size-kicker);
    color: var(--ui-text-muted);
    text-align: center;
}

.ocr-results-panel {
    padding: var(--app-space-9xl) 0;
    text-align: center;
}

.results-icon {
    color: var(--ui-success);
}

.results-icon.is-warning {
    color: var(--ui-warning);
}

.results-text {
    font-size: var(--app-text-size-body);
    color: var(--ui-text);
}

.results-warning {
    display: flex;
    align-items: flex-start;
    gap: var(--app-space-sm);
    color: var(--ui-warning);
    font-size: var(--app-text-size-kicker);
    text-align: left;
}

.results-warning-text {
    overflow-wrap: anywhere;
}

.error {
    display: flex;
    align-items: flex-start;
    gap: var(--app-space-3xl);
    color: var(--ui-error);
    font-size: var(--app-text-size-kicker);
}

.error-content {
    min-width: 0;
    align-items: flex-start;
}

.error-text {
    align-self: stretch;
    overflow-wrap: anywhere;
}

.error-retry-hint {
    color: var(--ui-text-muted);
}

.copy-logs {
    align-self: flex-start;
    width: auto;
    flex: none;
}
</style>
