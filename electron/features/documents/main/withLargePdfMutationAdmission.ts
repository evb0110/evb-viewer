import {abortErrorFromSignal} from '@electron/utils/abort';

export const LARGE_PDF_MUTATION_THRESHOLD_BYTES = 512 * 1024 * 1024;

/**
 * One operation runs and one waits. A third caller is told so immediately
 * rather than joining a line whose wait nobody can predict: each admitted
 * mutation is a multi-minute native parse over half a gigabyte or more.
 */
export const LARGE_PDF_MUTATION_QUEUE_LIMIT = 1;

interface ILargePdfMutationEntry {
    readonly operation: (signal: AbortSignal) => Promise<unknown>;
    readonly signal: AbortSignal;
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason?: unknown) => void;
    removeAbortListener: () => void;
}

let activeLargePdfMutation: ILargePdfMutationEntry | null = null;
const queuedLargePdfMutations: ILargePdfMutationEntry[] = [];

function startNextLargePdfMutation() {
    if (activeLargePdfMutation) {
        return;
    }
    const entry = queuedLargePdfMutations.shift();
    if (!entry) {
        return;
    }
    entry.removeAbortListener();
    if (entry.signal.aborted) {
        entry.reject(abortErrorFromSignal(entry.signal));
        startNextLargePdfMutation();
        return;
    }

    activeLargePdfMutation = entry;
    const finish = () => {
        activeLargePdfMutation = null;
        startNextLargePdfMutation();
    };
    // The signal goes into the operation rather than only racing against it.
    // Racing leaves the native work running and the lane still occupied, which
    // is what made the head of the queue uncancellable.
    void Promise.resolve()
        .then(() => entry.operation(entry.signal))
        .then(entry.resolve, entry.reject)
        .then(finish, finish);
}

/** Keeps eager native parsers for separate large documents from overlapping. */
export function withLargePdfMutationAdmission<T>(
    sourceBytes: number,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    if (sourceBytes <= LARGE_PDF_MUTATION_THRESHOLD_BYTES) {
        return operation(signal);
    }
    if (signal.aborted) {
        return Promise.reject(abortErrorFromSignal(signal));
    }
    if (queuedLargePdfMutations.length >= LARGE_PDF_MUTATION_QUEUE_LIMIT) {
        return Promise.reject(new Error(
            `Large PDF mutation queue is full (maximum ${String(LARGE_PDF_MUTATION_QUEUE_LIMIT)} queued operation)`,
        ));
    }

    return new Promise<T>((resolve, reject) => {
        const entry: ILargePdfMutationEntry = {
            operation: operation,
            signal,
            resolve: value => resolve(value as T),
            reject,
            removeAbortListener: () => undefined,
        };
        const handleAbort = () => {
            const index = queuedLargePdfMutations.indexOf(entry);
            if (index === -1) {
                return;
            }
            queuedLargePdfMutations.splice(index, 1);
            entry.removeAbortListener();
            reject(abortErrorFromSignal(signal));
        };
        entry.removeAbortListener = () => signal.removeEventListener('abort', handleAbort);
        signal.addEventListener('abort', handleAbort, {once: true});
        queuedLargePdfMutations.push(entry);
        startNextLargePdfMutation();
    });
}
