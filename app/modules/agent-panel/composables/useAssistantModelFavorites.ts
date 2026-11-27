import {useLocalStorage} from '@vueuse/core';
import {STORAGE_KEYS} from '@app/constants/storageKeys';
import {modelPickerKey} from '@app/modules/agent-panel/utils/assistantModelPicker';

// One list for every picker, so a star set in one window shows in the next.
// Stored text is user-editable, so anything but a list of strings reads as no favorites.
const favorites = useLocalStorage<string[]>(STORAGE_KEYS.ASSISTANT_MODEL_FAVORITES, [], {
    serializer: {
        read: (raw) => {
            try {
                const value: unknown = JSON.parse(raw);
                return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
            } catch {
                return [];
            }
        },
        write: (value) => JSON.stringify(value),
    },
});

export function useAssistantModelFavorites() {
    const favoriteKeys = computed(() => new Set(favorites.value));
    function toggleFavorite(instanceId: string, modelId: string) {
        const key = modelPickerKey(instanceId, modelId);
        favorites.value = favoriteKeys.value.has(key) ? favorites.value.filter((item) => item !== key) : [...favorites.value, key];
    }
    return {
        favoriteKeys,
        toggleFavorite,
    };
}
