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

}
