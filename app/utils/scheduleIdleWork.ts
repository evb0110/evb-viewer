export interface IScheduleIdleWorkOptions {
    timeoutMs?: number;
}

export type TCancelIdleWork = () => void;

export function scheduleIdleWork(work: () => void | Promise<void>, options: IScheduleIdleWorkOptions = {}): TCancelIdleWork {
    let started = false;
    const run = () => {
        if (started) {
            return;
        }
        started = true;
        void work();
    };

    if (typeof window.requestIdleCallback === 'function') {
        const callbackId = window.requestIdleCallback(run, {timeout: options.timeoutMs ?? 1_000});
        return () => {
            if (!started) {
                window.cancelIdleCallback(callbackId);
            }
        };
    }

    const timeoutId = window.setTimeout(run, 0);
    return () => {
        if (!started) {
            window.clearTimeout(timeoutId);
        }
    };
}
