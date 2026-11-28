<template>
    <div
        class="scan-cleanup-settings-content"
        :data-settings-tab-panel="tab"
    >
        <header class="scan-cleanup-settings-header">
            <ScanCleanupSegmented
                class="scan-cleanup-settings-tabs"
                :model-value="tab"
                :items="tabItems"
                :group-label="t('scanCleanup.settings.title')"
                @update:model-value="selectTab"
            />
        </header>

        <div class="scan-cleanup-settings-scroll app-scrollbar app-scroll-region--balanced">
            <ScanCleanupPageFindings
                v-if="!documentTab && pageFacts"
                part="hints"
                :facts="pageFacts"
                :page-number="pageNumber"
            />

            <section
                v-if="documentTab || !lossless"
                class="scan-cleanup-option-group"
                data-settings-group="output"
            >
                <h3>{{ t('scanCleanup.output.label') }}</h3>
                <template v-if="documentTab">
                    <USelect
                        :model-value="documentOutputModelValue"
                        :items="documentOutputItems"
                        value-key="value"
                        class="w-full"
                        data-document-output
                        :aria-label="t('scanCleanup.output.label')"
                        @update:model-value="emit('update-document-output', $event)"
                    />
                    <p
                        class="scan-cleanup-option-description"
                        data-output-description
                        >{{ outputDescription }}</p
                    >
                    <div
                        v-if="!lossless"
                        class="scan-cleanup-footnote"
                        data-rasterization-notice
                    >
                        <span>{{ t('scanCleanup.imageOnly') }}</span>
                        <UPopover>
                            <UButton
                                type="button"
                                class="scan-cleanup-details-trigger"
                                color="primary"
                                variant="link"
                                size="xs"
                                icon="i-ph-info"
                                :label="t('scanCleanup.details')"
                            />
                            <template #content>
                                <div class="scan-cleanup-details-popover">
                                    <p>{{ t('scanCleanup.rasterNotice') }}</p>
                                    <p>{{ t('scanCleanup.lossNotice') }}</p>
                                </div>
                            </template>
                        </UPopover>
                    </div>
                    <UFormField
                        v-if="bilevelOutput"
                        :label="t('scanCleanup.thickness.label', {value: thicknessLabel})"
                    >
                        <USlider
                            color="primary"
                            :min="-5"
                            :max="5"
                            :step="1"
                            :model-value="settings.thickness"
                            :aria-label="t('scanCleanup.thickness.control')"
                            @update:model-value="emit('thickness-input', $event ?? settings.thickness)"
                        />
                    </UFormField>
                </template>
                <div
                    v-else
                    class="scan-cleanup-selection-field"
                >
                    <ScanCleanupSettingLabel
                        control="output-mode"
                        :label="t('scanCleanup.output.pageLabel')"
                        :mixed="outputModeOverride.mixed"
                        :overridden="overrideCounts.outputMode > 0"
                        @reset="emit('reset-control-override', 'output-mode')"
                    />
                    <USelect
                        :model-value="outputModeOverrideModelValue"
                        :items="outputModeOverrideItems"
                        value-key="value"
                        class="w-full"
                        data-page-output
                        :aria-label="t('scanCleanup.output.pageLabel')"
                        @update:model-value="emit('update-output-mode', $event)"
                    />
                </div>
            </section>

            <section
                class="scan-cleanup-option-group"
                data-settings-group="layout"
            >
                <h3>{{ t('scanCleanup.groups.layout') }}</h3>
                <div class="scan-cleanup-selection-field">
                    <ScanCleanupSettingLabel
                        control="layout"
                        :label="t('scanCleanup.layout.label')"
                        :mixed="layout.mixed"
                        :overridden="overrideCounts.layout > 0"
                        @reset="emit('reset-control-override', 'layout')"
                    />
                    <USelect
                        :model-value="layoutModelValue"
                        :items="layoutItems"
                        value-key="value"
                        class="w-full"
                        :aria-label="t('scanCleanup.layout.label')"
                        @update:model-value="emit('update-layout', $event)"
                    />
                </div>

                <div class="scan-cleanup-selection-field">
                    <ScanCleanupSettingLabel
                        control="rotation"
                        :label="t('scanCleanup.settings.rotation')"
                        :mixed="rotation.mixed"
                        :overridden="overrideCounts.rotation > 0"
                        @reset="emit('reset-control-override', 'rotation')"
                    />
                    <ScanCleanupSegmented
                        :model-value="rotationModelValue"
                        :items="rotationSegments"
                        :group-label="t('scanCleanup.settings.rotation')"
                        @update:model-value="emit('update-rotation', $event)"
                    />
                </div>

                <div
                    v-if="documentTab && showReadingOrder"
                    class="scan-cleanup-selection-field"
                >
                    <ScanCleanupSettingLabel :label="t('scanCleanup.layout.readingOrder')" />
                    <ScanCleanupSegmented
                        :model-value="settings.readingOrder"
                        :items="readingOrderItems"
                        :group-label="t('scanCleanup.layout.readingOrder')"
                        @update:model-value="updateDocument('readingOrder', $event)"
                    />
                </div>

                <div
                    v-if="documentTab && !lossless"
                    class="scan-cleanup-inline-row"
                >
                    <UCheckbox
                        :model-value="settings.skipBlankPages"
                        :label="t('scanCleanup.crop.skipBlank')"
                        @update:model-value="updateDocument('skipBlankPages', $event === true)"
                    />
                    <span
                        v-if="blankPageCount > 0"
                        class="scan-cleanup-inline-note"
                        >{{ t('scanCleanup.crop.blankDetected', {count: blankPageCount}) }}</span
                    >
                </div>

                <ScanCleanupAutoValueRow
                    v-if="!documentTab && !lossless"
                    :label="manualSkewLabel"
                    :state="manualSkewState"
                    :value-text="manualSkewValueText"
                    @reset="emit('reset-manual-skew')"
                >
                    <template #entry>
                        <UInputNumber
                            class="scan-cleanup-manual-skew-input"
                            :model-value="manualSkewEntryValue"
                            :min="SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES"
                            :max="SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES"
                            :step="0.1"
                            :increment-disabled="manualSkew.mixed"
                            :decrement-disabled="manualSkew.mixed"
                            :aria-label="`${manualSkewLabel} (${manualSkewRange})`"
                            @update:model-value="emitManualSkew"
                        />
                    </template>
                </ScanCleanupAutoValueRow>
            </section>

            <section
                class="scan-cleanup-option-group"
                data-settings-group="crop-and-size"
            >
                <h3>{{ t('scanCleanup.groups.cropAndSize') }}</h3>
                <UCheckbox
                    v-if="documentTab"
                    :model-value="settings.crop"
                    :label="t('scanCleanup.crop.label')"
                    @update:model-value="updateDocument('crop', $event === true)"
                />

                <div
                    class="scan-cleanup-margins-control"
                    @focusin="emit('margin-interaction', true)"
                    @focusout="handleMarginFocusOut"
                >
                    <ScanCleanupSettingLabel
                        control="margins"
                        :label="t('scanCleanup.margins.title')"
                        :mixed="margins.mixed"
                        :overridden="overrideCounts.margins > 0"
                        @reset="emit('reset-control-override', 'margins')"
                    >
                        <AppTooltip
                            :text="t('scanCleanup.margins.linkTooltip')"
                            usefulness="always"
                        >
                            <UButton
                                type="button"
                                data-margins-link
                                :color="marginsLinked ? 'primary' : 'neutral'"
                                variant="ghost"
                                size="xs"
                                square
                                :icon="marginsLinked ? 'i-ph-link-simple' : 'i-ph-link-simple-break'"
                                role="switch"
                                :aria-checked="marginsLinked"
                                :aria-label="t('scanCleanup.margins.link')"
                                @click="emit('update:margins-linked', !marginsLinked)"
                            />
                        </AppTooltip>
                    </ScanCleanupSettingLabel>
                    <UInputNumber
                        v-if="marginsLinked"
                        data-margin-side="all"
                        :model-value="linkedMarginValue"
                        :min="0"
                        :max="SCAN_CLEANUP_MARGIN_MAX_MM"
                        :step="1"
                        :aria-label="t('scanCleanup.margins.all')"
                        @change="handleMarginChange('all', $event)"
                        @update:model-value="emitMargin('all', $event)"
                    />
                    <div
                        v-else
                        class="scan-cleanup-margins-grid"
                    >
                        <UFormField
                            v-for="side in marginSideFields"
                            :key="side.key"
                            :label="side.label"
                        >
                            <UInputNumber
                                :model-value="side.value"
                                :data-margin-side="side.key"
                                :min="0"
                                :max="SCAN_CLEANUP_MARGIN_MAX_MM"
                                :step="1"
                                @change="handleMarginChange(side.key, $event)"
                                @update:model-value="emitMargin(side.key, $event)"
                            />
                        </UFormField>
                    </div>
                </div>

                <UCheckbox
                    v-if="documentTab"
                    :model-value="settings.matchPageSize"
                    :label="t('scanCleanup.pageSize.match')"
                    v-bind="lossless && settings.matchPageSize ? {description: t('scanCleanup.pageSize.matchLosslessNote')} : {}"
                    @update:model-value="updateDocument('matchPageSize', $event === true)"
                />

                <div
                    v-if="settings.matchPageSize"
                    class="scan-cleanup-selection-field"
                >
                    <ScanCleanupSettingLabel
                        control="placement"
                        :label="t('scanCleanup.settings.contentPlacement')"
                        :mixed="placementAlignment.mixed"
                        :overridden="overrideCounts.placement > 0"
                        @reset="emit('reset-control-override', 'placement')"
                    />
                    <div
                        class="scan-cleanup-alignment-grid"
                        role="radiogroup"
                        :aria-label="t('scanCleanup.settings.contentPlacement')"
                    >
                        <UButton
                            v-for="item in alignmentButtons"
                            :key="item.value"
                            :class="item.isInk ? 'scan-cleanup-alignment-ink' : undefined"
                            :aria-label="item.label"
                            :aria-checked="item.selected"
                            :color="item.selected ? 'primary' : 'neutral'"
                            :variant="item.selected ? 'soft' : 'outline'"
                            role="radio"
                            size="xs"
                            :icon="item.icon"
                            v-bind="item.labelProps"
                            @click="emit('update-placement', item.value)"
                        />
                    </div>
                    <p
                        v-if="placementHint"
                        class="scan-cleanup-option-description"
                        >{{ placementHint }}</p
                    >
                </div>

                <UCheckbox
                    v-if="!documentTab"
                    :model-value="inclusionModelValue"
                    :label="t('scanCleanup.pages.includeInOutput')"
                    data-page-inclusion
                    @update:model-value="emit('update-inclusion', $event === true ? 'included' : 'excluded')"
                />
            </section>

            <section
                v-if="hasManualRows"
                class="scan-cleanup-option-group"
                data-settings-group="manual"
            >
                <ScanCleanupAutoValueRow
                    v-if="manualSplitState !== 'auto'"
                    :label="t('scanCleanup.settings.manualSplit')"
                    :state="manualSplitState"
                    @reset="emit('reset-manual-split')"
                />
                <ScanCleanupAutoValueRow
                    v-if="contentBoxesState !== 'auto'"
                    :label="t('scanCleanup.settings.contentBox')"
                    :state="contentBoxesState"
                    @reset="emit('reset-content-boxes')"
                />
                <ScanCleanupAutoValueRow
                    v-if="documentManualSkewShown"
                    :label="manualSkewLabel"
                    :state="manualSkewState"
                    :value-text="manualSkewValueText"
                    @reset="emit('reset-manual-skew')"
                />
            </section>

            <div
                v-if="footerShown"
                class="scan-cleanup-settings-footer"
                :data-settings-footer="tab"
            >
                <template v-if="documentTab">
                    <UCollapsible
                        v-if="!lossless"
                        v-model:open="advancedOpen"
                        :unmount-on-hide="false"
                        class="scan-cleanup-advanced"
                    >
                        <template #default="{open: isAdvancedOpen}">
                            <button
                                type="button"
                                class="scan-cleanup-advanced-toggle"
                                :aria-expanded="isAdvancedOpen ? 'true' : 'false'"
                            >
                                <UIcon
                                    :name="isAdvancedOpen ? 'i-ph-caret-down' : 'i-ph-caret-right'"
                                    class="scan-cleanup-advanced-icon"
                                    aria-hidden="true"
                                />
                                <span>{{ t('scanCleanup.advanced.title') }}</span>
                            </button>
                        </template>
                        <template #content>
                            <div class="scan-cleanup-advanced-content">
                                <UFormField :label="t('scanCleanup.advanced.binarization.label')">
                                    <USelect
                                        :model-value="binarizationModelValue"
                                        :items="binarizationItems"
                                        value-key="value"
                                        class="w-full"
                                        @update:model-value="updateDocument('binarization', $event)"
                                    />
                                </UFormField>
                                <UFormField
                                    v-if="bilevelOutput"
                                    :label="t('scanCleanup.advanced.despeckle.label')"
                                >
                                    <USelect
                                        :model-value="despeckleLevelModelValue"
                                        :items="despeckleItems"
                                        value-key="value"
                                        class="w-full"
                                        @update:model-value="updateDocument('despeckleLevel', $event)"
                                    />
                                </UFormField>
                                <UCheckbox
                                    :model-value="normalizeIlluminationModelValue"
                                    :label="t('scanCleanup.advanced.normalizeIllumination')"
                                    @update:model-value="updateDocument('normalizeIllumination', $event === true)"
                                />
                                <UCheckbox
                                    :model-value="autoDewarpModelValue"
                                    :label="t('scanCleanup.advanced.autoDewarp')"
                                    @update:model-value="updateDocument('autoDewarp', $event === true)"
                                />
                                <ScanCleanupAutoValueRow
                                    v-if="autoDewarpModelValue"
                                    :label="t('scanCleanup.advanced.autoDewarpDepth')"
                                    :state="autoDewarpDepthState"
                                    @reset="updateDocument('autoDewarpDepth', undefined)"
                                >
                                    <template #entry>
                                        <UInputNumber
                                            :model-value="autoDewarpDepthModelValue"
                                            :min="SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN"
                                            :max="SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX"
                                            :step="0.1"
                                            :placeholder="t('scanCleanup.advanced.autoDewarpDepthAutomatic')"
                                            :aria-label="t('scanCleanup.advanced.autoDewarpDepth')"
                                            @update:model-value="emitAutoDewarpDepth"
                                        />
                                    </template>
                                </ScanCleanupAutoValueRow>
                            </div>
                        </template>
                    </UCollapsible>

                    <UPopover
                        v-if="documentResettable"
                        v-model:open="resetOpen"
                        portal
                        :content="{side: 'top', align: 'center'}"
                    >
                        <UButton
                            type="button"
                            class="scan-cleanup-footer-action"
                            data-reset-document
                            color="neutral"
                            variant="outline"
                            size="sm"
                            icon="i-ph-arrow-u-up-left"
                            :label="t('scanCleanup.settingsBadges.reset')"
                        />
                        <template #content>
                            <div class="scan-cleanup-reset-confirmation">
                                <strong>{{ t('scanCleanup.settings.resetDocument.confirm') }}</strong>
                                <span>{{ t('scanCleanup.settings.resetDocument.body') }}</span>
                                <span v-if="changedSettings.length > 0">{{ changedSettingsSummary }}</span>
                                <div class="scan-cleanup-reset-actions">
                                    <UButton
                                        type="button"
                                        color="neutral"
                                        variant="ghost"
                                        size="sm"
                                        :label="t('common.cancel')"
                                        @click="resetOpen = false"
                                    />
                                    <UButton
                                        type="button"
                                        color="primary"
                                        size="sm"
                                        data-reset-document-confirm
                                        :label="t('scanCleanup.pages.resetAction')"
                                        @click="confirmDocumentReset"
                                    />
                                </div>
                            </div>
                        </template>
                    </UPopover>
                </template>

                <template v-else>
                    <UDropdownMenu
                        :items="applyScopeItems"
                        :content="{side: 'bottom', align: 'end'}"
                    >
                        <UButton
                            type="button"
                            class="scan-cleanup-footer-action"
                            data-copy-page-settings
                            color="neutral"
                            variant="outline"
                            size="sm"
                            :label="t('scanCleanup.settings.applyThisPageTo')"
                            trailing-icon="i-ph-caret-down"
                        />
                    </UDropdownMenu>
                    <AppTooltip
                        :text="selectionRunDisabledReason"
                        :disabled="selectionRunDisabledReason === ''"
                        usefulness="always"
                    >
                        <UButton
                            type="button"
                            class="scan-cleanup-footer-action"
                            data-run-selection
                            color="primary"
                            variant="soft"
                            size="sm"
                            icon="i-ph-play"
                            :label="selectionRunLabel"
                            :disabled="!canRunSelection"
                            @click="emit('run-selection')"
                        />
                    </AppTooltip>
                    <UButton
                        v-if="hasPageOverrides"
                        type="button"
                        class="scan-cleanup-footer-action"
                        data-reset-pages
                        color="neutral"
                        variant="ghost"
                        size="sm"
                        icon="i-ph-arrow-u-up-left"
                        :label="pageResetLabel"
                        @click="emit('reset-page-overrides')"
                    />
                    <ScanCleanupPageFindings
                        v-if="pageFacts"
                        part="details"
                        :facts="pageFacts"
                        :page-number="pageNumber"
                    />
                </template>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type {
    IScanCleanupMarginsMm,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupOptions,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupPageAlignment,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN,
    SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES,
    SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES,
    SCAN_CLEANUP_MARGIN_MAX_MM,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE, getScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {requirePageNumber} from '@contracts/pageNumbers';
import ScanCleanupAutoValueRow from '@app/modules/scan-cleanup/components/settings/ScanCleanupAutoValueRow.vue';
import ScanCleanupPageFindings from '@app/modules/scan-cleanup/components/settings/ScanCleanupPageFindings.vue';
import ScanCleanupSettingLabel from '@app/modules/scan-cleanup/components/settings/ScanCleanupSettingLabel.vue';
import ScanCleanupSegmented from '@app/modules/scan-cleanup/components/ScanCleanupSegmented.vue';
import type {TScanCleanupOverrideControl, TScanCleanupSettingsTab} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import type {IScanCleanupPageFacts} from '@app/modules/scan-cleanup/runtime/describeScanCleanupPage';
import type {IScanCleanupMixedValue} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import type {TScanCleanupMarginTarget} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';
import {SCAN_CLEANUP_MARGIN_SIDES, scanCleanupMarginsUniform} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';

interface ISelectItem<TValue extends string = string> {
    value: TValue;
    label: string;
    disabled?: boolean;
}

interface IScanCleanupOverrideCounts {
    inclusion: number;
    layout: number;
    margins: number;
    outputMode: number;
    placement: number;
    rotation: number;
}

const {
    alignmentItems,
    applyScopeItems,
    blankPageCount,
    canRunSelection,
    changedSettings,
    contentBoxes,
    detectedSkewDegrees,
    excluded,
    hasDocumentOverrides,
    hasPageOverrides,
    layout,
    layoutItems,
    manualSplit,
    manualSkew,
    margins,
    marginsLinked,
    outputItems,
    outputModeOverride,
    outputModeOverrideItems,
    overrideCounts,
    pageFacts,
    pageNumber,
    placementAlignment,
    readingOrderItems,
    rotation,
    rotationItems,
    selectedCount,
    selectionRunDisabledReason,
    selectionRunLabel,
    settings,
    showReadingOrder,
    tab,
    thicknessLabel,
    totalPages,
} = defineProps<{
    alignmentItems: Array<{
        value: TScanCleanupPageAlignment;
        icon: string;
        label: string;
    }>;
    applyScopeItems: Array<
        | {
              label: string;
              type: 'label';
          }
        | {
              label: string;
              onSelect: () => void;
          }
    >;
    blankPageCount: number;
    /** Whether the Pages tab's pages can be cleaned up on their own now. */
    canRunSelection: boolean;
    /** Labels of the settings that differ from the defaults. */
    changedSettings: readonly string[];
    contentBoxes: IScanCleanupMixedValue<Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>>;
    /** The angle detection found for the page on screen, on the Pages tab with one page. */
    detectedSkewDegrees: number | undefined;
    excluded: IScanCleanupMixedValue<boolean>;
    /** Any page has its own settings, or the values every page inherits differ from the built-in ones. */
    hasDocumentOverrides: boolean;
    /** One of the Pages tab's pages has its own settings. */
    hasPageOverrides: boolean;
    layout: IScanCleanupMixedValue<IScanCleanupOptions['layoutMode'] | TScanCleanupPageLayoutOverride>;
    layoutItems: ISelectItem[];
    manualSplit: IScanCleanupMixedValue<IScanCleanupNormalizedSplit | null>;
    manualSkew: IScanCleanupMixedValue<number | undefined>;
    margins: IScanCleanupMixedValue<IScanCleanupMarginsMm>;
    marginsLinked: boolean;
    outputItems: Array<ISelectItem<IScanCleanupOptions['outputMode']> & {fullLabel: string}>;
    outputModeOverride: IScanCleanupMixedValue<TScanCleanupOutputMode | undefined>;
    outputModeOverrideItems: ISelectItem[];
    overrideCounts: IScanCleanupOverrideCounts;
    /** What is known about the page on the Pages tab with one page, for its findings. */
    pageFacts: IScanCleanupPageFacts | null;
    pageNumber: number;
    placementAlignment: IScanCleanupMixedValue<TScanCleanupPageAlignment>;
    readingOrderItems: Array<ISelectItem<IScanCleanupOptions['readingOrder']>>;
    rotation: IScanCleanupMixedValue<TScanCleanupPageRotation>;
    rotationItems: ISelectItem[];
    selectedCount: number;
    selectionRunDisabledReason: string;
    selectionRunLabel: string;
    settings: IScanCleanupOptions;
    /** Reading order only matters once some page is cut into two. */
    showReadingOrder: boolean;
    tab: TScanCleanupSettingsTab;
    thicknessLabel: string;
    totalPages: number;
}>();
const emit = defineEmits<{
    'margin-interaction': [active: boolean];
    'reset-control-override': [control: TScanCleanupOverrideControl];
    'reset-content-boxes': [];
    'reset-manual-split': [];
    'reset-manual-skew': [];
    'reset-page-overrides': [];
    'reset-settings': [];
    'run-selection': [];
    'thickness-input': [value: number | number[]];
    'update-document-output': [value: string | number];
    'update-inclusion': [value: string | number];
    'update-layout': [value: string | number];
    'update-margin': [target: TScanCleanupMarginTarget, value: number];
    'update-manual-skew': [value: number | undefined];
    'update-output-mode': [value: string | number];
    'update:margins-linked': [value: boolean];
    'update-placement': [value: TScanCleanupPageAlignment];
    'update-rotation': [value: string | number];
    'update-setting': [key: keyof IScanCleanupOptions, value: IScanCleanupOptions[keyof IScanCleanupOptions]];
    'update:tab': [value: TScanCleanupSettingsTab];
}>();
const {t} = useTypedI18n();
const resetOpen = ref(false);
const advancedOpen = ref(false);
const lossless = computed(() => settings.preserveOriginalQuality === true);
const documentTab = computed(() => tab === 'document');
const tabItems = computed(() => [
    {
        value: 'document',
        label: t('scanCleanup.settings.tabs.document'),
        attrs: {'data-settings-tab': 'document'},
    },
    {
        value: 'pages',
        label:
            selectedCount >= 2
                ? t('scanCleanup.settings.tabs.pages', {count: selectedCount})
                : t('scanCleanup.settings.tabs.page', {page: pageNumber}),
        attrs: {'data-settings-tab': 'pages'},
    },
]);
const changedSettingsSummary = computed(() => t('scanCleanup.settings.changedFromDefaults', {settings: changedSettings.join(', ')}));
// Original images is a fifth output, stored as `preserveOriginalQuality`
// beside the raster mode it leaves untouched for when it is turned off.
const documentOutputItems = computed(() => [
    ...outputItems.map((item) => ({
        value: item.value,
        label: item.fullLabel,
    })),
    {
        value: 'original' as const,
        label: t('scanCleanup.output.preserveOriginalQuality'),
    },
]);
const documentOutputModelValue = computed(() => (lossless.value ? 'original' : settings.outputMode));
const pageResetLabel = computed(() =>
    selectedCount >= 2 ? t('scanCleanup.settings.resetPages', {count: selectedCount}) : t('scanCleanup.settings.resetPage'),
);
const alignmentButtons = computed(() =>
    alignmentItems.map((item) => {
        const isInk = item.value === 'ink';
        return {
            ...item,
            isInk,
            labelProps: isInk ? {label: item.label} : {},
            selected: !placementAlignment.mixed && placementAlignment.value === item.value,
        };
    }),
);
const marginSideFields = computed(() =>
    SCAN_CLEANUP_MARGIN_SIDES.map((side) => ({
        key: side.key,
        label: t(side.labelKey),
        value: margins.mixed ? null : (margins.value?.[side.key] ?? null),
    })),
);
const inclusionModelValue = computed(() => (excluded.mixed ? 'indeterminate' : excluded.value !== true));
const binarizationModelValue = computed(() => settings.binarization ?? 'auto');
const despeckleLevelModelValue = computed(() => settings.despeckleLevel ?? ((settings.despeckle ?? true) ? 'normal' : 'off'));
const normalizeIlluminationModelValue = computed(() => settings.normalizeIllumination ?? true);
const autoDewarpModelValue = computed(() => settings.autoDewarp ?? false);
const autoDewarpDepthModelValue = computed(() => settings.autoDewarpDepth ?? null);
const outputDescription = computed(() =>
    lossless.value ? t('scanCleanup.output.losslessDisabledOptions') : t(`scanCleanup.output.description.${settings.outputMode}`),
);
// Automatic dewarping replaces the detected content boxes with a reshaped
// page, so `ink` has nothing to anchor to and every output falls back to the
// top-centre position. Say so where the choice is made rather than letting the
// preview quietly disagree with the setting.
const placementHint = computed(() =>
    !placementAlignment.mixed && placementAlignment.value === 'ink' && settings.autoDewarp === true
        ? t('scanCleanup.settings.inkNeedsContentBoxes')
        : '',
);
const binarizationItems = computed(() =>
    (['auto', 'otsu', 'sauvola', 'wolf'] as const).map((value) => ({
        value,
        label: t(`scanCleanup.advanced.binarization.${value}`),
    })),
);
const despeckleItems = computed(() =>
    (['off', 'cautious', 'normal', 'aggressive'] as const).map((value) => ({
        value,
        label: t(`scanCleanup.advanced.despeckle.${value}`),
    })),
);

const layoutModelValue = computed(() => (layout.mixed ? 'mixed' : (layout.value ?? 'auto')));
const rotationModelValue = computed(() => (rotation.mixed ? '' : String(rotation.value ?? 0)));
const rotationSegments = computed(() => rotationItems.filter((item) => item.value !== 'mixed'));
const outputModeOverrideModelValue = computed(() => (outputModeOverride.mixed ? 'mixed-values' : (outputModeOverride.value ?? 'auto')));
const linkedMarginValue = computed(() =>
    margins.mixed || !margins.value || !scanCleanupMarginsUniform(margins.value) ? null : margins.value.topMm,
);
const hasContentBoxes = computed(() => contentBoxes.mixed || Object.keys(contentBoxes.value ?? {}).length > 0);
const manualSkewState = computed(() => (manualSkew.mixed ? 'mixed' : manualSkew.value === undefined ? 'auto' : 'manual'));
const manualSkewLabel = computed(() => t('scanCleanup.settings.manualSkew'));
const manualSkewRange = computed(() =>
    t('scanCleanup.settings.manualSkewRange', {
        min: SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES,
        max: SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES,
    }),
);
// An automatic page starts the stepper from the angle detection found, so a
// nudge corrects that angle; otherwise from the neutral 0°, because a null
// number field steps to its minimum. Showing a value emits nothing: only an
// edit or a step writes an override, and a mixed selection stays empty.
const manualSkewEntryValue = computed(() => {
    if (manualSkew.mixed) {
        return null;
    }
    if (manualSkew.value !== undefined) {
        return manualSkew.value;
    }
    return selectedCount < 2 && detectedSkewDegrees !== undefined ? Number(detectedSkewDegrees.toFixed(1)) : 0;
});
const manualSkewValueText = computed(() => {
    const value = manualSkew.value;
    if (manualSkew.mixed || value === undefined) {
        return undefined;
    }
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}°`;
});
const manualSplitState = computed(() => (manualSplit.mixed ? 'mixed' : manualSplit.value === null ? 'auto' : 'manual'));
const contentBoxesState = computed(() => (contentBoxes.mixed ? 'mixed' : hasContentBoxes.value ? 'manual' : 'auto'));
// The Document tab has no deskew entry: it only lists pages straightened by
// hand, so they can return to automatic in one place.
const documentManualSkewShown = computed(() => documentTab.value && !lossless.value && manualSkewState.value !== 'auto');
const hasManualRows = computed(
    () => manualSplitState.value !== 'auto' || contentBoxesState.value !== 'auto' || documentManualSkewShown.value,
);
// Text thickness and speckle removal only affect black-and-white output, which
// Auto produces for text pages, so they show while any page that is output can
// be black and white, whether by the document's mode or its own.
const bilevelOutput = computed(() => {
    if (lossless.value) {
        return false;
    }
    const overridePages = new Set(
        Object.keys(settings.pageOverrides)
            .map(Number)
            .filter((page) => Number.isSafeInteger(page) && page >= 1 && page <= totalPages),
    );
    return [
        ...(overridePages.size < totalPages ? [settings.pageOverrideDefaults ?? DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE] : []),
        ...[...overridePages].map((page) =>
            getScanCleanupPageOverride(settings.pageOverrides, requirePageNumber(page), settings.pageOverrideDefaults, settings.marginsMm),
        ),
    ].some((override) => !override.excluded && ['auto', 'bw', 'mixed'].includes(override.outputModeOverride ?? settings.outputMode));
});
const documentResettable = computed(() => changedSettings.length > 0 || hasDocumentOverrides);
const footerShown = computed(() => !documentTab.value || !lossless.value || documentResettable.value);
const autoDewarpDepthState = computed(() => (settings.autoDewarpDepth === undefined ? 'auto' : 'manual'));

function selectTab(value: string) {
    if (value === 'document' || value === 'pages') {
        emit('update:tab', value);
    }
}

function confirmDocumentReset() {
    emit('reset-settings');
    resetOpen.value = false;
}

function emitMargin(target: TScanCleanupMarginTarget, value: number | null | undefined) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        emit('update-margin', target, value);
    }
}

function handleMarginChange(target: TScanCleanupMarginTarget, value: unknown) {
    const rawValue = value instanceof Event && value.target instanceof HTMLInputElement ? value.target.value : value;
    if (rawValue === null || rawValue === undefined || rawValue === '') {
        return;
    }
    const nextValue = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(nextValue) || nextValue < 0 || nextValue > SCAN_CLEANUP_MARGIN_MAX_MM) {
        return;
    }
    const current = target === 'all' ? linkedMarginValue.value : margins.value?.[target];
    if (nextValue !== current) {
        emitMargin(target, nextValue);
    }
}

function handleMarginFocusOut(event: FocusEvent) {
    const control = event.currentTarget;
    if (control instanceof HTMLElement && event.relatedTarget instanceof Node && control.contains(event.relatedTarget)) {
        return;
    }
    emit('margin-interaction', false);
}

// The number field re-commits its shown value on blur, so tabbing through an
// automatic page would pin the angle it only displays. Only a changed value
// is an edit.
function emitManualSkew(value: number | null | undefined) {
    if (typeof value === 'number' && Number.isFinite(value) && value !== manualSkewEntryValue.value) {
        emit('update-manual-skew', value);
    }
}

function emitAutoDewarpDepth(value: number | null | undefined) {
    if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN &&
        value <= SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX
    ) {
        updateDocument('autoDewarpDepth', value);
    }
}

function updateDocument(key: keyof IScanCleanupOptions, value: unknown) {
    emit('update-setting', key, value as IScanCleanupOptions[keyof IScanCleanupOptions]);
}
</script>

<style scoped>
.scan-cleanup-settings-content {
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
}

.scan-cleanup-settings-header {
    display: flex;
    box-sizing: border-box;
    height: var(--app-scan-header-height);
    min-height: var(--app-scan-header-height);
    flex: 0 0 var(--app-scan-header-height);
    align-items: center;
    border-block-end: var(--app-hairline-height) solid var(--ui-border);
    padding-inline: var(--app-space-9xl);
}

.scan-cleanup-settings-tabs {
    width: 100%;
}

/* One column that never grows past the rail: a long option such as a per-page
   output mode truncates inside its select instead of widening the panel. */
.scan-cleanup-settings-scroll {
    display: grid;
    min-height: 0;
    grid-template-columns: minmax(0, 1fr);
    flex: 1;
    align-content: start;
    gap: var(--app-space-lg);
    overflow: hidden auto;
    overscroll-behavior: contain;
    padding: var(--app-space-3xl) var(--app-space-9xl);
}

.scan-cleanup-option-group {
    display: grid;
    gap: var(--app-space-md);
}

/* Each group after the first, the footer included, opens with one hairline. */
.scan-cleanup-option-group + .scan-cleanup-option-group,
.scan-cleanup-option-group + .scan-cleanup-settings-footer {
    border-block-start: var(--app-hairline-height) solid var(--ui-border);
    padding-block-start: var(--app-space-lg);
}

.scan-cleanup-option-group h3 {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-bold);
    letter-spacing: var(--app-letter-spacing-caps);
    line-height: var(--app-line-height-snug);
    text-transform: uppercase;
}

.scan-cleanup-option-group,
.scan-cleanup-selection-field {
    min-width: 0;
    grid-template-columns: minmax(0, 1fr);
}

.scan-cleanup-selection-field {
    display: grid;
    gap: var(--app-space-sm);
}

.scan-cleanup-option-description,
.scan-cleanup-inline-note {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    line-height: var(--app-line-height-body);
}

.scan-cleanup-inline-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-sm);
}

.scan-cleanup-margins-control {
    display: grid;
    gap: var(--app-space-sm);
}

.scan-cleanup-margins-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--app-space-3xl);
}

/* The nine anchors form a fixed 3x3 compass beside the ink option, which is
   not an anchor: it fills the remaining width at the compass's full height. */
.scan-cleanup-alignment-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) repeat(3, var(--app-control-height-xs));
    grid-auto-rows: var(--app-control-height-xs);
    gap: var(--app-space-sm);
}

.scan-cleanup-alignment-grid > * {
    justify-content: center;
}

.scan-cleanup-alignment-ink {
    grid-column: 1;
    grid-row: 1 / span 3;
}

/* The ink option has the compass's full height, so its label wraps onto a
   second line instead of truncating in a narrow rail. */
.scan-cleanup-alignment-ink :deep([data-slot='label']) {
    line-height: var(--app-line-height-snug);
    text-align: start;
    white-space: normal;
}

.scan-cleanup-settings-footer {
    display: grid;
    gap: var(--app-space-lg);
}

.scan-cleanup-footer-action {
    width: 100%;
    justify-content: center;
}

.scan-cleanup-reset-confirmation {
    display: grid;
    max-width: var(--app-scan-reset-confirmation-width);
    gap: var(--app-space-5xl);
    padding: var(--app-space-9xl);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.scan-cleanup-reset-confirmation > span {
    color: var(--ui-text-muted);
}

.scan-cleanup-reset-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--app-space-sm);
}

.scan-cleanup-advanced,
.scan-cleanup-advanced-content {
    display: grid;
}

.scan-cleanup-advanced-content {
    gap: var(--app-space-3xl);
    padding-top: var(--app-space-3xl);
}

.scan-cleanup-advanced-toggle {
    display: flex;
    align-items: center;
    gap: var(--app-space-lg);
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--ui-text);
    cursor: pointer;
    font-size: var(--app-text-size-body-sm);
    font-weight: var(--app-font-weight-medium);
}

.scan-cleanup-advanced-toggle:focus-visible {
    border-radius: var(--app-radius-sm);
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.scan-cleanup-advanced-icon {
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    flex: none;
    color: var(--ui-text-dimmed);
}

/* The notice and its Details link share one line; a rail too narrow for both
   shortens the notice, whose full text is in the Details popover. */
.scan-cleanup-footnote {
    display: flex;
    min-width: 0;
    align-items: center;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-footnote > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scan-cleanup-details-trigger {
    flex: none;
    padding-inline: var(--app-space-sm);
}

.scan-cleanup-details-trigger:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.scan-cleanup-details-popover {
    display: grid;
    max-width: var(--app-scan-details-width);
    gap: var(--app-space-9xl);
    padding: var(--app-space-12xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
}
</style>
