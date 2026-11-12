/**
 * Bytes from outside the store: a file-system path (Node adapter) or a Blob/File (browser adapters).
 */
export type TExternalSource = string | Blob;

/**
 * The store's file system, rooted at the store root. Paths are `/`-separated and relative; parent
 * directories are created on demand. The core opens a path at most once at a time and closes a file before
 * removing it, because browser sync access handles are exclusive and block removal. Exclusivity across
 * windows is the caller's lock (the Electron main process, or a Web Lock per document directory).
 */
export interface IStorePort {
    /** Entry names in `dir`; empty when `dir` does not exist. */
    list(dir: string): Promise<string[]>;
    /** A whole small file; throws when it does not exist. */
    read(path: string): Promise<Uint8Array>;
    /** Replaces `path` with `bytes` all-or-nothing; durable when resolved. */
    writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
    /** Opens for reading and writing, creating a missing file; a created entry is durable when resolved. */
    open(path: string): Promise<IStoreFile>;
    /** Copies `source` to a new `path`, cloning where the platform can; durable when resolved. */
    copyIn(source: TExternalSource, path: string): Promise<void>;
    /** Copies the store file `from` to a new path `to`, as `copyIn` does. */
    copy(from: string, to: string): Promise<void>;
    /** Removes a file or a directory tree; a missing path is not an error. */
    remove(path: string): Promise<void>;
}

export interface IStoreFile {
    size(): Promise<number>;
    /** Returns fewer than `length` bytes only at the end of the file. */
    readAt(offset: number, length: number): Promise<Uint8Array>;
    /** Writes all of `bytes` or throws: a short write (a full browser store) is an error. */
    writeAt(offset: number, bytes: Uint8Array): Promise<void>;
    truncate(length: number): Promise<void>;
    /** Makes every write and truncation so far durable. */
    flush(): Promise<void>;
    close(): Promise<void>;
}
