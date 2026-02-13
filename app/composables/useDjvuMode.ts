import {
    computed,
    ref,
} from 'vue';

type TDjvuDisabledFeature =
    | 'save'
    | 'saveAs'
    | 'annotations'
    | 'pageDelete'
    | 'pageInsert'
    | 'pageRotate'
    | 'pageReorder'
    | 'pageExtract'
    | 'undo'
    | 'redo';

const DJVU_DISABLED_FEATURES = new Set<TDjvuDisabledFeature>([
    'save',
    'saveAs',
    'annotations',
    'pageDelete',
    'pageInsert',
    'pageRotate',
    'pageReorder',
    'pageExtract',
    'undo',
    'redo',
]);

export const useDjvuMode = () => {
    const isDjvuMode = ref(false);
    const djvuSourcePath = ref<string | null>(null);
    const djvuTempPdfPath = ref<string | null>(null);
    const djvuDisabledFeatures = computed(() => DJVU_DISABLED_FEATURES);

    function isDjvuFeatureDisabled(feature: TDjvuDisabledFeature) {
        return isDjvuMode.value && DJVU_DISABLED_FEATURES.has(feature);
    }

    function enterDjvuMode(sourcePath: string, tempPdfPath: string) {
        isDjvuMode.value = true;
        djvuSourcePath.value = sourcePath;
        djvuTempPdfPath.value = tempPdfPath;
    }

    function exitDjvuMode() {
        isDjvuMode.value = false;
        djvuSourcePath.value = null;
        djvuTempPdfPath.value = null;
    }

    return {
        isDjvuMode,
        djvuSourcePath,
        djvuTempPdfPath,
        djvuDisabledFeatures,
        isDjvuFeatureDisabled,
        enterDjvuMode,
        exitDjvuMode,
    };
};
