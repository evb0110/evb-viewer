import type {IBrowserDocumentEntry} from '@app/platform/browser/browserDocumentTypes';

/** Keeps the in-memory identity map for File System Access handles. */
export class BrowserDocumentFileHandleRefs {
    private readonly refs = new Map<FileSystemFileHandle, string>();

    public forget(ref: string) {
        for (const [
            handle,
            knownRef,
        ] of this.refs) {
            if (knownRef === ref) {
                this.refs.delete(handle);
            }
        }
    }

    public update(ref: string, handle: FileSystemFileHandle | null) {
        this.forget(ref);
        if (handle) {
            this.refs.set(handle, ref);
        }
    }

    public async findExistingRef(
        handle: FileSystemFileHandle,
        ensureEntry: (ref: string) => Promise<IBrowserDocumentEntry | null>,
    ) {
        let existingRef: string | null = null;
        for (const [
            knownHandle,
            ref,
        ] of this.refs) {
            let sameEntry = knownHandle === handle;
            if (!sameEntry) {
                try {
                    sameEntry = await knownHandle.isSameEntry?.(handle) ?? false;
                } catch {
                    sameEntry = false;
                }
            }
            if (!sameEntry) {
                try {
                    sameEntry = await handle.isSameEntry?.(knownHandle) ?? false;
                } catch {
                    sameEntry = false;
                }
            }
            if (!sameEntry) {
                continue;
            }
            if (await ensureEntry(ref)) {
                existingRef ??= ref;
            } else {
                this.refs.delete(knownHandle);
            }
        }
        return existingRef;
    }
}
