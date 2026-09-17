import type {
    IScanCleanupManualZones,
    TScanCleanupPictureZoneLayer,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {MaybeRefOrGetter} from 'vue';
import {
    cloneScanCleanupZonePolygon,
    type IScanCleanupZoneSelection,
    type TScanCleanupZoneKind,
} from '@app/modules/scan-cleanup/geometry/zoneGeometry';

interface IUseScanCleanupZoneEditorOptions {
    editing: MaybeRefOrGetter<boolean | undefined>;
    manualZones: MaybeRefOrGetter<IScanCleanupManualZones | undefined>;
    pageNumber: MaybeRefOrGetter<number>;
    updateManualZones: (value: IScanCleanupManualZones) => void;
}

export const useScanCleanupZoneEditor = (options: IUseScanCleanupZoneEditorOptions) => {
    const selectedZone = ref<IScanCleanupZoneSelection | null>(null);
    const zoneKind = ref<TScanCleanupZoneKind>('picture');
    const zoneCount = computed(() => (toValue(options.manualZones)?.picture.length ?? 0)
        + (toValue(options.manualZones)?.fill.length ?? 0));
    const selectedPictureLayer = computed<TScanCleanupPictureZoneLayer | null>(() => {
        if (selectedZone.value?.kind !== 'picture') {
            return null;
        }
        return toValue(options.manualZones)?.picture[selectedZone.value.index]?.layer ?? null;
    });

    function updateSelectedPictureLayer(layer: TScanCleanupPictureZoneLayer) {
        if (selectedZone.value?.kind !== 'picture') {
            return;
        }
        const manualZones = toValue(options.manualZones);
        const next = {
            picture: (manualZones?.picture ?? []).map(zone => ({
                layer: zone.layer,
                polygon: cloneScanCleanupZonePolygon(zone.polygon),
            })),
            fill: (manualZones?.fill ?? []).map(cloneScanCleanupZonePolygon),
        };
        const zone = next.picture[selectedZone.value.index];
        if (!zone) {
            return;
        }
        next.picture[selectedZone.value.index] = {
            ...zone,
            layer,
        };
        options.updateManualZones(next);
    }

    watch([
        () => toValue(options.pageNumber),
        () => toValue(options.editing),
    ], () => {
        selectedZone.value = null;
    });
    watch(() => toValue(options.manualZones), (manualZones) => {
        const selection = selectedZone.value;
        if (!selection) {
            return;
        }
        const count = selection.kind === 'picture'
            ? manualZones?.picture.length ?? 0
            : manualZones?.fill.length ?? 0;
        if (selection.index >= count) {
            selectedZone.value = null;
        }
    }, {deep: true});

    return {
        selectedPictureLayer,
        selectedZone,
        updateSelectedPictureLayer,
        zoneCount,
        zoneKind,
    };
};
