import {
    useIntervalFn,
    useNow,
} from '@vueuse/core';
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
    const {now, pause, resume} = useNow({
        controls: true,
        scheduler: callback => useIntervalFn(callback, 1000, {immediate: false}),
    });
    const startedAtMs = ref<number | null>(null);
    // The clock ticks only while a stage without a count is showing it.
    watch(() => toValue(stage), (next) => {
        startedAtMs.value = next === null ? null : Date.now();
        if (next !== null && uncountedStages.has(next)) {resume();}
        else {pause();}
    }, {immediate: true});
    return computed(() => {
        const current = toValue(stage);
        if (current === null || startedAtMs.value === null || !uncountedStages.has(current)) {
            return '';
        }
        return formatElapsedClock(now.value.getTime() - startedAtMs.value);
    });
};
