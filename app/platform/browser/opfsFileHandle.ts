/**
 * The origin private file system's handle on the store file at `path` (a store port path). Readers in any
 * context take `getFile()` snapshots of it; a worker that creates a new file is that file's one writer.
 */
export async function opfsFileHandle(path: string, create = false) {
    const segments = path.split('/');
    let dir = await navigator.storage.getDirectory();
    for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
    return dir.getFileHandle(segments.at(-1)!, {create});
}
