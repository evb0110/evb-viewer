import {
    contentOf,
    contentWitness,
    sameWitness,
} from '@document-store/contentWitness';
import type {
    IPublicationPort,
    IPublishSource,
} from '@document-store/documentDirectory';
import { fileHandleStore } from '@app/platform/browser/browserFileHandleStore';
import { runBrowserLock } from '@app/platform/browser/runBrowserLock';

const HANDLE_PREFIX = 'handle:';
const DOWNLOAD_PREFIX = 'download:';
const PUBLISH_CHUNK_BYTES = 4 * 1024 * 1024;
const PUBLISH_LOCK = 'evb-viewer:browser-publish';

/** A destination that is a file the person picked: Save writes it through its handle. */
export const handleDestination = (key: string) => `${HANDLE_PREFIX}${key}`;
/** A destination with no readable file: Save downloads the bytes again under this name. */
export const downloadDestination = (fileName: string) => `${DOWNLOAD_PREFIX}${fileName}`;

export function handleKeyOf(destination: string | null) {
    return destination?.startsWith(HANDLE_PREFIX) ? destination.slice(HANDLE_PREFIX.length) : null;
}

export function destinationFileName(destination: string | null) {
    return destination?.startsWith(DOWNLOAD_PREFIX) ? destination.slice(DOWNLOAD_PREFIX.length) : null;
}

const handles = new Map<string, FileSystemFileHandle>();

export function rememberFileHandle(key: string, handle: FileSystemFileHandle) {
    handles.set(key, handle);
}

/** Keeps `handle` for `key` across reloads too, for recovery and Recent Files. */
export async function storeFileHandle(key: string, handle: FileSystemFileHandle) {
    handles.set(key, handle);
    await fileHandleStore.put(key, {handle, name: handle.name}).catch(() => undefined);
}

export async function resolveFileHandle(key: string) {
    const known = handles.get(key);
    if (known) return known;
    const stored = await fileHandleStore.get(key);
    if (stored) handles.set(key, stored.handle);
    return stored?.handle ?? null;
}

async function requireFileHandle(destination: string) {
    const key = handleKeyOf(destination);
    const handle = key === null ? null : await resolveFileHandle(key);
    if (!handle) throw new Error(`No file is known for ${destination}`);
    return handle;
}

function blobWitness(blob: Blob) {
    return contentWitness(blob.size, async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()));
}

/** A picked file's metadata fact, its size and modification time, in the form desktop files use. Reading it reads no bytes. */
export const fileFact = (file: File) => `file-v1:${file.size}:${BigInt(file.lastModified) * 1_000_000n}`;

/** The published bytes a chunk at a time, each an ArrayBuffer of its own, as file writers and Blobs take them. */
async function* sourceChunks(source: IPublishSource) {
    for (let offset = 0; offset < source.length; offset += PUBLISH_CHUNK_BYTES) {
        const chunk = await source.file.readAt(offset, Math.min(PUBLISH_CHUNK_BYTES, source.length - offset));
        yield chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength && chunk.buffer instanceof ArrayBuffer
            ? chunk.buffer
            : chunk.slice().buffer;
    }
}

/** The published bytes as a Blob whose parts the browser may keep on disk; no single buffer holds them. */
export async function publishSourceBlob(source: IPublishSource, type: string) {
    const parts: Blob[] = [];
    for await (const chunk of sourceChunks(source)) parts.push(new Blob([chunk]));
    return new Blob(parts, {type});
}

/** Dispatching the anchor publishes the download; nothing can take it back. */
export function downloadBlob(blob: Blob, fileName: string) {
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

/**
 * Where browser documents are saved. With a handle: check the file's size and modification time against the
 * baseline, then `createWritable`, write, `close`. A file's witness is that metadata, so opening or checking it
 * never reads it; recovery asks for its content too. Without a handle: a download, whose dispatch is the
 * receipt, so the dispatched bytes become the baseline. The caller asked for write permission before taking the
 * document's lock; nothing here prompts.
 */
export const browserPublication: IPublicationPort = {
    async witness(destination, content) {
        if (handleKeyOf(destination) === null) return null;
        const file = await (await requireFileHandle(destination)).getFile();
        return content ? `${fileFact(file)} ${await blobWitness(file)}` : fileFact(file);
    },
    async source(destination) {
        return (await requireFileHandle(destination)).getFile();
    },
    async publish(destination, source, expected, stage) {
        const witness = contentOf(source.witness) ?? await contentWitness(source.length, (offset, length) => source.file.readAt(offset, length));
        const fileName = destinationFileName(destination);
        if (fileName !== null) {
            await stage(witness);
            downloadBlob(await publishSourceBlob(source, 'application/pdf'), fileName);
            return {status: 'published', witness};
        }
        const handle = await requireFileHandle(destination);
        // Two documents can name one file (it was opened twice). Every publication to a file takes one lock, so
        // the check sees what another document's save wrote.
        return runBrowserLock(PUBLISH_LOCK, async () => {
            if (expected !== null && !sameWitness(fileFact(await handle.getFile()), expected)) return {status: 'conflict'} as const;
            await stage(witness);
            const writable = await handle.createWritable();
            try {
                for await (const chunk of sourceChunks(source)) await writable.write(chunk);
            } catch (error) {
                await writable.abort().catch(() => undefined);
                throw error;
            }
            await writable.close();
            return {status: 'published', witness: `${fileFact(await handle.getFile())} ${witness}`} as const;
        });
    },
};
