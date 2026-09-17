<template>
    <aside class="zone-editor-controls" :aria-label="t('scanCleanup.zones.controlsLabel')">
        <div class="zone-editor-controls-row">
            <strong>{{ t('scanCleanup.zones.title') }}</strong>
            <ScanCleanupSegmented
                :model-value="zoneKind"
                :items="kindItems"
                :group-label="t('scanCleanup.zones.kindLabel')"
                @update:model-value="emit('update:zoneKind', $event as TScanCleanupZoneKind)"
            />
        </div>

        <p v-if="zoneCount === 0" class="zone-editor-hint">
            {{ t('scanCleanup.zones.emptyHint') }}
        </p>
        <p class="zone-editor-note">
            {{ t('scanCleanup.zones.mixedNote') }}
            <UButton
                v-if="outputMode !== 'mixed'"
                type="button"
                color="primary"
                variant="link"
                size="xs"
                :label="t('scanCleanup.zones.useMixedOutput')"
                @click="emit('use-mixed-output')"
            />
        </p>

        <details v-if="selectedLayer" class="zone-editor-advanced">
            <summary>{{ t('scanCleanup.zones.advanced.title') }}</summary>
            <UFormField :label="t('scanCleanup.zones.advanced.layerLabel')">
                <USelect
                    :model-value="selectedLayer"
                    :items="layerItems"
                    :aria-label="t('scanCleanup.zones.advanced.layerLabel')"
                    @update:model-value="updateLayer"
                />
            </UFormField>
            <p>{{ t('scanCleanup.zones.advanced.layerHint') }}</p>
        </details>
    </aside>
</template>

<script setup lang="ts">
import type {
    TScanCleanupOutputMode,
    TScanCleanupPictureZoneLayer,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import ScanCleanupSegmented from '@app/modules/scan-cleanup/components/ScanCleanupSegmented.vue';
import type {TScanCleanupZoneKind} from '@app/modules/scan-cleanup/geometry/zoneGeometry';

const {
    outputMode,
    selectedLayer,
    zoneCount,
    zoneKind,
} = defineProps<{
    outputMode: TScanCleanupOutputMode;
    selectedLayer: TScanCleanupPictureZoneLayer | null;
    zoneCount: number;
    zoneKind: TScanCleanupZoneKind;
}>();
const emit = defineEmits<{
    'update:selectedLayer': [value: TScanCleanupPictureZoneLayer];
    'update:zoneKind': [value: TScanCleanupZoneKind];
    'use-mixed-output': [];
}>();
const {t} = useTypedI18n();
const kindItems = computed(() => [
    {
        label: t('scanCleanup.zones.picture'),
        value: 'picture' as const,
    },
    {
        label: t('scanCleanup.zones.fill'),
        value: 'fill' as const,
    },
]);
const layerItems = computed(() => ([
    'eraser1',
    'painter2',
    'eraser3',
] as const).map(value => ({
    label: t(`scanCleanup.zones.advanced.layers.${value}`),
    value,
})));

function updateLayer(value: string | number) {
    if (value === 'eraser1' || value === 'painter2' || value === 'eraser3') {
        emit('update:selectedLayer', value);
    }
}
</script>

<style scoped>
.zone-editor-controls {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset-inline-start: var(--app-space-16xl);
    inset-block-start: var(--app-space-16xl);
    display: flex;
    width: min(
        var(--app-scan-zone-controls-width),
        calc(100% - var(--app-space-16xl) - var(--app-space-16xl))
    );
    flex-direction: column;
    gap: var(--app-space-5xl);
    border: var(--app-hairline-height) solid var(--ui-border);
    border-radius: var(--app-radius-lg);
    background: var(--ui-bg-elevated);
    box-shadow: var(--shadow-md);
    padding: var(--app-space-7xl);
}

.zone-editor-controls-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-7xl);
}

.zone-editor-hint,
.zone-editor-note,
.zone-editor-advanced p {
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.zone-editor-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--app-space-sm);
}

.zone-editor-advanced {
    border-block-start: var(--app-hairline-height) solid var(--ui-border);
    padding-block-start: var(--app-space-5xl);
}

.zone-editor-advanced summary {
    margin-block-end: var(--app-space-5xl);
    color: var(--ui-text-muted);
    cursor: pointer;
    font-size: var(--app-text-size-kicker);
}

.zone-editor-advanced p {
    margin-block-start: var(--app-space-5xl);
}
</style>
