import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {
    abortErrorFromSignal,
    createAbortError,
} from '@electron/utils/abort';
import type {
    IXlargeSearchIndexBuildOptions,
    IXlargeSearchIndexBuildProgress,
    IXlargeSearchIndexBuildResult,
} from '@electron/features/search/xlargeIndexBuilder';
export interface IXlargeSearchBuildRequest extends Omit<IXlargeSearchIndexBuildOptions, 'onProgress' | 'signal'> {
    onProgress?: (progress: IXlargeSearchIndexBuildProgress) => void | Promise<void>;
    signal?: AbortSignal;
}

interface IXlargeSearchBuildFlight {
    controller: AbortController;
    promise: Promise<IXlargeSearchIndexBuildResult>;
    waiterCount: number;
    progressListeners: Set<(progress: IXlargeSearchIndexBuildProgress) => void | Promise<void>>;
}

const inFlightXlargeSearchBuilds = new Map<string, IXlargeSearchBuildFlight>();

function getBuildKey(pdfPath: string, documentRevision: TDocumentRevisionToken) {
    return `${pdfPath}\0${documentRevision}`;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

async function publishProgress(
    flight: IXlargeSearchBuildFlight,
    progress: IXlargeSearchIndexBuildProgress,
) {
    // A progress observer belongs to one request. Its cancellation or a
    // renderer teardown must not abort the shared writer or another observer.
    await Promise.allSettled(Array.from(flight.progressListeners, listener => (
        Promise.resolve().then(() => listener(progress))
    )));
}

function createBuildFlight(options: IXlargeSearchBuildRequest, key: string) {
    const controller = new AbortController();
    const flight: IXlargeSearchBuildFlight = {
        controller,
        promise: Promise.resolve().then(async () => {
            const {buildXlargeSearchIndex} = await import('@electron/features/search/xlargeIndexBuilder');
            const buildOptions: IXlargeSearchIndexBuildOptions = {
                ...options,
                signal: controller.signal,
                onProgress: progress => publishProgress(flight, progress),
            };
            return buildXlargeSearchIndex(buildOptions);
        }),
        waiterCount: 0,
        progressListeners: new Set(),
    };
    const cleanup = () => {
        if (inFlightXlargeSearchBuilds.get(key) === flight) {
            inFlightXlargeSearchBuilds.delete(key);
        }
    };
    void flight.promise.then(cleanup, cleanup);
    inFlightXlargeSearchBuilds.set(key, flight);
    return flight;
}

function removeBuildFlight(flight: IXlargeSearchBuildFlight) {
    for (const [
        key,
        candidate,
    ] of inFlightXlargeSearchBuilds) {
        if (candidate === flight) {
            inFlightXlargeSearchBuilds.delete(key);
            return;
        }
    }
}

function waitForBuild(
    flight: IXlargeSearchBuildFlight,
    signal: AbortSignal | undefined,
    onProgress: IXlargeSearchBuildRequest['onProgress'],
) {
    throwIfAborted(signal);
    flight.waiterCount += 1;
    const progressListener = onProgress === undefined
        ? undefined
        : (progress: IXlargeSearchIndexBuildProgress) => onProgress(progress);
    if (progressListener) {
        flight.progressListeners.add(progressListener);
    }

    let released = false;
    const release = (abortWhenOrphaned: boolean) => {
        if (released) {
            return;
        }
        released = true;
        flight.waiterCount = Math.max(0, flight.waiterCount - 1);
        if (progressListener) {
            flight.progressListeners.delete(progressListener);
        }
        if (
            abortWhenOrphaned
            && flight.waiterCount === 0
            && !flight.controller.signal.aborted
        ) {
            removeBuildFlight(flight);
            flight.controller.abort(signal ? abortErrorFromSignal(signal) : createAbortError());
        }
    };

    return new Promise<IXlargeSearchIndexBuildResult>((resolve, reject) => {
        const handleAbort = () => {
            release(true);
            reject(signal ? abortErrorFromSignal(signal) : createAbortError());
        };
        if (signal) {
            signal.addEventListener('abort', handleAbort, {once: true});
        }
        flight.promise.then(
            result => {
                release(false);
                signal?.removeEventListener('abort', handleAbort);
                resolve(result);
            },
            error => {
                release(false);
                signal?.removeEventListener('abort', handleAbort);
                reject(error);
            },
        );
        if (signal?.aborted) {
            handleAbort();
        }
    });
}

/**
 * Build a streaming sidecar once per path and revision. Each caller owns its
 * cancellation signal, while the underlying writer remains alive for all
 * remaining callers.
 */
export function ensureXlargeSearchIndex(options: IXlargeSearchBuildRequest) {
    throwIfAborted(options.signal);
    const key = getBuildKey(options.pdfPath, options.documentRevision);
    const flight = inFlightXlargeSearchBuilds.get(key) ?? createBuildFlight(options, key);
    return waitForBuild(flight, options.signal, options.onProgress);
}

export function resetXlargeSearchIndexBuilds(reason = 'Search index cache reset') {
    const error = new Error(reason);
    const flights = Array.from(inFlightXlargeSearchBuilds.values());
    inFlightXlargeSearchBuilds.clear();
    for (const flight of flights) {
        flight.controller.abort(error);
    }
}
