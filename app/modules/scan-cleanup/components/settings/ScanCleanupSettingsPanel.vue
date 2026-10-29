<template>
    <div class="scan-cleanup-settings-content">
        <header class="scan-cleanup-settings-header">
            <strong>{{ t('scanCleanup.settings.title') }}</strong>
            <AppTooltip
                v-if="changedSettings.length > 0"
                :text="t('scanCleanup.settings.changedFromDefaults', {settings: changedSettings.join(', ')})"
                usefulness="always"
            >
                <UButton
                    type="button"
                    class="scan-cleanup-settings-reset"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-ph-arrow-u-up-left"
                    :label="t('scanCleanup.settingsBadges.reset')"
                    @click="$emit('reset-settings')"
                />
            </AppTooltip>
        </header>

        <div class="scan-cleanup-settings-scroll app-scrollbar app-scroll-region--balanced">
            <section class="scan-cleanup-option-group" data-settings-group="output">
                <h3>{{ t('scanCleanup.output.label') }}</h3>
                <ScanCleanupSegmented
                    :model-value="settings.outputMode"
                    :items="outputItems.map(item => ({...item, ariaLabel: item.fullLabel}))"
                    :group-label="t('scanCleanup.output.label')"
                    :disabled="lossless"
                    @update:model-value="updateDocument('outputMode', $event)"
                />
                <p class="scan-cleanup-option-description" data-output-description>{{ outputDescription }}</p>
                <UCheckbox
                    :model-value="lossless"
                    :label="t('scanCleanup.output.preserveOriginalQuality')"
                    @update:model-value="updateDocument('preserveOriginalQuality', $event === true)"
                />
                <UFormField
                    :class="{'scan-cleanup-field-disabled': !bilevelOutput}"
                    :label="t('scanCleanup.thickness.label', {value: thicknessLabel})"
                >
                    <USlider
                        color="primary"
                        :min="-5"
                        :max="5"
                        :step="1"
                        :model-value="settings.thickness"
                        :aria-label="t('scanCleanup.thickness.control')"
                        :disabled="!bilevelOutput"
                        @update:model-value="$emit('thickness-input', $event ?? settings.thickness)"
                    />
                    <div class="scan-cleanup-scale" aria-hidden="true">
                        <span>{{ t('scanCleanup.thickness.thinner') }}</span>
                        <span>{{ t('scanCleanup.thickness.default') }}</span>
                        <span>{{ t('scanCleanup.thickness.thicker') }}</span>
                    </div>
                </UFormField>
            </section>

            <section class="scan-cleanup-option-group" data-settings-group="document">
                <h3>{{ t('scanCleanup.groups.documentSettings') }}</h3>
                <UCheckbox
                    :model-value="settings.crop"
                    :label="t('scanCleanup.crop.label')"
                    @update:model-value="updateDocument('crop', $event === true)"
                />
                <UCheckbox
                    :model-value="settings.matchPageSize"
                    :label="t('scanCleanup.pageSize.match')"
                    v-bind="lossless && settings.matchPageSize ? {description: t('scanCleanup.pageSize.matchLosslessNote')} : {}"
                    @update:model-value="updateDocument('matchPageSize', $event === true)"
                />
                <div class="scan-cleanup-inline-row">
                    <UCheckbox
                        :model-value="settings.skipBlankPages"
                        :label="t('scanCleanup.crop.skipBlank')"
                        :disabled="lossless"
                        @update:model-value="updateDocument('skipBlankPages', $event === true)"
                    />
                    <span
                        v-if="blankPageCount > 0"
                        class="scan-cleanup-inline-note"
                    >{{ t('scanCleanup.crop.blankDetected', {count: blankPageCount}) }}</span>
                </div>
                <div class="scan-cleanup-selection-field">
                    <ScanCleanupSettingLabel :label="t('scanCleanup.layout.readingOrder')" />
                    <ScanCleanupSegmented
                        :model-value="settings.readingOrder"
                        :items="readingOrderItems"
                        :group-label="t('scanCleanup.layout.readingOrder')"
                        @update:model-value="updateDocument('readingOrder', $event)"
                    />
                </div>
            </section>

            <section class="scan-cleanup-option-group" data-settings-group="pages">
                <h3>{{ t('scanCleanup.groups.pageSettings') }}</h3>
                <ScanCleanupScopeSelector
                    :model-value="scope"
                    :customized-counts="customizedCounts"
                    :highlighted-scope="highlightedScope"
                    :page-number="pageNumber"
                    :selected-count="selectedCount"
                    @update:model-value="$emit('update:scope', $event)"
                />
                <div class="scan-cleanup-scope-context" data-scope-context>
                    <span>{{ scopeContext }}</span>
                    <UPopover
                        v-if="hasScopeOverrides"
                        v-model:open="resetOpen"
                        portal
                        :content="{side: 'bottom', align: 'end'}"
                    >
                        <UButton
                            type="button"
                            class="scan-cleanup-scope-reset"
                            color="primary"
                            variant="link"
                            size="xs"
                            :label="t(`scanCleanup.settings.resetScope.${scope}`)"
                        />
                        <template #content>
                            <div class="scan-cleanup-reset-confirmation">
                                <strong>{{ t('scanCleanup.settings.resetScope.confirm') }}</strong>
                                <span>{{ resetConfirmationBody }}</span>
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
                                        :label="t('scanCleanup.pages.resetAction')"
                                        @click="confirmReset"
                                    />
                                </div>
                            </div>
                        </template>
                    </UPopover>
                </div>

                <ScanCleanupPageFindings
                    v-if="scope === 'page' && pageFacts"
                    :facts="pageFacts"
                    :page-number="pageNumber"
                />

                <div class="scan-cleanup-selection-field">
                    <ScanCleanupSettingLabel
                        control="layout"
                        :label="t('scanCleanup.layout.label')"
                        :mixed="layout.mixed"
                        :overridden="scoped && overrideCounts.layout > 0"
                        @reset="$emit('reset-control-override', 'layout')"
                    />
                    <USelect
                        :model-value="layoutModelValue"
                        :items="layoutItems"
                        value-key="value"
                        class="w-full"
                        :aria-label="t('scanCleanup.layout.label')"
                        @update:model-value="$emit('update-layout', $event)"
                    />
                </div>

                <div class="scan-cleanup-selection-field">
                    <ScanCleanupSettingLabel
                        control="rotation"
                        :label="t('scanCleanup.settings.rotation')"
                        :mixed="rotation.mixed"
                        :overridden="scoped && overrideCounts.rotation > 0"
                        @reset="$emit('reset-control-override', 'rotation')"
                    />
                    <ScanCleanupSegmented
                        :model-value="rotationModelValue"
                        :items="rotationSegments"
                        :group-label="t('scanCleanup.settings.rotation')"
                        @update:model-value="$emit('update-rotation', $event)"
                    />
                </div>

                <div v-if="scoped" class="scan-cleanup-selection-field">
                    <ScanCleanupSettingLabel
                        control="output-mode"
                        :label="t('scanCleanup.output.pageLabel')"
                        :mixed="outputModeOverride.mixed"
                        :overridden="overrideCounts.outputMode > 0"
                        @reset="$emit('reset-control-override', 'output-mode')"
                    />
                    <USelect
                        :model-value="outputModeOverrideModelValue"
                        :items="outputModeOverrideItems"
                        value-key="value"
                        class="w-full"
                        :aria-label="t('scanCleanup.output.pageLabel')"
                        :disabled="lossless"
                        @update:model-value="$emit('update-output-mode', $event)"
                    />
                    <p v-if="outputModeHint" class="scan-cleanup-option-description">{{ outputModeHint }}</p>
                </div>

                <div
                    class="scan-cleanup-margins-control"
                    @focusin="$emit('margin-interaction', true)"
                    @focusout="handleMarginFocusOut"
                >
                    <ScanCleanupSettingLabel
                        control="margins"
                        :label="t('scanCleanup.margins.title')"
                        :mixed="margins.mixed"
                        :overridden="scoped && overrideCounts.margins > 0"
                        @reset="$emit('reset-control-override', 'margins')"
                    >
                        <AppTooltip :text="t('scanCleanup.margins.linkTooltip')" usefulness="always">
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
                                @click="$emit('update:margins-linked', !marginsLinked)"
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
                    <div v-else class="scan-cleanup-margins-grid">
                        <UFormField
                            v-for="side in SCAN_CLEANUP_MARGIN_SIDES"
                            :key="side.key"
                            :label="t(side.labelKey)"
                        >
                            <UInputNumber
                                :model-value="margins.mixed ? null : margins.value?.[side.key] ?? null"
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

                <ScanCleanupAutoValueRow
                    :label="manualSkewLabel"
                    :state="manualSkewState"
                    :value-text="manualSkewValueText"
                    :hint="manualSkewHint"
                    reserve-hint
                    :disabled="lossless"
                    @reset="$emit('reset-manual-skew')"
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
                            :disabled="lossless"
                            @update:model-value="emitManualSkew"
                        />
                    </template>
                </ScanCleanupAutoValueRow>

                <div v-if="settings.matchPageSize" class="scan-cleanup-selection-field">
                    <ScanCleanupSettingLabel
                        control="placement"
                        :label="t('scanCleanup.settings.contentPlacement')"
                        :mixed="placementAlignment.mixed"
                        :overridden="scoped && overrideCounts.placement > 0"
                        @reset="$emit('reset-control-override', 'placement')"
                    />
                    <div
                        class="scan-cleanup-alignment-grid"
                        role="radiogroup"
                        :aria-label="t('scanCleanup.settings.contentPlacement')"
                    >
                        <UButton
                            v-for="item in alignmentItems"
                            :key="item.value"
                            :class="item.value === 'ink' ? 'scan-cleanup-alignment-ink' : undefined"
                            :aria-label="item.label"
                            :aria-checked="!placementAlignment.mixed && placementAlignment.value === item.value"
                            :color="!placementAlignment.mixed && placementAlignment.value === item.value ? 'primary' : 'neutral'"
                            :variant="!placementAlignment.mixed && placementAlignment.value === item.value ? 'soft' : 'outline'"
                            role="radio"
                            size="sm"
                            :icon="item.icon"
                            v-bind="item.value === 'ink' ? {label: item.label} : {}"
                            @click="$emit('update-placement', item.value)"
                        />
                    </div>
                    <p v-if="placementHint" class="scan-cleanup-option-description">{{ placementHint }}</p>
                </div>

                <UCheckbox
                    v-if="scoped"
                    :model-value="excluded.mixed ? 'indeterminate' : excluded.value !== true"
                    :label="t('scanCleanup.pages.includeInOutput')"
                    data-page-inclusion
                    @update:model-value="$emit('update-inclusion', $event === true ? 'included' : 'excluded')"
                />

                <ScanCleanupAutoValueRow
                    v-if="manualSplitState !== 'auto'"
                    :label="t('scanCleanup.settings.manualSplit')"
                    :state="manualSplitState"
                    @reset="$emit('reset-manual-split')"
                />
                <ScanCleanupAutoValueRow
                    v-if="contentBoxesState !== 'auto'"
                    :label="t('scanCleanup.settings.contentBox')"
                    :state="contentBoxesState"
                    @reset="$emit('reset-content-boxes')"
                />

                <UDropdownMenu
                    v-if="scope === 'page'"
                    :items="applyScopeItems"
                    :content="{side: 'bottom', align: 'end'}"
                >
                    <UButton
                        type="button"
                        class="scan-cleanup-apply-page"
                        color="neutral"
                        variant="outline"
                        size="sm"
                        :label="t('scanCleanup.settings.applyThisPageTo')"
                        trailing-icon="i-ph-caret-down"
                    />
                </UDropdownMenu>
            </section>

            <UCollapsible
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
                                :model-value="settings.binarization ?? 'auto'"
                                :items="binarizationItems"
                                value-key="value"
                                class="w-full"
                                :disabled="lossless"
                                @update:model-value="updateDocument('binarization', $event)"
                            />
                        </UFormField>
                        <UFormField :label="t('scanCleanup.advanced.despeckle.label')">
                            <USelect
                                :model-value="settings.despeckleLevel
                                    ?? ((settings.despeckle ?? true) ? 'normal' : 'off')"
                                :items="despeckleItems"
                                value-key="value"
                                class="w-full"
                                :disabled="!bilevelOutput"
                                @update:model-value="updateDocument('despeckleLevel', $event)"
                            />
                        </UFormField>
                        <UCheckbox
                            :model-value="settings.normalizeIllumination ?? true"
                            :label="t('scanCleanup.advanced.normalizeIllumination')"
                            :disabled="lossless"
                            @update:model-value="updateDocument('normalizeIllumination', $event === true)"
                        />
                        <UCheckbox
                            :model-value="settings.autoDewarp ?? false"
                            :label="t('scanCleanup.advanced.autoDewarp')"
                            :disabled="lossless"
                            @update:model-value="updateDocument('autoDewarp', $event === true)"
                        />
                        <ScanCleanupAutoValueRow
                            :label="t('scanCleanup.advanced.autoDewarpDepth')"
                            :state="autoDewarpDepthState"
                            :disabled="autoDewarpDepthDisabled"
                            @reset="updateDocument('autoDewarpDepth', undefined)"
                        >
                            <template #entry>
                                <UInputNumber
                                    :model-value="settings.autoDewarpDepth ?? null"
                                    :min="SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN"
                                    :max="SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX"
                                    :step="0.1"
                                    :placeholder="t('scanCleanup.advanced.autoDewarpDepthAutomatic')"
                                    :aria-label="t('scanCleanup.advanced.autoDewarpDepth')"
                                    :disabled="autoDewarpDepthDisabled"
                                    @update:model-value="emitAutoDewarpDepth"
                                />
                            </template>
                        </ScanCleanupAutoValueRow>
                    </div>
                </template>
            </UCollapsible>

            <div v-if="!lossless" class="scan-cleanup-footnote">
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
import ScanCleanupAutoValueRow from '@app/modules/scan-cleanup/components/settings/ScanCleanupAutoValueRow.vue';
import ScanCleanupPageFindings from '@app/modules/scan-cleanup/components/settings/ScanCleanupPageFindings.vue';
import ScanCleanupScopeSelector from '@app/modules/scan-cleanup/components/settings/ScanCleanupScopeSelector.vue';
import ScanCleanupSettingLabel from '@app/modules/scan-cleanup/components/settings/ScanCleanupSettingLabel.vue';
import ScanCleanupSegmented from '@app/modules/scan-cleanup/components/ScanCleanupSegmented.vue';
import type {
    TScanCleanupOverrideControl,
    TScanCleanupSettingsScope,
} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import {
    scanCleanupPageOutputModeHint,
    type IScanCleanupPageFacts,
} from '@app/modules/scan-cleanup/runtime/describeScanCleanupPage';
import type {IScanCleanupMixedValue} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import type {TScanCleanupMarginTarget} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';
import {
    SCAN_CLEANUP_MARGIN_SIDES,
    scanCleanupMarginsUniform,
} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';

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

const props = defineProps<{
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
    /** Labels of the settings that differ from the defaults. */
    changedSettings: readonly string[];
    contentBoxes: IScanCleanupMixedValue<Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>>;
    customizedCounts: Record<TScanCleanupSettingsScope, number>;
    detectedSkewDegrees: number | undefined;
    excluded: IScanCleanupMixedValue<boolean>;
    hasScopeOverrides: boolean;
    highlightedScope: TScanCleanupSettingsScope | null;
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
    /** What is known about the page in Page scope, for its findings and hints. */
    pageFacts: IScanCleanupPageFacts | null;
    pageNumber: number;
    placementAlignment: IScanCleanupMixedValue<TScanCleanupPageAlignment>;
    readingOrderItems: Array<ISelectItem<IScanCleanupOptions['readingOrder']>>;
    rotation: IScanCleanupMixedValue<TScanCleanupPageRotation>;
    rotationItems: ISelectItem[];
    scope: TScanCleanupSettingsScope;
    selectedCount: number;
    settings: IScanCleanupOptions;
    thicknessLabel: string;
    totalPages: number;
}>();
const emit = defineEmits<{
    'margin-interaction': [active: boolean];
    'reset-control-override': [control: TScanCleanupOverrideControl];
    'reset-content-boxes': [];
    'reset-manual-split': [];
    'reset-manual-skew': [];
    'reset-scope-overrides': [];
    'reset-settings': [];
    'thickness-input': [value: number | number[]];
    'update-inclusion': [value: string | number];
    'update-layout': [value: string | number];
    'update-margin': [target: TScanCleanupMarginTarget, value: number];
    'update-manual-skew': [value: number | undefined];
    'update-output-mode': [value: string | number];
    'update:margins-linked': [value: boolean];
    'update-placement': [value: TScanCleanupPageAlignment];
    'update-rotation': [value: string | number];
    'update-setting': [key: keyof IScanCleanupOptions, value: IScanCleanupOptions[keyof IScanCleanupOptions]];
    'update:scope': [value: TScanCleanupSettingsScope];
}>();
const {t} = useTypedI18n();
const resetOpen = ref(false);
const advancedOpen = ref(false);
const lossless = computed(() => props.settings.preserveOriginalQuality === true);
// Page and Selected scopes edit their own pages; All edits the defaults every
// page starts from, so only the scoped views mark controls as overridden.
const scoped = computed(() => props.scope !== 'all');
const outputDescription = computed(() => lossless.value
    ? t('scanCleanup.output.losslessDisabledOptions')
    : t(`scanCleanup.output.description.${props.settings.outputMode}`));
const scopeContext = computed(() => {
    if (props.scope === 'page') {
        return t('scanCleanup.settings.scope.pageContext', {page: props.pageNumber});
    }
    if (props.scope === 'selected') {
        return t('scanCleanup.settings.scope.selectedContext', {count: props.selectedCount});
    }
    return props.hasScopeOverrides
        ? t('scanCleanup.settings.scope.allContextCustomized')
        : t('scanCleanup.settings.scope.allContext');
});
// Automatic dewarping replaces the detected content boxes with a reshaped
// page, so `ink` has nothing to anchor to and every output falls back to the
// top-centre position. Say so where the choice is made rather than letting the
// preview quietly disagree with the setting.
const placementHint = computed(() => !props.placementAlignment.mixed
    && props.placementAlignment.value === 'ink'
    && props.settings.autoDewarp === true
    ? t('scanCleanup.settings.inkNeedsContentBoxes')
    : '');
const outputModeHint = computed(() => props.scope === 'page' && props.pageFacts
    ? scanCleanupPageOutputModeHint(t, props.pageFacts, props.settings.outputMode, lossless.value)
    : '');
const binarizationItems = computed(() => ([
    'auto',
    'otsu',
    'sauvola',
    'wolf',
] as const).map(value => ({
    value,
    label: t(`scanCleanup.advanced.binarization.${value}`),
})));
const despeckleItems = computed(() => ([
    'off',
    'cautious',
    'normal',
    'aggressive',
] as const).map(value => ({
    value,
    label: t(`scanCleanup.advanced.despeckle.${value}`),
})));

const layoutModelValue = computed(() => props.layout.mixed ? 'mixed' : props.layout.value ?? 'auto');
const rotationModelValue = computed(() => props.rotation.mixed ? '' : String(props.rotation.value ?? 0));
const rotationSegments = computed(() => props.rotationItems.filter(item => item.value !== 'mixed'));
const outputModeOverrideModelValue = computed(() => props.outputModeOverride.mixed
    ? 'mixed-values'
    : props.outputModeOverride.value ?? 'auto');
const linkedMarginValue = computed(() => {
    const margins = props.margins;
    return margins.mixed || !margins.value || !scanCleanupMarginsUniform(margins.value)
        ? null
        : margins.value.topMm;
});
const hasContentBoxes = computed(() => props.contentBoxes.mixed
    || Object.keys(props.contentBoxes.value ?? {}).length > 0);
const manualSkewState = computed(() => props.manualSkew.mixed
    ? 'mixed'
    : props.manualSkew.value === undefined ? 'auto' : 'manual');
const manualSkewLabel = computed(() => t('scanCleanup.settings.manualSkew'));
const manualSkewRange = computed(() => t('scanCleanup.settings.manualSkewRange', {
    min: SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES,
    max: SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES,
}));
// The stepper starts from the neutral 0° rather than from an empty field:
// a null number field steps to its minimum, which made every first press jump
// to -15° and put the positive half of the range out of reach.
const manualSkewEntryValue = computed(() => props.manualSkew.mixed
    ? null
    : props.manualSkew.value ?? 0);
const manualSkewValueText = computed(() => {
    const value = props.manualSkew.value;
    if (props.manualSkew.mixed || value === undefined) {
        return undefined;
    }
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}°`;
});
// The allowed range fills the hint line until a detected angle takes it.
const manualSkewHint = computed(() => !props.manualSkew.mixed
    && props.manualSkew.value === undefined
    && props.detectedSkewDegrees !== undefined
    ? t('scanCleanup.settings.detectedSkew', {angle: props.detectedSkewDegrees.toFixed(1)})
    : manualSkewRange.value);
const manualSplitState = computed(() => props.manualSplit.mixed
    ? 'mixed'
    : props.manualSplit.value === null ? 'auto' : 'manual');
const contentBoxesState = computed(() => props.contentBoxes.mixed
    ? 'mixed'
    : hasContentBoxes.value ? 'manual' : 'auto');
// Text thickness and speckle removal only affect black-and-white output, which
// Auto produces for text pages. They keep their place and disable instead of
// unmounting: switching B&W/gray/colour must not move the controls below them.
const bilevelOutput = computed(() => !lossless.value
    && (props.settings.outputMode === 'auto'
        || props.settings.outputMode === 'bw'
        || props.settings.outputMode === 'mixed'));
const autoDewarpDepthState = computed(() => props.settings.autoDewarpDepth === undefined ? 'auto' : 'manual');
const autoDewarpDepthDisabled = computed(() => lossless.value || !(props.settings.autoDewarp ?? false));
const resetConfirmationBody = computed(() => t(`scanCleanup.settings.resetScope.${props.scope}Body`, {
    count: props.scope === 'selected' ? props.selectedCount : props.totalPages,
    page: props.pageNumber,
}));

function confirmReset() {
    emit('reset-scope-overrides');
    resetOpen.value = false;
}

function emitMargin(target: TScanCleanupMarginTarget, value: number | null | undefined) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        emit('update-margin', target, value);
    }
}

function handleMarginChange(target: TScanCleanupMarginTarget, value: unknown) {
    const rawValue = value instanceof Event && value.target instanceof HTMLInputElement
        ? value.target.value
        : value;
    if (rawValue === null || rawValue === undefined || rawValue === '') {
        return;
    }
    const nextValue = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (
        !Number.isFinite(nextValue)
        || nextValue < 0
        || nextValue > SCAN_CLEANUP_MARGIN_MAX_MM
    ) {
        return;
    }
    const current = target === 'all' ? linkedMarginValue.value : props.margins.value?.[target];
    if (nextValue !== current) {
        emitMargin(target, nextValue);
    }
}

function handleMarginFocusOut(event: FocusEvent) {
    const control = event.currentTarget;
    if (
        control instanceof HTMLElement
        && event.relatedTarget instanceof Node
        && control.contains(event.relatedTarget)
    ) {
        return;
    }
    emit('margin-interaction', false);
}

function emitManualSkew(value: number | null | undefined) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        emit('update-manual-skew', value);
    }
}

function emitAutoDewarpDepth(value: number | null | undefined) {
    if (
        typeof value === 'number'
        && Number.isFinite(value)
        && value >= SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN
        && value <= SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX
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
    justify-content: space-between;
    gap: var(--app-space-sm);
    border-block-end: var(--app-hairline-height) solid var(--ui-border);
    padding-inline: var(--app-space-9xl);
}

.scan-cleanup-settings-header > strong {
    font-size: var(--app-text-size-secondary);
}

/* One column that never grows past the rail: a long option such as a per-page
   output mode truncates inside its select instead of widening the panel. */
.scan-cleanup-settings-scroll {
    display: grid;
    min-height: 0;
    grid-template-columns: minmax(0, 1fr);
    flex: 1;
    align-content: start;
    gap: var(--app-space-5xl);
    overflow: hidden auto;
    overscroll-behavior: contain;
    padding: var(--app-space-9xl);
}

.scan-cleanup-option-group {
    display: grid;
    gap: var(--app-space-5xl);
}

.scan-cleanup-option-group + .scan-cleanup-option-group,
.scan-cleanup-advanced {
    border-block-start: var(--app-hairline-height) solid var(--ui-border);
    padding-block-start: var(--app-space-9xl);
}

.scan-cleanup-option-group h3 {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-weight: var(--app-font-weight-bold);
    letter-spacing: var(--app-letter-spacing-caps);
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

/* A control whose value no longer applies stays in place and dims, matching
   ScanCleanupAutoValueRow, instead of unmounting and collapsing its row. */
.scan-cleanup-field-disabled {
    opacity: var(--app-scan-disabled-opacity);
}

.scan-cleanup-scale {
    display: flex;
    justify-content: space-between;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.scan-cleanup-option-description,
.scan-cleanup-inline-note {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    line-height: var(--app-line-height-body);
}

/* The description below the output modes always holds two lines, so choosing
   a mode with a shorter sentence does not move the settings under it. */
[data-output-description] {
    min-height: calc(var(--app-text-size-kicker) * var(--app-line-height-body) * 2);
}

.scan-cleanup-inline-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-sm);
}

.scan-cleanup-scope-context {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-sm);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    line-height: var(--app-line-height-body);
}

.scan-cleanup-scope-reset {
    padding-inline: 0;
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

.scan-cleanup-alignment-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--app-space-sm);
}

.scan-cleanup-alignment-grid > * {
    justify-content: center;
}

/* Not one of the nine anchors: it spans the row above them and carries its
   own label, so the grid still reads as a 3x3 compass. */
.scan-cleanup-alignment-ink {
    grid-column: 1 / -1;
}

.scan-cleanup-apply-page {
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

.scan-cleanup-footnote {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
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
