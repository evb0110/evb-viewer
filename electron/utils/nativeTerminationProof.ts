/**
 * Termination is a request until something proves the target is gone. A process
 * group that outlives its kill, a `taskkill` that reports failure, and a
 * termination watchdog that fires before the tree is confirmed dead all leave
 * native readers holding the files the caller was about to reclaim.
 *
 * The layers that ask for termination cannot decide what to do about that; the
 * layer that owns the bytes can. So the outcome travels on the error the
 * termination produced, from the native adapter that observed it up to the
 * working-copy owner that would otherwise delete a directory a live child is
 * still reading.
 */
const UNPROVEN_NATIVE_TERMINATION = Symbol.for('evb.unprovenNativeTermination');

interface IUnprovenNativeTerminationCarrier {[UNPROVEN_NATIVE_TERMINATION]?: string | null;}

export function markUnprovenNativeTermination<T>(error: T, detail: string): T {
    if (typeof error === 'object' && error !== null) {
        const carrier = error as IUnprovenNativeTerminationCarrier;
        // First observation wins: the innermost adapter saw the process tree
        // itself, and re-labelling it from a wrapper would lose that detail.
        carrier[UNPROVEN_NATIVE_TERMINATION] ??= detail;
    }
    return error;
}

export function getUnprovenNativeTerminationDetail(error: unknown) {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }
    const detail = (error as IUnprovenNativeTerminationCarrier)[UNPROVEN_NATIVE_TERMINATION];
    return typeof detail === 'string' ? detail : undefined;
}

// A wrapper that drops the mark would let a cleanup owner delete files a native writer still uses,
// so every AggregateError built around failures goes through here and keeps the first mark among them.
export function aggregateErrorsKeepingUnprovenTermination(errors: readonly unknown[], message: string) {
    const aggregate = new AggregateError(errors, message);
    for (const error of errors) {
        const detail = getUnprovenNativeTerminationDetail(error);
        if (detail !== undefined) {
            return markUnprovenNativeTermination(aggregate, detail);
        }
    }
    return aggregate;
}
