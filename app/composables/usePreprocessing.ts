import {
    ref,
    computed,
} from 'vue';
import { getElectronAPI } from 'app/utils/electron';

interface IPreprocessingCapabilities {
    valid: boolean;
    available: string[];
    missing: string[];
}

interface IPreprocessingState {
    enabled: boolean;
    capabilities: IPreprocessingCapabilities | null;
    loading: boolean;
    error: string | null;
}

export const usePreprocessing = () => {
    const state = ref<IPreprocessingState>({
        enabled: false,
        capabilities: null,
        loading: false,
        error: null,
    });

    const isPreprocessingAvailable = computed(() => {
        return state.value.capabilities?.valid ?? false;
    });

    const availableTools = computed(() => {
        return state.value.capabilities?.available ?? [];
    });

    const missingTools = computed(() => {
        return state.value.capabilities?.missing ?? [];
    });

    async function validatePreprocessingSetup() {
        state.value.loading = true;
        state.value.error = null;

        try {
            const electronAPI = getElectronAPI();
            const result = await electronAPI.preprocessing.validate();

            state.value.capabilities = {
                valid: result.valid,
                available: result.available ?? [],
                missing: result.missing ?? [],
            };

            return result.valid;
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            state.value.error = errMsg;
            state.value.capabilities = {
                valid: false,
                available: [],
                missing: [
                    'unpaper',
                    'leptonica',
                ],
            };
            return false;
        } finally {
            state.value.loading = false;
        }
    }

    async function preprocessPage(imageData: number[], usePreprocessing = true) {
        try {
            state.value.error = null;

            if (!usePreprocessing) {
                return {
                    success: true,
                    imageData,
                    message: 'Preprocessing disabled',
                };
            }

            if (!isPreprocessingAvailable.value) {
                return {
                    success: false,
                    imageData,
                    error: `Preprocessing not available. Missing: ${missingTools.value.join(', ')}`,
                };
            }

            const electronAPI = getElectronAPI();
            const result = await electronAPI.preprocessing.preprocessPage(
                imageData,
                true,
            );

            if (!result.success) {
                state.value.error = result.error ?? null;
            }

            return result;
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            state.value.error = errMsg;
            return {
                success: false,
                imageData,
                error: errMsg,
            };
        }
    }

    function setPreprocessingEnabled(enabled: boolean) {
        state.value.enabled = enabled && isPreprocessingAvailable.value;
    }

    return {
        // State
        enabled: computed(() => state.value.enabled),
        loading: computed(() => state.value.loading),
        error: computed(() => state.value.error),

        // Computed
        isPreprocessingAvailable,
        availableTools,
        missingTools,
        capabilities: computed(() => state.value.capabilities),

        // Methods
        validatePreprocessingSetup,
        preprocessPage,
        setPreprocessingEnabled,
    };
};
