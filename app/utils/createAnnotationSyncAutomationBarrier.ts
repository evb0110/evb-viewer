import type { IAnnotationSyncAutomationActivity } from '@app/types/annotations';
import { isAutomationSession } from '@app/utils/isAutomationSession';

/**
 * Automation-only ledger of annotation comment sync progress.
 *
 * A sync reads the PDF.js editor layer synchronously and then awaits the parsed
 * PDF snapshot before it applies anything, so an automation client watching the
 * DOM or the canonical projection cannot tell a finished pass from one that is
 * still inside that await. The ledger gives it a real completion signal instead
 * of a timing guess: every requested sync has been serviced when
 * `servicedSeq >= requestSeq` with no running pass and no armed debounce.
 *
 * Every entry point is a no-op unless the renderer automation grant is
 * installed, so a production renderer neither allocates the ledger nor writes
 * to it.
 */
function readActivityLedger(): IAnnotationSyncAutomationActivity | null {
    if (!isAutomationSession()) {
        return null;
    }
    window.__evbAnnotationSyncActivity ??= {
        pendingDebounces: 0,
        requestSeq: 0,
        runningPasses: 0,
        servicedSeq: 0,
    };
    return window.__evbAnnotationSyncActivity;
}

/**
 * Creates one sync owner's view of the ledger. The armed-debounce flag is per
 * owner so a repeated schedule call cannot double-count a single timer and
 * leave the ledger busy forever.
 */
export function createAnnotationSyncAutomationBarrier() {
    let hasArmedDebounce = false;

    function setDebounceArmed(isArmed: boolean) {
        const activity = readActivityLedger();
        if (!activity || isArmed === hasArmedDebounce) {
            return;
        }
        hasArmedDebounce = isArmed;
        activity.pendingDebounces = isArmed
            ? activity.pendingDebounces + 1
            : Math.max(0, activity.pendingDebounces - 1);
    }

    return {
        /** Records a requested sync, debounced or immediate. */
        noteRequested() {
            const activity = readActivityLedger();
            if (activity) {
                activity.requestSeq += 1;
            }
        },
        /**
         * Marks every request up to `servicedSeq` as covered by a completed
         * pass. The caller reads the counter before the pass starts: a request
         * that arrives while it runs is not covered by that pass's editor scan
         * and has to trigger a rerun instead.
         */
        noteServiced(servicedSeq: number) {
            const activity = readActivityLedger();
            if (activity) {
                activity.servicedSeq = Math.max(activity.servicedSeq, servicedSeq);
            }
        },
        readRequestSeq() {
            return readActivityLedger()?.requestSeq ?? 0;
        },
        /** Reports an armed debounce timer, which keeps the ledger busy. */
        armDebounce() {
            setDebounceArmed(true);
        },
        releaseDebounce() {
            setDebounceArmed(false);
        },
        /**
         * Counts one sync pass as running for its whole duration, awaited PDF
         * snapshot included, so the ledger cannot read as idle mid-pass.
         */
        trackPass<TResult>(run: () => Promise<TResult>) {
            // The ledger this pass incremented is the one it has to decrement.
            // Re-reading on the way out can land on a different object, or on
            // none at all once the automation grant is gone, which would leave
            // the incremented ledger reading busy for good.
            const activity = readActivityLedger();
            if (activity) {
                activity.runningPasses += 1;
            }
            return run().finally(() => {
                if (activity) {
                    activity.runningPasses = Math.max(0, activity.runningPasses - 1);
                }
            });
        },
    };
}
