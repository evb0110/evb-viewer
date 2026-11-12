/**
 * Bytes from outside the store: a file-system path (Node adapter) or a Blob/File (browser adapters).
 */
export type TExternalSource = string | Blob;

/**
 * The store's file system, rooted at the store root. Paths are `/`-separated and relative; parent
 * directories are created on demand. The core opens a path at most once at a time and closes a file before
 * removing it, because browser sync access handles are exclusive and block removal. There is no rename.
 */
export interface IStorePort {
    /** Entry names in `dir`; empty when `dir` does not exist. */
    list(dir: string): Promise<string[]>;
    /** A whole small file; throws when it does not exist. */
    read(path: string): Promise<Uint8Array>;
    /** Replaces `path` with `bytes` all-or-nothing; durable when resolved. */
    writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
    /** `'write'` creates a missing file, and its directory entry is durable when resolved. */
    open(path: string, mode: 'read' | 'write'): Promise<IStoreFile>;
    /** Copies `source` to a new `path`, cloning where the platform can; durable when resolved. */
    copyIn(source: TExternalSource, path: string): Promise<void>;
    /** Removes a file or a directory tree; a missing path is not an error. */
    remove(path: string): Promise<void>;
}

export interface IStoreFile {
    size(): Promise<number>;
    /** Returns fewer than `length` bytes only at the end of the file. */
    readAt(offset: number, length: number): Promise<Uint8Array>;
    writeAt(offset: number, bytes: Uint8Array): Promise<void>;
    truncate(length: number): Promise<void>;
    /** Makes every write and truncation so far durable. */
    flush(): Promise<void>;
    close(): Promise<void>;
}
