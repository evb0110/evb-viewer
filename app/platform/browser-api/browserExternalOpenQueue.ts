import type { TDocumentRef } from '@contracts/documentRef';
import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';

// Documents handed to the page from outside it, such as a PDF the Chrome
// extension redirected here. They can arrive before the workspace listens,
// so they wait for the first listener, as desktop's file-open events wait
// for the renderer.
const pendingPaths: TDocumentRef[][] = [];
const listeners = new Set<(paths: TDocumentRef[]) => void>();

export function openBrowserExternalPaths(paths: TDocumentRef[]) {
    if (listeners.size === 0) {
        pendingPaths.push(paths);
        return;
    }
    for (const listener of [...listeners]) {
        listener(paths);
    }
}

export function onBrowserExternalPaths(callback: (paths: TDocumentRef[]) => void): TMenuEventUnsubscribe {
    listeners.add(callback);
    for (const paths of pendingPaths.splice(0)) {
        callback(paths);
    }
    return () => {
        listeners.delete(callback);
    };
}
