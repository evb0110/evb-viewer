import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';

import {detectDjvuHasText} from '@electron/features/djvu/main/textSearch';
import {
    abortErrorFromSignal,
    createAbortError,
} from '@electron/utils/abort';

interface ITextCapabilityCacheEntry {
    fingerprint: string;
    hasText: boolean;
}

interface ITextCapabilityTask {
    abortController: AbortController;
    consumers: number;
    promise: Promise<boolean>;
    settled: boolean;
}

const DJVU_TEXT_CAPABILITY_CACHE_MAX_ENTRIES = 64;

const cachedCapabilitiesByPath = new Map<string, ITextCapabilityCacheEntry>();
const inFlightTasksByFingerprint = new Map<string, ITextCapabilityTask>();

async function getFileFingerprint(filePath: string) {
    const fileStat = await stat(filePath, {bigint: true});
    return [
        fileStat.dev,
        fileStat.ino,
        fileStat.size,
        fileStat.mtimeNs,
        fileStat.ctimeNs,
    ].join(':');
}

function getCachedCapability(normalizedPath: string, fingerprint: string) {
    const cached = cachedCapabilitiesByPath.get(normalizedPath);
    if (!cached) {
        return undefined;
    }
    if (cached.fingerprint !== fingerprint) {
        cachedCapabilitiesByPath.delete(normalizedPath);
        return undefined;
    }

    // A delete/reinsert makes this Map a bounded least-recently-used cache.
    cachedCapabilitiesByPath.delete(normalizedPath);
    cachedCapabilitiesByPath.set(normalizedPath, cached);
    return cached.hasText;
}

function cacheCapability(
    normalizedPath: string,
    fingerprint: string,
    hasText: boolean,
) {
    cachedCapabilitiesByPath.delete(normalizedPath);
    cachedCapabilitiesByPath.set(normalizedPath, {
        fingerprint,
        hasText,
    });
    while (cachedCapabilitiesByPath.size > DJVU_TEXT_CAPABILITY_CACHE_MAX_ENTRIES) {
        const oldestPath = cachedCapabilitiesByPath.keys().next().value;
        if (!oldestPath) {
            return;
        }
        cachedCapabilitiesByPath.delete(oldestPath);
    }
}

function createTextCapabilityTask(
    normalizedPath: string,
    fingerprint: string,
    taskKey: string,
) {
    const abortController = new AbortController();
    const task: ITextCapabilityTask = {
        abortController,
        consumers: 0,
        promise: Promise.resolve(false),
        settled: false,
    };
    const scanPromise = detectDjvuHasText(normalizedPath, abortController.signal)
        .then(async (hasText) => {
            // Do not publish a result produced while the source was being replaced.
            // The current caller may still use it, but the next request must rescan.
            const finalFingerprint = await getFileFingerprint(normalizedPath).catch(() => null);
            if (finalFingerprint === fingerprint) {
                cacheCapability(normalizedPath, fingerprint, hasText);
            }
            return hasText;
        });
    task.promise = scanPromise.then(
        (hasText) => {
            task.settled = true;
            if (inFlightTasksByFingerprint.get(taskKey) === task) {
                inFlightTasksByFingerprint.delete(taskKey);
            }
            return hasText;
        },
        (error: unknown) => {
            task.settled = true;
            if (inFlightTasksByFingerprint.get(taskKey) === task) {
                inFlightTasksByFingerprint.delete(taskKey);
            }
            throw error;
        },
    );
    inFlightTasksByFingerprint.set(taskKey, task);
    return task;
}

async function consumeTextCapabilityTask(
    task: ITextCapabilityTask,
    signal?: AbortSignal,
) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }

    task.consumers += 1;
    let handleAbort: (() => void) | undefined;
    const abortPromise = signal
        ? new Promise<never>((_resolve, reject) => {
            handleAbort = () => reject(abortErrorFromSignal(signal));
            signal.addEventListener('abort', handleAbort, {once: true});
        })
        : null;
    try {
        return await (abortPromise
            ? Promise.race([
                task.promise,
                abortPromise,
            ])
            : task.promise);
    } finally {
        if (signal && handleAbort) {
            signal.removeEventListener('abort', handleAbort);
        }
        task.consumers -= 1;
        if (task.consumers === 0 && !task.settled) {
            task.abortController.abort(createAbortError('DjVu text capability scan canceled'));
        }
    }
}

export async function getCachedDjvuHasText(filePath: string, signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }

    const normalizedPath = resolve(filePath);
    const fingerprint = await getFileFingerprint(normalizedPath);
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }

    const cached = getCachedCapability(normalizedPath, fingerprint);
    if (cached !== undefined) {
        return cached;
    }

    const taskKey = `${normalizedPath}\0${fingerprint}`;
    let task = inFlightTasksByFingerprint.get(taskKey);
    if (task?.abortController.signal.aborted) {
        inFlightTasksByFingerprint.delete(taskKey);
        task = undefined;
    }
    task ??= createTextCapabilityTask(normalizedPath, fingerprint, taskKey);
    return consumeTextCapabilityTask(task, signal);
}
