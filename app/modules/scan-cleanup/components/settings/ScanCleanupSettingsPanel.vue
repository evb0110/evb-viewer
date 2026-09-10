<template>
    <div class="scan-cleanup-settings-content">
        <header class="scan-cleanup-settings-header">
            <strong>{{ t('scanCleanup.settings.scope.label') }}</strong>
            <UPopover
                v-if="hasScopeOverrides"
                v-model:open="resetOpen"
                portal
                :content="{side: 'bottom', align: 'end'}"
            >
                <UButton
                    type="button"
                    class="scan-cleanup-scope-reset"
                    color="neutral"
                    variant="outline"
                    size="xs"
                    :label="resetLabel"
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
        </header>

        <div class="scan-cleanup-settings-scroll app-scrollbar app-scroll-region--balanced">
            <div class="scan-cleanup-scope-area">
            <ScanCleanupScopeSelector
                :model-value="scope"
                :customized-counts="customizedCounts"
                :highlighted-scope="highlightedScope"
                :page-number="pageNumber"
                :selected-count="selectedCount"
                :total-pages="totalPages"
                @update:model-value="$emit('update:scope', $event)"
            />
            </div>

        <section class="scan-cleanup-option-group">
            <h3>{{ t('scanCleanup.groups.pageSettings') }}</h3>
            <div class="scan-cleanup-selection-field">
                <div class="scan-cleanup-selection-field-label">
                    <div class="scan-cleanup-control-label">
                        <span>{{ t('scanCleanup.layout.label') }}</span>
                        <span
                            v-if="scope !== 'all' && overrideCounts.layout > 0"
                            class="scan-cleanup-override-marker"
                            data-override-marker="layout"
                        ><span aria-hidden="true" />{{ t('scanCleanup.settings.override') }}</span>
                    </div>
                    <div class="scan-cleanup-control-affordances">
                        <UBadge v-if="layout.mixed" color="neutral" variant="soft" size="sm">
                            {{ t('scanCleanup.settings.mixed') }}
                        </UBadge>
                        <UBadge
                            v-if="scope === 'all' && overrideCounts.layout > 0"
                            color="neutral"
                            variant="soft"
                            size="sm"
                            data-override-count="layout"
                            :title="overrideCountTitle(overrideCounts.layout)"
                        >{{ overrideCounts.layout }}</UBadge>
                        <UButton
                            v-if="scope !== 'all' && overrideCounts.layout > 0"
                            type="button"
                            color="primary"
                            variant="ghost"
                            size="xs"
                            square
                            icon="i-ph-arrow-u-up-left"
                            data-reset-override="layout"
                            :aria-label="t('scanCleanup.settings.resetToDocument')"
                            @click="$emit('reset-control-override', 'layout')"
                        />
                    </div>
                </div>
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
                <div class="scan-cleanup-selection-field-label">
                    <div class="scan-cleanup-control-label">
                        <span>{{ t('scanCleanup.settings.rotation') }}</span>
                        <span
                            v-if="scope !== 'all' && overrideCounts.rotation > 0"
                            class="scan-cleanup-override-marker"
                            data-override-marker="rotation"
                        ><span aria-hidden="true" />{{ t('scanCleanup.settings.override') }}</span>
                    </div>
                    <div class="scan-cleanup-control-affordances">
                        <UBadge v-if="rotation.mixed" color="neutral" variant="soft" size="sm">
                            {{ t('scanCleanup.settings.mixed') }}
                        </UBadge>
                        <UBadge
                            v-if="scope === 'all' && overrideCounts.rotation > 0"
                            color="neutral"
                            variant="soft"
                            size="sm"
                            data-override-count="rotation"
                            :title="overrideCountTitle(overrideCounts.rotation)"
                        >{{ overrideCounts.rotation }}</UBadge>
                        <UButton
                            v-if="scope !== 'all' && overrideCounts.rotation > 0"
                            type="button"
                            color="primary"
                            variant="ghost"
                            size="xs"
                            square
                            icon="i-ph-arrow-u-up-left"
                            data-reset-override="rotation"
                            :aria-label="t('scanCleanup.settings.resetToDocument')"
                            @click="$emit('reset-control-override', 'rotation')"
                        />
                    </div>
                </div>
                <USelect
                    :model-value="rotationModelValue"
                    :items="rotationItems"
                    value-key="value"
                    class="w-full"
                    :aria-label="t('scanCleanup.settings.rotation')"
                    @update:model-value="$emit('update-rotation', $event)"
                />
            </div>
            <div class="scan-cleanup-selection-field">
                <div class="scan-cleanup-selection-field-label">
                    <div class="scan-cleanup-control-label">
                        <span>{{ t('scanCleanup.settings.inOutput') }}</span>
                        <span
                            v-if="scope !== 'all' && overrideCounts.inclusion > 0"
                            class="scan-cleanup-override-marker"
                            data-override-marker="inclusion"
                        ><span aria-hidden="true" />{{ t('scanCleanup.settings.override') }}</span>
                    </div>
                    <div class="scan-cleanup-control-affordances">
                        <UBadge v-if="excluded.mixed" color="neutral" variant="soft" size="sm">
                            {{ t('scanCleanup.settings.mixed') }}
                        </UBadge>
                        <UBadge
                            v-if="scope === 'all' && overrideCounts.inclusion > 0"
                            color="neutral"
                            variant="soft"
                            size="sm"
                            data-override-count="inclusion"
                            :title="overrideCountTitle(overrideCounts.inclusion)"
                        >{{ overrideCounts.inclusion }}</UBadge>
                        <UButton
                            v-if="scope !== 'all' && overrideCounts.inclusion > 0"
                            type="button"
                            color="primary"
                            variant="ghost"
                            size="xs"
                            square
                            icon="i-ph-arrow-u-up-left"
                            data-reset-override="inclusion"
                            :aria-label="t('scanCleanup.settings.resetToDocument')"
                            @click="$emit('reset-control-override', 'inclusion')"
                        />
                    </div>
                </div>
                <USelect
                    :model-value="inclusionModelValue"
                    :items="inclusionItems"
                    value-key="value"
                    class="w-full"
                    :aria-label="t('scanCleanup.settings.inOutput')"
                    @update:model-value="$emit('update-inclusion', $event)"
                />
            </div>

            <div
                class="scan-cleanup-margins-control"
                @focusin="$emit('margin-interaction', true)"
                @focusout="handleMarginFocusOut"
            >
                <div class="scan-cleanup-margins-header">
                    <div class="scan-cleanup-control-label">
                        <span>{{ t('scanCleanup.margins.title') }}</span>
                        <span
                            v-if="scope !== 'all' && overrideCounts.margins > 0"
                            class="scan-cleanup-override-marker"
                            data-override-marker="margins"
                        ><span aria-hidden="true" />{{ t('scanCleanup.settings.override') }}</span>
                    </div>
                    <div class="scan-cleanup-control-affordances">
                        <UBadge v-if="margins.mixed" color="neutral" variant="soft" size="sm">
                            {{ t('scanCleanup.settings.mixed') }}
                        </UBadge>
                        <UBadge
                            v-if="scope === 'all' && overrideCounts.margins > 0"
                            color="neutral"
                            variant="soft"
                            size="sm"
                            data-override-count="margins"
                            :title="overrideCountTitle(overrideCounts.margins)"
                        >{{ overrideCounts.margins }}</UBadge>
                        <UButton
                            v-if="scope !== 'all' && overrideCounts.margins > 0"
                            type="button"
                            color="primary"
                            variant="ghost"
                            size="xs"
                            square
                            icon="i-ph-arrow-u-up-left"
                            data-reset-override="margins"
                            :aria-label="t('scanCleanup.settings.resetToDocument')"
                            @click="$emit('reset-control-override', 'margins')"
                        />
                    </div>
                </div>
                <div class="scan-cleanup-margins-grid">
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
                <UCheckbox
                    class="w-full"
                    data-margins-link
                    :model-value="marginsLinked"
                    :label="t('scanCleanup.margins.link')"
                    :title="t('scanCleanup.margins.linkTooltip')"
                    @update:model-value="$emit('update:margins-linked', $event === true)"
                />
            </div>

            <ScanCleanupAutoValueRow
                :label="manualSkewLabel"
                :state="manualSkewState"
                :value-text="manualSkewValueText"
                :hint="manualSkewHint"
                reserve-hint
                :disabled="settings.preserveOriginalQuality === true"
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
                        :aria-label="manualSkewLabel"
                        :disabled="settings.preserveOriginalQuality === true"
                        @update:model-value="emitManualSkew"
                    />
                </template>
            </ScanCleanupAutoValueRow>
            <ScanCleanupAutoValueRow
                :label="t('scanCleanup.settings.manualSplit')"
                :state="manualSplitState"
                @reset="$emit('reset-manual-split')"
            />
            <ScanCleanupAutoValueRow
                :label="t('scanCleanup.settings.contentBox')"
                :state="contentBoxesState"
                @reset="$emit('reset-content-boxes')"
            />

            <div class="scan-cleanup-selection-field">
                <div class="scan-cleanup-selection-field-label">
                    <div class="scan-cleanup-control-label">
                        <span>{{ t('scanCleanup.settings.contentPlacement') }}</span>
                        <span
                            v-if="scope !== 'all' && overrideCounts.placement > 0"
                            class="scan-cleanup-override-marker"
                            data-override-marker="placement"
                        ><span aria-hidden="true" />{{ t('scanCleanup.settings.override') }}</span>
                    </div>
                    <div class="scan-cleanup-control-affordances">
                        <UBadge v-if="placementAlignment.mixed" color="neutral" variant="soft" size="sm">
                            {{ t('scanCleanup.settings.mixed') }}
                        </UBadge>
                        <UBadge
                            v-if="scope === 'all' && overrideCounts.placement > 0"
                            color="neutral"
                            variant="soft"
                            size="sm"
                            data-override-count="placement"
                            :title="overrideCountTitle(overrideCounts.placement)"
                        >{{ overrideCounts.placement }}</UBadge>
                        <UButton
                            v-if="scope !== 'all' && overrideCounts.placement > 0"
                            type="button"
                            color="primary"
                            variant="ghost"
                            size="xs"
                            square
                            icon="i-ph-arrow-u-up-left"
                            data-reset-override="placement"
                            :aria-label="t('scanCleanup.settings.resetToDocument')"
                            @click="$emit('reset-control-override', 'placement')"
                        />
                    </div>
                </div>
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
                        :disabled="!settings.matchPageSize"
                        role="radio"
                        size="sm"
                        :icon="item.icon"
                        v-bind="item.value === 'ink' ? {label: item.label} : {}"
                        @click="$emit('update-placement', item.value)"
                    />
                </div>
                <p class="scan-cleanup-selection-hint is-reserved is-two-lines">
                    {{ placementHint }}&nbsp;
                </p>
            </div>

            <div v-if="scope !== 'all'" class="scan-cleanup-selection-field">
                <div class="scan-cleanup-selection-field-label">
                    <div class="scan-cleanup-control-label">
                        <span>{{ t('scanCleanup.output.pageLabel') }}</span>
                        <span
                            v-if="overrideCounts.outputMode > 0"
                            class="scan-cleanup-override-marker"
                            data-override-marker="output-mode"
                        ><span aria-hidden="true" />{{ t('scanCleanup.settings.override') }}</span>
                    </div>
                    <div class="scan-cleanup-control-affordances">
                        <UBadge v-if="outputModeOverride.mixed" color="neutral" variant="soft" size="sm">
                            {{ t('scanCleanup.settings.mixed') }}
                        </UBadge>
                        <UButton
                            v-if="overrideCounts.outputMode > 0"
                            type="button"
                            color="primary"
                            variant="ghost"
                            size="xs"
                            square
                            icon="i-ph-arrow-u-up-left"
                            data-reset-override="output-mode"
                            :aria-label="t('scanCleanup.settings.resetToDocument')"
                            @click="$emit('reset-control-override', 'output-mode')"
                        />
                    </div>
                </div>
                <USelect
                    :model-value="outputModeOverrideModelValue"
                    :items="outputModeOverrideItems"
                    value-key="value"
                    class="w-full"
                    :aria-label="t('scanCleanup.output.pageLabel')"
                    :title="settings.preserveOriginalQuality
                        ? t('scanCleanup.pages.outputModeLosslessControlHint')
                        : undefined"
                    :disabled="settings.preserveOriginalQuality === true"
                    @update:model-value="$emit('update-output-mode', $event)"
                />
                <p
                    v-if="settings.preserveOriginalQuality"
                    class="scan-cleanup-lossless-explanation"
                >{{ t('scanCleanup.pages.outputModeLosslessControlHint') }}</p>
            </div>

            <div class="scan-cleanup-apply-page-area">
                <UDropdownMenu
                    :items="applyScopeItems"
                    :content="{side: 'bottom', align: 'end'}"
                    :disabled="scope !== 'page'"
                >
                    <UButton
                        type="button"
                        class="scan-cleanup-apply-page"
                        color="neutral"
                        variant="outline"
                        size="sm"
                        :label="t('scanCleanup.settings.applyThisPageTo')"
                        trailing-icon="i-ph-caret-down"
                        :disabled="scope !== 'page'"
                        :aria-describedby="scope === 'page' ? undefined : applyPageHintId"
                    />
                </UDropdownMenu>
                <p
                    :id="applyPageHintId"
                    class="scan-cleanup-selection-hint is-reserved"
                >
                    {{ scope === 'page' ? '' : t('scanCleanup.settings.applyThisPageToHint') }}&nbsp;
                </p>
            </div>
        </section>

        <section class="scan-cleanup-option-group">
            <h3>{{ t('scanCleanup.groups.documentSettings') }}</h3>
            <UCheckbox
                :model-value="settings.preserveOriginalQuality === true"
                :label="t('scanCleanup.output.preserveOriginalQuality')"
                @update:model-value="updateDocument('preserveOriginalQuality', $event === true)"
            />
            <ScanCleanupSegmented
                :model-value="settings.outputMode"
                :items="outputItems.map(item => ({...item, ariaLabel: item.fullLabel}))"
                :group-label="t('scanCleanup.output.label')"
                :disabled="settings.preserveOriginalQuality === true"
                @update:model-value="updateDocument('outputMode', $event)"
            />
            <UFormField
                :class="{'scan-cleanup-field-disabled': !thicknessApplies}"
                :label="t('scanCleanup.thickness.label', {value: thicknessLabel})"
            >
                <USlider
                    color="primary"
                    :min="-5"
                    :max="5"
                    :step="1"
                    :model-value="settings.thickness"
                    :aria-label="t('scanCleanup.thickness.control')"
                    :disabled="!thicknessApplies"
                    @update:model-value="$emit('thickness-input', $event)"
                />
                <div class="scan-cleanup-scale" aria-hidden="true">
                    <span>{{ t('scanCleanup.thickness.thinner') }}</span>
                    <span>{{ t('scanCleanup.thickness.default') }}</span>
                    <span>{{ t('scanCleanup.thickness.thicker') }}</span>
                </div>
            </UFormField>
            <p v-if="settings.preserveOriginalQuality" class="scan-cleanup-lossless-explanation">
                {{ t('scanCleanup.output.losslessDisabledOptions') }}
            </p>
            <UFormField :label="t('scanCleanup.layout.readingOrder')">
                <USelect
                    :model-value="settings.readingOrder"
                    :items="readingOrderItems"
                    value-key="value"
                    class="w-full"
                    @update:model-value="updateDocument('readingOrder', $event)"
                />
            </UFormField>
            <UCheckbox
                :model-value="settings.crop"
                :label="t('scanCleanup.crop.label')"
                @update:model-value="updateDocument('crop', $event === true)"
            />
            <UCheckbox
                :model-value="settings.matchPageSize"
                :label="t('scanCleanup.pageSize.match')"
                @update:model-value="updateDocument('matchPageSize', $event === true)"
            />
            <p class="scan-cleanup-selection-hint is-reserved is-two-lines">
                {{ settings.preserveOriginalQuality && settings.matchPageSize
                    ? t('scanCleanup.pageSize.matchLosslessNote')
                    : '' }}&nbsp;
            </p>
            <UCheckbox
                :model-value="settings.skipBlankPages"
                :label="t('scanCleanup.crop.skipBlank')"
                :disabled="settings.preserveOriginalQuality === true"
                @update:model-value="updateDocument('skipBlankPages', $event === true)"
            />
            <p
                v-if="blankPageCount > 0"
                class="scan-cleanup-blank-detected-hint"
            >{{ t('scanCleanup.crop.blankDetected', {count: blankPageCount}) }}</p>
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
                                :disabled="settings.preserveOriginalQuality === true"
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
                                :disabled="settings.preserveOriginalQuality === true
                                    || (settings.outputMode !== 'bw' && settings.outputMode !== 'mixed')"
                                @update:model-value="updateDocument('despeckleLevel', $event)"
                            />
                        </UFormField>
                        <UCheckbox
                            :model-value="settings.normalizeIllumination ?? true"
                            :label="t('scanCleanup.advanced.normalizeIllumination')"
                            :disabled="settings.preserveOriginalQuality === true"
                            @update:model-value="updateDocument('normalizeIllumination', $event === true)"
                        />
                        <UCheckbox
                            :model-value="settings.autoDewarp ?? false"
                            :label="t('scanCleanup.advanced.autoDewarp')"
                            :disabled="settings.preserveOriginalQuality === true"
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
                        <p v-if="settings.preserveOriginalQuality" class="scan-cleanup-selection-hint">
                            {{ t('scanCleanup.advanced.losslessDisabled') }}
                        </p>
                    </div>
                </template>
            </UCollapsible>
        </section>

        <div v-if="!settings.preserveOriginalQuality" class="scan-cleanup-footnote">
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
} from '@contracts/electronApiScanCleanup';
import {
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN,
    SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES,
    SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES,
    SCAN_CLEANUP_MARGIN_MAX_MM,
} from '@contracts/electronApiScanCleanup';
import ScanCleanupAutoValueRow from '@app/modules/scan-cleanup/components/settings/ScanCleanupAutoValueRow.vue';
import ScanCleanupScopeSelector from '@app/modules/scan-cleanup/components/settings/ScanCleanupScopeSelector.vue';
import ScanCleanupSegmented from '@app/modules/scan-cleanup/components/ScanCleanupSegmented.vue';
import type {
    TScanCleanupOverrideControl,
    TScanCleanupSettingsScope,
} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import type {IScanCleanupMixedValue} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import type {
    TScanCleanupMarginSide,
    TScanCleanupMarginTarget,
} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';
import {SCAN_CLEANUP_MARGIN_SIDES} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';

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
    contentBoxes: IScanCleanupMixedValue<Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>>;
    customizedCounts: Record<TScanCleanupSettingsScope, number>;
    detectedSkewDegrees: number | undefined;
    excluded: IScanCleanupMixedValue<boolean>;
    hasScopeOverrides: boolean;
    highlightedScope: TScanCleanupSettingsScope | null;
    inclusionItems: ISelectItem[];
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
// Automatic dewarping replaces the detected content boxes with a reshaped
// page, so `ink` has nothing to anchor to and every output falls back to the
// top-centre position. Say so where the choice is made rather than letting the
// preview quietly disagree with the setting.
const placementHint = computed(() => {
    if (!props.settings.matchPageSize) {
        return t('scanCleanup.settings.enableMatchPageSize');
    }
    return !props.placementAlignment.mixed
        && props.placementAlignment.value === 'ink'
        && props.settings.autoDewarp === true
        ? t('scanCleanup.settings.inkNeedsContentBoxes')
        : '';
});
const resetOpen = ref(false);
const advancedOpen = ref(false);
const applyPageHintId = 'scan-cleanup-apply-page-hint';
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
const rotationModelValue = computed(() => props.rotation.mixed ? 'mixed' : String(props.rotation.value ?? 0));
const outputModeOverrideModelValue = computed(() => props.outputModeOverride.mixed
    ? 'mixed-values'
    : props.outputModeOverride.value ?? 'auto');
const inclusionModelValue = computed(() => props.excluded.mixed
    ? 'mixed'
    : props.excluded.value ? 'excluded' : 'included');
const hasContentBoxes = computed(() => props.contentBoxes.mixed
    || Object.keys(props.contentBoxes.value ?? {}).length > 0);
const manualSkewState = computed(() => props.manualSkew.mixed
    ? 'mixed'
    : props.manualSkew.value === undefined ? 'auto' : 'manual');
const manualSkewLabel = computed(() => t('scanCleanup.settings.manualSkew', {
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
const manualSkewHint = computed(() => !props.manualSkew.mixed
    && props.manualSkew.value === undefined
    && props.detectedSkewDegrees !== undefined
    ? t('scanCleanup.settings.detectedSkew', {angle: props.detectedSkewDegrees.toFixed(1)})
    : undefined);
const manualSplitState = computed(() => props.manualSplit.mixed
    ? 'mixed'
    : props.manualSplit.value === null ? 'auto' : 'manual');
const contentBoxesState = computed(() => props.contentBoxes.mixed
    ? 'mixed'
    : hasContentBoxes.value ? 'manual' : 'auto');
// Text thickness only affects bilevel output, but it keeps its place in the
// panel and disables instead of unmounting: switching B&W/gray/colour must not
// move the controls below it.
const thicknessApplies = computed(() => props.settings.preserveOriginalQuality !== true
    && (props.settings.outputMode === 'auto'
        || props.settings.outputMode === 'bw'
        || props.settings.outputMode === 'mixed'));
const autoDewarpDepthState = computed(() => props.settings.autoDewarpDepth === undefined ? 'auto' : 'manual');
const autoDewarpDepthDisabled = computed(() => props.settings.preserveOriginalQuality === true
    || !(props.settings.autoDewarp ?? false));
const resetLabel = computed(() => t(`scanCleanup.settings.resetScope.${props.scope}`));
const resetConfirmationBody = computed(() => t(`scanCleanup.settings.resetScope.${props.scope}Body`, {
    count: props.scope === 'selected' ? props.selectedCount : props.totalPages,
    page: props.pageNumber,
}));

function overrideCountTitle(count: number) {
    return t('scanCleanup.settings.overrideCount', {count});
}

function confirmReset() {
    emit('reset-scope-overrides');
    resetOpen.value = false;
}

function emitMargin(target: TScanCleanupMarginTarget, value: number | null | undefined) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        emit('update-margin', target, value);
    }
}

function handleMarginChange(target: TScanCleanupMarginSide, value: unknown) {
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
    if (nextValue !== props.margins.value?.[target]) {
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

.scan-cleanup-settings-scroll {
    min-height: 0;
    flex: 1;
    overflow: hidden auto;
    overscroll-behavior: contain;
    padding: var(--app-space-9xl);
}

.scan-cleanup-scope-area {
    display: grid;
    gap: var(--app-space-3xl);
    padding-block-end: var(--app-space-5xl);
}

.scan-cleanup-scope-reset {
    min-width: 0;
}

.scan-cleanup-advanced,
.scan-cleanup-advanced-content {
    display: grid;
}

.scan-cleanup-advanced-content {
    gap: var(--app-space-3xl);
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

.scan-cleanup-advanced-content {
    padding-top: var(--app-space-sm);
}

.scan-cleanup-apply-page-area {
    display: grid;
    gap: var(--app-space-sm);
}

.scan-cleanup-apply-page {
    width: 100%;
    justify-content: center;
}

.scan-cleanup-blank-detected-hint {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    line-height: var(--app-line-height-body);
}

.scan-cleanup-control-label,
.scan-cleanup-control-affordances {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--app-space-sm);
}

.scan-cleanup-control-label {
    flex-wrap: wrap;
}

.scan-cleanup-control-affordances {
    flex: none;
}

.scan-cleanup-override-marker {
    display: inline-flex;
    box-sizing: border-box;
    height: var(--app-scan-settings-affordance-height);
    align-items: center;
    gap: var(--app-space-sm);
    border-radius: var(--app-radius-full);
    background: color-mix(in srgb, var(--ui-primary) 16%, var(--ui-bg));
    padding-inline: var(--app-space-xl);
    color: var(--ui-primary);
    font-size: var(--app-text-size-kicker);
    font-weight: 700;
}

.scan-cleanup-override-marker > span {
    width: var(--app-space-3xl);
    height: var(--app-space-3xl);
    flex: none;
    border-radius: 50%;
    background: var(--ui-primary);
}
</style>
