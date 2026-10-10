import {normalizePathForLookup} from '@electron/file-access/workingCopyStore';

const originalPathQueues = new Map<string, Promise<void>>();

/** Serializes check-and-replace sequences across distinct working copies/windows. */
export async function withOriginalPathMutationLock<T>(
    originalPath: string,
    operation: () => Promise<T>,
) {
    const key = normalizePathForLookup(originalPath) || originalPath;
    const previous = originalPathQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined).finally(() => {
        if (originalPathQueues.get(key) === tail) originalPathQueues.delete(key);
    });
    originalPathQueues.set(key, tail);
    return result;
}
