<template>
    <UModal
        v-model:open="open"
        :title="t('djvu.convertDialog.title')"
        :ui="{ footer: 'justify-end gap-2' }"
    >
        <template #description>
            <span class="sr-only">
                {{ t('djvu.convertDialog.description') }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-4">
                <div class="flex flex-col gap-1">
                    <div class="convert-info-row">
                        <span class="convert-info-label">{{ t('djvu.convertDialog.file') }}</span>
                        <span class="convert-info-value">{{ fileName }}</span>
                    </div>
                    <div class="convert-info-row">
                        <span class="convert-info-label">{{ t('djvu.convertDialog.pages') }}</span>
                        <span class="convert-info-value">{{ pageCountLabel }}</span>
                    </div>
                    <div class="convert-info-row">
                        <span class="convert-info-label">{{ t('djvu.convertDialog.sourceResolution') }}</span>
                        <span class="convert-info-value">{{ sourceResolutionLabel }}</span>
                    </div>
                </div>

                <UAlert
                    v-if="conversionBlockedMessage"
                    color="warning"
                    variant="soft"
                    icon="i-ph-warning-circle"
                    :description="conversionBlockedMessage"
                />

                <div class="convert-presets flex flex-col gap-2">
                    <URadioGroup
                        v-model="selectedPresetValue"
                        :legend="t('djvu.convertDialog.method')"
                        :items="recommendedPresets"
                        value-key="value"
                        variant="card"
                        :ui="recommendedRadioGroupUi"
                    >
                        <template #label="{ item }">
                            <span class="convert-preset-label">
                                {{ item.label }}
                                <UBadge
                                    v-if="item.isRecommended"
                                    size="xs"
                                    color="primary"
                                    variant="subtle"
                                    class="convert-preset-badge"
                                >
                                    {{ t('djvu.convertDialog.recommended') }}
                                </UBadge>
                            </span>
                        </template>
                        <template #description="{ item }">
                            <span class="convert-preset-description">
                                {{ item.description }}
                                <span class="convert-preset-note">
                                    {{ item.note }}
                                </span>
                            </span>
                        </template>
                    </URadioGroup>

                    <UCollapsible
                        v-model:open="advancedRasterOpen"
                        :unmount-on-hide="false"
                        class="convert-advanced flex flex-col"
                    >
                        <template #default="{ open: isAdvancedOpen }">
                            <button
                                type="button"
                                class="convert-advanced-toggle"
                                :aria-expanded="isAdvancedOpen ? 'true' : 'false'"
                            >
                                <UIcon
                                    :name="isAdvancedOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
                                    class="convert-advanced-icon"
                                />
                                <span>{{ t('djvu.convertDialog.advancedRaster') }}</span>
                            </button>
                        </template>

                        <template #content>
                            <div class="convert-advanced-content">
                                <p class="convert-advanced-hint">
                                    {{ t('djvu.convertDialog.advancedRasterHint') }}
                                </p>
                                <URadioGroup
                                    v-model="selectedPresetValue"
                                    :legend="t('djvu.convertDialog.advancedRaster')"
                                    :items="advancedDirectPresets"
                                    value-key="value"
                                    variant="card"
                                    :ui="advancedRadioGroupUi"
                                >
                                    <template #label="{ item }">
                                        <span class="convert-preset-label">
                                            {{ item.label }}
                                            <span
                                                v-if="item.resultingDpi"
                                                class="convert-preset-dpi"
                                            >
                                                {{ item.resultingDpi }} {{ t('common.unitDpi') }}
                                            </span>
                                            <UBadge
                                                v-if="item.isRecommended"
                                                size="xs"
                                                color="neutral"
                                                variant="subtle"
                                                class="convert-preset-badge"
                                            >
                                                {{ t('djvu.convertDialog.recommended') }}
                                            </UBadge>
                                        </span>
                                    </template>
                                    <template #description="{ item }">
                                        <span class="convert-preset-description">
                                            {{ item.description }}
                                            <span v-if="item.disabledReason">
                                                {{ item.disabledReason }}
                                            </span>
                                            <span v-else-if="item.isEstimateLoading">
                                                {{ t('djvu.convertDialog.estimating') }}
                                            </span>
                                            <span v-else-if="(item.estimatedBytes ?? 0) > 0">
                                                ~{{ formatBytes(item.estimatedBytes ?? 0) }}
                                            </span>
                                        </span>
                                    </template>
                                </URadioGroup>
                            </div>
                        </template>
                    </UCollapsible>
                </div>

                <div
                    v-if="info?.hasBookmarks"
                    class="convert-option"
                >
                    <UCheckbox
                        v-model="preserveBookmarks"
                        :label="t('djvu.convertDialog.preserveBookmarks')"
                    />
                </div>
            </div>
        </template>

        <template #footer="{ close }">
            <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="outline"
                @click="close"
            />
            <UButton
                :label="t('common.convert')"
                color="primary"
                :loading="infoLoading"
                :disabled="infoLoading || Boolean(conversionBlockedMessage)"
                @click="handleConvert"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">

import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDjvuPageSize,
    IDjvuSizeEstimate,
} from '@contracts/electronApiDjvu';
import {
    DJVU_PDF_CONVERSION_PRESET_SUBSAMPLES,
    estimateDjvuPdfConversionSource,
    evaluateDjvuPdfConversionPolicy,
    resolveBrowserDjvuConversionPreflight,
} from '@contracts/djvuConversionPolicy';
import {
    DJVU_COMPACT_DJVU_AWARE_PRESET_VALUE,
    DJVU_COMPACT_ARCHIVAL_PRESET_VALUE,
    DJVU_COMPACT_BALANCED_PRESET_VALUE,
    DJVU_COMPACT_SMALL_PRESET_VALUE,
    createDirectDjvuConvertDialogPresetValue,
    resolveDjvuConvertDialogSelection,
    resolveRecommendedAdvancedDirectPresetValue,
    type TDjvuConvertDialogPdfStrategy,
    type TDjvuConvertDialogPresetValue,
} from '@app/modules/djvu-viewer/runtime/djvuConvertDialogPresets';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';
import { isBrowserPlatformActive } from '@app/utils/platform';

const { t } = useTypedI18n();

const { djvuPath } = defineProps<{djvuPath: TDocumentRef | null;}>();

const emit = defineEmits<IDjvuConvertDialogEmits>();

const open = defineModel<boolean>('open', { required: true });

interface IInfo {
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    pageSizes?: readonly IDjvuPageSize[] | null;
}

type TDjvuConvertDialogEmitArgs = [
    subsample: number,
    preserveBookmarks: boolean,
    pdfStrategy: TDjvuConvertDialogPdfStrategy,
];

interface IDjvuConvertDialogEmits {convert: TDjvuConvertDialogEmitArgs;}

interface IResolvedPreset {
    value: TDjvuConvertDialogPresetValue;
    subsample: number;
    pdfStrategy: TDjvuConvertDialogPdfStrategy;
    label: string;
    description: string;
    note?: string;
    resultingDpi?: number;
    estimatedBytes?: number;
    isEstimateLoading?: boolean;
    isRecommended?: boolean;
    disabledReason?: string;
    disabled?: boolean;
}

// Each load replaces the snapshot whole, so its up to 10,000 page sizes need no
// per-object reactive proxies.
const info = shallowRef<IInfo | null>(null);
const infoLoading = ref(false);
const estimates = ref<IDjvuSizeEstimate[]>([]);
const estimatesLoading = ref(false);
const dialogGeneration = ref(0);
const selectedPresetValue = ref<TDjvuConvertDialogPresetValue>(DJVU_COMPACT_BALANCED_PRESET_VALUE);
const preserveBookmarks = ref(true);
const advancedRasterOpen = ref(false);
const recommendedRadioGroupUi = {
    fieldset: 'gap-y-2',
    legend: 'convert-presets-title',
    item: 'cursor-pointer',
    label: 'font-normal',
    description: 'text-xs',
} as const;
const advancedRadioGroupUi = {
    fieldset: 'gap-y-2',
    legend: 'sr-only',
    item: 'cursor-pointer',
    label: 'font-normal',
    description: 'text-xs',
} as const;

const selectedConversion = computed(() => resolveDjvuConvertDialogSelection(selectedPresetValue.value));
const recommendedPresets = computed<IResolvedPreset[]>(() => [
    {
        value: DJVU_COMPACT_SMALL_PRESET_VALUE,
        subsample: 4,
        pdfStrategy: 'compact-djvu-aware',
        label: t('djvu.convertDialog.compact'),
        description: t('djvu.convertDialog.quarterResolution'),
        note: t('djvu.convertDialog.sourceDetailCompactSizeNote'),
    },
    {
        value: DJVU_COMPACT_BALANCED_PRESET_VALUE,
        subsample: 2,
        pdfStrategy: 'compact-djvu-aware',
        label: t('djvu.convertDialog.sourceDetailCompact'),
        description: t('djvu.convertDialog.sourceDetailCompactDescription'),
        note: t('djvu.convertDialog.sourceDetailCompactSizeNote'),
        isRecommended: true,
    },
    {
        value: DJVU_COMPACT_ARCHIVAL_PRESET_VALUE,
        subsample: 1,
        pdfStrategy: 'compact-djvu-aware',
        label: t('djvu.convertDialog.fullQuality'),
        description: t('djvu.convertDialog.original'),
        note: t('djvu.convertDialog.sourceDetailCompactSizeNote'),
    },
]);
const advancedDirectPresets = computed<IResolvedPreset[]>(() => {
    const estimateBySubsample = new Map(estimates.value.map(estimate => [
        estimate.subsample,
        estimate,
    ] as const));
    const conversionSource = resolveConversionSource();
    const recommendedDirectValue = info.value && conversionSource
        ? resolveRecommendedAdvancedDirectPresetValue(info.value.pageCount, conversionSource)
        : null;

    return DJVU_PDF_CONVERSION_PRESET_SUBSAMPLES.map((subsample) => {
        const estimate = estimateBySubsample.get(subsample);
        const policy = conversionSource && evaluateDjvuPdfConversionPolicy(conversionSource, subsample);
        const isBlocked = Boolean(policy && !policy.isAllowed);
        const value = createDirectDjvuConvertDialogPresetValue(subsample);
        const resultingDpi = estimate?.resultingDpi ?? resolveResultingDpi(subsample);
        return {
            value,
            subsample,
            pdfStrategy: 'direct' as const,
            label: estimate?.label ?? resolveEstimateLabel(subsample),
            description:
                estimate?.description ?? resolveEstimateDescription(subsample),
            isEstimateLoading: estimatesLoading.value && !estimate,
            isRecommended: value === recommendedDirectValue,
            ...(resultingDpi === undefined ? {} : { resultingDpi }),
            ...(estimate?.estimatedBytes === undefined ? {} : { estimatedBytes: estimate.estimatedBytes }),
            ...(isBlocked ? { disabledReason: t('djvu.convertDialog.directDisabledReason') } : {}),
            ...((estimatesLoading.value || isBlocked) ? { disabled: true } : {}),
        };
    });
});
const selectedConversionPolicy = computed(() => {
    const conversionSource = selectedConversion.value.pdfStrategy === 'direct' ? resolveConversionSource() : null;
    return conversionSource && evaluateDjvuPdfConversionPolicy(conversionSource, selectedConversion.value.subsample);
});

const browserConversionPreflight = computed(() => {
    if (!isBrowserPlatformActive() || !info.value) {
        return null;
    }

    return resolveBrowserDjvuConversionPreflight(info.value.pageSizes ?? [], info.value.pageCount);
});
const conversionBlockedMessage = computed(() => {
    const preflight = browserConversionPreflight.value;
    if (!preflight || preflight.allowed) {
        return null;
    }

    return preflight.reason === 'page-count'
        ? t('djvu.convertDialog.browserPageLimit', {
            pages: preflight.pageCount.toLocaleString(),
            maxPages: preflight.maxPages.toLocaleString(),
        })
        : t('djvu.convertDialog.browserPixelLimit');
});

const fileName = computed(() => getDocumentRefBaseName(djvuPath) ?? '');
const pageCountLabel = computed(() => info.value?.pageCount.toLocaleString() ?? t('common.loading'));
const sourceResolutionLabel = computed(() => (
    info.value
        ? `${info.value.sourceDpi} ${t('common.unitDpi')}`
        : t('common.loading')
));

function formatBytes(bytes: number) {
    if (bytes < 1024) {
        return `${bytes} ${t('common.unitByte')}`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} ${t('common.unitKilobyte')}`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} ${t('common.unitMegabyte')}`;
}

function resolveEstimateLabel(subsample: number) {
    switch (subsample) {
        case 1:
            return t('djvu.convertDialog.fullQuality');
        case 2:
            return t('djvu.convertDialog.goodQuality');
        default:
            return t('djvu.convertDialog.compact');
    }
}

function resolveEstimateDescription(subsample: number) {
    switch (subsample) {
        case 1:
            return t('djvu.convertDialog.original');
        case 2:
            return t('djvu.convertDialog.halfResolution');
        default:
            return t('djvu.convertDialog.quarterResolution');
    }
}

function resolveResultingDpi(subsample: number) {
    if (!info.value) {
        return undefined;
    }

    return Math.round(info.value.sourceDpi / subsample);
}

function resolveConversionSource() {
    if (!info.value) {
        return null;
    }

    return estimateDjvuPdfConversionSource({
        pageCount: info.value.pageCount,
        sourceDpi: info.value.sourceDpi,
        ...(info.value.pageSizes === undefined ? {} : { pageSizes: info.value.pageSizes }),
    });
}

watch(() => selectedConversion.value.pdfStrategy, (pdfStrategy) => {
    if (pdfStrategy === 'direct') {
        advancedRasterOpen.value = true;
    }
});

watch([
    open,
    () => djvuPath,
], async ([isOpen]) => {
    dialogGeneration.value += 1;
    if (!isOpen || !djvuPath) {
        // A closed dialog or a missing source must not keep stale info and
        // estimates that would leave Convert enabled for a source that is gone.
        info.value = null;
        estimates.value = [];
        estimatesLoading.value = false;
        infoLoading.value = false;
        return;
    }

    const generation = dialogGeneration.value;
    const requestPath = djvuPath;

    selectedPresetValue.value = DJVU_COMPACT_BALANCED_PRESET_VALUE;
    advancedRasterOpen.value = false;
    preserveBookmarks.value = true;
    info.value = null;
    estimates.value = [];
    estimatesLoading.value = false;
    infoLoading.value = true;

    try {
        const djvu = getDjvuCapability();
        const djvuInfo = await djvu.getInfo(requestPath);
        if (generation !== dialogGeneration.value) {
            return;
        }
        info.value = {
            ...djvuInfo,
            pageSizes: null,
        };

        const pageSizes = await djvu.getPageSizes(requestPath).catch((pageSizeError: unknown) => {
            BrowserLogger.warn('djvu-convert-dialog', 'Failed to load DjVu page sizes for conversion policy', {
                path: requestPath,
                error: pageSizeError,
            });
            return null;
        });
        if (generation !== dialogGeneration.value) {
            return;
        }
        info.value = {
            ...djvuInfo,
            pageSizes,
        };
    } catch (error) {
        if (generation !== dialogGeneration.value) {
            return;
        }
        BrowserLogger.warn('djvu-convert-dialog', 'Failed to load DjVu conversion info', {
            path: requestPath,
            error,
        });
    } finally {
        if (generation === dialogGeneration.value) {
            infoLoading.value = false;
        }
    }
});

watch(advancedRasterOpen, async (isAdvancedOpen) => {
    if (!isAdvancedOpen || !open.value || !djvuPath) {
        return;
    }
    if (estimatesLoading.value || estimates.value.length > 0) {
        return;
    }

    const generation = dialogGeneration.value;
    const requestPath = djvuPath;
    estimatesLoading.value = true;

    try {
        const sizeEstimates = await getDjvuCapability().estimateSizes(requestPath);
        if (generation !== dialogGeneration.value) {
            return;
        }
        estimates.value = sizeEstimates;
    } catch (error) {
        if (generation !== dialogGeneration.value) {
            return;
        }
        BrowserLogger.warn('djvu-convert-dialog', 'Failed to load DjVu conversion estimates', {
            path: requestPath,
            error,
        });
    } finally {
        if (generation === dialogGeneration.value) {
            estimatesLoading.value = false;
        }
    }
});

function handleConvert() {
    if (infoLoading.value || conversionBlockedMessage.value) {
        return;
    }
    const policy = selectedConversionPolicy.value;
    if (policy && !policy.isAllowed) {
        selectedPresetValue.value = DJVU_COMPACT_DJVU_AWARE_PRESET_VALUE;
    }
    const selection = resolveDjvuConvertDialogSelection(selectedPresetValue.value);
    open.value = false;
    emit('convert', selection.subsample, preserveBookmarks.value, selection.pdfStrategy);
}
</script>

<style lang="scss" scoped>
.convert-info-row {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    align-items: start;
    gap: var(--app-space-3xl);
    font-size: var(--app-text-size-body-sm);
}

.convert-info-label {
    min-width: 0;
    color: var(--ui-text-muted);
}

.convert-info-value {
    min-width: 0;
    color: var(--ui-text);
    font-weight: var(--app-font-weight-medium);
    overflow-wrap: anywhere;
}

:deep(.convert-presets-title) {
    font-size: var(--app-text-size-body-sm);
    font-weight: var(--app-font-weight-semibold);
    color: var(--ui-text);
}

.convert-preset-label {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: var(--app-space-lg);
    font-size: var(--app-text-size-body-sm);
    font-weight: var(--app-font-weight-medium);
    color: var(--ui-text);
}

.convert-preset-dpi {
    color: var(--ui-text-muted);
    font-weight: normal;
    font-size: var(--app-text-size-kicker);
}

.convert-preset-badge {
    flex-shrink: 0;
}

.convert-preset-description {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-2xs);
    font-size: var(--app-text-size-kicker);
    color: var(--ui-text-muted);
    margin-top: var(--app-space-3xs);
}

.convert-preset-note {
    color: var(--ui-text-dimmed);
}

.convert-advanced {
    padding-top: var(--app-space-md);
}

.convert-advanced-toggle {
    display: flex;
    align-items: center;
    gap: var(--app-space-lg);
    border: none;
    background: transparent;
    padding: var(--app-space-sm) 0;
    color: var(--ui-text);
    cursor: pointer;
    font-size: var(--app-text-size-body-sm);
    font-weight: var(--app-font-weight-medium);
}

.convert-advanced-icon {
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    flex-shrink: 0;
    color: var(--ui-text-dimmed);
}

.convert-advanced-content {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-lg);
    padding-top: var(--app-space-sm);
}

.convert-advanced-hint {
    margin: 0;
    font-size: var(--app-text-size-kicker);
    color: var(--ui-text-muted);
}

.convert-option {
    padding-top: var(--app-space-sm);
}
</style>
