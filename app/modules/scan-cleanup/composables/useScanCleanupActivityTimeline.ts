import type {Ref} from 'vue';
import type {
    IScanCleanupActivity,
    TScanCleanupActivityStep,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupActivity';

export interface IScanCleanupActivityStepTiming {
    startedAtMs: number;
    endedAtMs?: number;
}

export interface IScanCleanupActivityTimeline {
    startedAtMs: number;
    steps: Partial<Record<TScanCleanupActivityStep, IScanCleanupActivityStepTiming>>;
}

/**
 * When each step of the current activity started and finished, as this
 * renderer observed it. A step first seen already done has no timing: it
 * finished before the activity was being watched, and a zero duration would
 * misreport it. The record ends with the activity.
 */
export const useScanCleanupActivityTimeline = (
    activity: Readonly<Ref<IScanCleanupActivity | null>>,
    now: () => number = Date.now,
) => {
    const timeline = shallowRef<IScanCleanupActivityTimeline | null>(null);
    watch(activity, next => {
        if (next === null) {
            timeline.value = null;
            return;
        }
        const at = now();
        const current = timeline.value;
        const steps: IScanCleanupActivityTimeline['steps'] = {};
        let changed = current === null;
        for (const step of next.steps) {
            const timing = current?.steps[step.id];
            if (step.state === 'active' && (timing === undefined || timing.endedAtMs !== undefined)) {
                steps[step.id] = {startedAtMs: at};
                changed = true;
            } else if (step.state === 'done' && timing !== undefined && timing.endedAtMs === undefined) {
                steps[step.id] = {
                    ...timing,
                    endedAtMs: at,
                };
                changed = true;
            } else if (step.state === 'waiting' && timing !== undefined) {
                // Analysis started over, as a re-detect does: the step's old
                // timing no longer describes it.
                changed = true;
            } else if (timing !== undefined) {
                steps[step.id] = timing;
            }
        }
        if (changed) {
            timeline.value = {
                startedAtMs: current?.startedAtMs ?? at,
                steps,
            };
        }
    }, {immediate: true});
    return timeline;
};
