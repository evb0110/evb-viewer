import type { TDocumentRef } from '@contracts/documentRef';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import { readBrowserDocumentBlob } from '@app/platform/browser-api/browserFilePickerAdapter';

// A document the browser stores has no folder of its own. In the Chrome
// extension, Show in folder saves the stored file to the Downloads folder
// through Chrome's downloads, then shows it there in the file manager. The
// same revision is saved once; a later click shows that download again.

interface IChromeDownloadItem {
    exists: boolean;
    state: string;
}

interface IChromeDownloadDelta {
    id: number;
    state?: {current?: string};
}

interface IChromeDownloadsApi {
    download(options: {
        url: string;
        filename: string;
        conflictAction: 'uniquify';
    }): Promise<number>;
    search(query: {id: number}): Promise<IChromeDownloadItem[]>;
    show(downloadId: number): void;
    onChanged: {
        addListener(listener: (delta: IChromeDownloadDelta) => void): void;
        removeListener(listener: (delta: IChromeDownloadDelta) => void): void;
    };
}

interface IDocumentDownload {
    id: number;
    revisionToken: string;
}

const COMPLETE = 'complete';
const INTERRUPTED = 'interrupted';
// Characters a file name on Windows, macOS or Linux cannot hold, which Chrome rejects.
const UNSAFE_FILE_NAME_CHARACTERS = /[\p{Cc}"*/:<>?\\|]/gu;

const downloadsByDocument = new Map<TDocumentRef, IDocumentDownload>();
// A click while a document is being saved waits for that save, so quick
// clicks never leave a second copy in Downloads.
const savesInProgress = new Map<TDocumentRef, Promise<boolean>>();

declare const chrome: {downloads?: IChromeDownloadsApi} | undefined;

// Extension pages have chrome.downloads; the website does not.
function getChromeDownloads(): IChromeDownloadsApi | null {
    return typeof chrome === 'object' && chrome !== null && typeof chrome.downloads?.download === 'function'
        ? chrome.downloads
        : null;
}

function toDownloadFileName(name: string) {
    return name.replaceAll(UNSAFE_FILE_NAME_CHARACTERS, '_').replaceAll(/^[\s.]+|[\s.]+$/gu, '') || 'document';
}

/** Resolves true once Chrome finished writing the download, false when it was interrupted. */
function waitForDownload(downloads: IChromeDownloadsApi, id: number) {
    return new Promise<boolean>((resolve, reject) => {
        const finish = (state: string | undefined) => {
            if (state !== COMPLETE && state !== INTERRUPTED) return;
            downloads.onChanged.removeListener(onChanged);
            resolve(state === COMPLETE);
        };
        const onChanged = (delta: IChromeDownloadDelta) => {
            if (delta.id === id) finish(delta.state?.current);
        };
        downloads.onChanged.addListener(onChanged);
        // The download may have finished before the listener was added.
        downloads.search({id}).then(([item]) => finish(item?.state), (error: unknown) => {
            downloads.onChanged.removeListener(onChanged);
            reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
}

async function isDownloadOnDisk(downloads: IChromeDownloadsApi, id: number) {
    const [item] = await downloads.search({id});
    return item?.exists === true && item.state === COMPLETE;
}

async function saveAndShowInDownloads(downloads: IChromeDownloadsApi, ref: TDocumentRef) {
    const {token: revisionToken} = await browserDocumentStore.getDocumentRevision(ref);
    const previous = downloadsByDocument.get(ref);
    if (previous?.revisionToken === revisionToken && await isDownloadOnDisk(downloads, previous.id)) {
        downloads.show(previous.id);
        return true;
    }
    const entry = await browserDocumentStore.requireEntry(ref);
    const {saveName} = await browserDocumentStore.getSaveTarget(ref);
    const href = URL.createObjectURL(await readBrowserDocumentBlob(ref, entry.mimeType));
    try {
        const id = await downloads.download({
            url: href,
            filename: toDownloadFileName(saveName),
            conflictAction: 'uniquify',
        });
        if (!await waitForDownload(downloads, id)) {
            return false;
        }
        downloadsByDocument.set(ref, {
            id,
            revisionToken,
        });
        downloads.show(id);
        return true;
    } finally {
        URL.revokeObjectURL(href);
    }
}

/**
 * Shows a stored document in the Downloads folder, saving its current
 * revision there first. False outside the Chrome extension or when Chrome
 * did not save the file.
 */
export function showBrowserDocumentInDownloads(ref: TDocumentRef) {
    const downloads = getChromeDownloads();
    if (!downloads) {
        return Promise.resolve(false);
    }
    const inProgress = savesInProgress.get(ref);
    if (inProgress) {
        return inProgress;
    }
    const save = saveAndShowInDownloads(downloads, ref).finally(() => savesInProgress.delete(ref));
    savesInProgress.set(ref, save);
    return save;
}
