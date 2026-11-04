import type {TDocumentRef} from '@contracts/documentRef';

type TBrowserWorkingCopyCloseListener = (ref: TDocumentRef) => Promise<void> | void;

const listeners = new Set<TBrowserWorkingCopyCloseListener>();

/**
 * Work that reads an open document (a detection over it, the evidence kept
 * for it) ends when the document's working copy closes, as desktop operations
 * registered against a working copy are canceled on its close.
 */
export function onBrowserWorkingCopyClose(listener: TBrowserWorkingCopyCloseListener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Ends every piece of work that reads the working copy, before its records are cleaned up. */
export async function closeBrowserWorkingCopyWork(ref: TDocumentRef) {
    await Promise.allSettled([...listeners].map(async listener => listener(ref)));
}
