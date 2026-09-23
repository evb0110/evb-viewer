import { useNow } from '@vueuse/core';
import type { MaybeRefOrGetter } from 'vue';
import { formatElapsedClock } from '@app/utils/progressFormatting';

/**
 * The elapsed time of the current stage while that stage has no count of its
 * own, so long work without a count still shows movement (behavior contract
 * I4). The clock restarts whenever the stage changes and is empty otherwise.
 */
export const useStageElapsedClock = <TStage extends string>(
    stage: MaybeRefOrGetter<TStage | null>,
    uncountedStages: ReadonlySet<TStage>,
) => {
    const now = useNow({interval: 1000});
    const startedAtMs = ref<number | null>(null);
    watch(() => toValue(stage), (next, previous) => {
        if (next !== previous) {
            startedAtMs.value = next === null ? null : Date.now();
        }
    }, {immediate: true});
    return computed(() => {
        const current = toValue(stage);
        if (current === null || startedAtMs.value === null || !uncountedStages.has(current)) {
            return '';
        }
        return formatElapsedClock(now.value.getTime() - startedAtMs.value);
    });
};
