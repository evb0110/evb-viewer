import {closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parentPort, workerData} from 'node:worker_threads';
import type {IDjvuPageSize} from '@contracts/electronApiDjvu';
import {createDjvuLibreEngine, type IDjvuLibreDocument, type TDjvuLibreModuleFactory} from '@djvu-core/djvuLibreEngine';
import type {IDjvuComponentDirectory, IDjvuDocInfo, IDjvuPageStructure, TDjvuPixelFormat} from '@djvu-core/djvuLibreTypes';
import {buildDjvuPageComponentMap} from '@djvu-core/djvuOutline';
import {encodePbmP4, encodePpmP6} from '@djvu-core/djvuPnm';
import {
    DJVU_MAX_COMPONENT_BYTES,
    parseDjvuPageHead,
    readDjvuSourceLayout,
    wrapDjvuComponentWithIffMagic,
    type IDjvuSourceLayout,
} from '@djvu-core/djvuSourceLayout';
import type {
    IDjvuEngineRenderToFileOptions,
    IDjvuEngineWorkerData,
    TDjvuEngineWorkerReply,
    TDjvuEngineWorkerRequest,
} from '@electron/features/djvu/main/djvuEngineProtocol';

const {engineDir} = workerData as IDjvuEngineWorkerData;
const MAX_CACHED_DOCS = 2;
const DIRM_TYPE_MASK = 0x3f;
const DIRM_PAGE_FLAG = 1;
const CHUNK_HEADER_BYTES = 8;

async function readBytes(filePath: string) {
    const buffer = await readFile(filePath);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

const engine = createDjvuLibreEngine({
    loadEngine: async () => {
        const [imported, module] = await Promise.all([
            import(pathToFileURL(join(engineDir, 'evb-djvulibre.mjs')).href) as Promise<{default: TDjvuLibreModuleFactory}>,
            readBytes(join(engineDir, 'evb-djvulibre.wasm')).then((bytes) => WebAssembly.compile(bytes)),
        ]);
        return {
            factory: imported.default,
            module,
        };
    },
});

interface IOpenDiskDjvuDoc {
    key: string;
    djvuPath: string;
    fd: number;
    fileSize: number;
    layout: IDjvuSourceLayout;
    doc: IDjvuLibreDocument;
    docInfo: IDjvuDocInfo;
    directory: IDjvuComponentDirectory | null;
    componentIndexByName: Map<string, number>;
    pageComponents: Map<string, number>;
    componentRevisions: Map<string, string> | null;
    close(): void;
}

const openDocs = new Map<string, IOpenDiskDjvuDoc>();

function readFdRangeSync(fd: number, offset: number, length: number): Uint8Array {
    const buffer = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
        const bytesRead = readSync(fd, buffer, totalRead, length - totalRead, offset + totalRead);
        if (bytesRead <= 0) {
            break;
        }
        totalRead += bytesRead;
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, totalRead);
}

function resolveSafeSiblingComponentPath(djvuPath: string, name: string): string | null {
    if (!name || name !== basename(name) || name === '.' || name === '..') {
        return null;
    }
    const parentDir = dirname(djvuPath);
    const candidate = resolve(parentDir, name);
    try {
        const realParent = realpathSync(parentDir);
        const realCandidate = realpathSync(candidate);
        const rel = relative(realParent, realCandidate);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
            return null;
        }
        return realCandidate;
    } catch {
        return null;
    }
}

function formatFileRevision(info: {dev?: number; ino?: number; size: number; mtimeMs: number}) {
    return `${info.dev ?? 0}:${info.ino ?? 0}:${info.size}:${info.mtimeMs}`;
}

function areIndirectComponentsUnchanged(entry: IOpenDiskDjvuDoc): boolean {
    if (!entry.componentRevisions) {
        return true;
    }
    for (const [siblingPath, expectedRevision] of entry.componentRevisions.entries()) {
        try {
            const current = statSync(siblingPath);
            if (formatFileRevision(current) !== expectedRevision) {
                return false;
            }
        } catch {
            return false;
        }
    }
    return true;
}

async function openDiskDjvuDocument(djvuPath: string): Promise<IOpenDiskDjvuDoc> {
    const fd = openSync(djvuPath, 'r');
    const fileStat = fstatSync(fd);
    const key = `${djvuPath}\u0000${formatFileRevision(fileStat)}`;
    const existing = openDocs.get(key);
    if (existing && areIndirectComponentsUnchanged(existing)) {
        try {
            closeSync(fd);
        } catch {
            // Ignore cleanup errors.
        }
        openDocs.delete(key);
        openDocs.set(key, existing);
        return existing;
    }

    // Close any stale revision of the same path before opening the new one.
    for (const [cachedKey, entry] of openDocs.entries()) {
        if (entry.djvuPath === djvuPath) {
            openDocs.delete(cachedKey);
            entry.close();
        }
    }
    while (openDocs.size >= MAX_CACHED_DOCS) {
        const oldestKey = openDocs.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }
        const oldest = openDocs.get(oldestKey);
        openDocs.delete(oldestKey);
        oldest?.close();
    }

    let doc: IDjvuLibreDocument | null = null;
    try {
        const fileSize = fileStat.size;
        const readRange = (offset: number, length: number) => Promise.resolve(readFdRangeSync(fd, offset, length));
        const componentRevisions = new Map<string, string>();
        const recordSiblingRevision = (
            siblingPath: string,
            info: {
                dev?: number;
                ino?: number;
                size: number;
                mtimeMs: number;
            },
        ) => {
            componentRevisions.set(siblingPath, formatFileRevision(info));
        };
        const componentFiles = {
            readComponent(name: string, length?: number) {
                const siblingPath = resolveSafeSiblingComponentPath(djvuPath, name);
                if (!siblingPath) {
                    return Promise.reject(new Error(`Indirect DjVu names a component outside its folder: ${name}`));
                }
                if (length !== undefined) {
                    const siblingFd = openSync(siblingPath, 'r');
                    try {
                        const siblingStat = fstatSync(siblingFd);
                        recordSiblingRevision(siblingPath, siblingStat);
                        const bytesToRead = Math.min(length, siblingStat.size);
                        if (bytesToRead > DJVU_MAX_COMPONENT_BYTES) {
                            return Promise.reject(
                                new RangeError(
                                    `DjVu component ${name} (${siblingStat.size} bytes) exceeds the ${DJVU_MAX_COMPONENT_BYTES}-byte limit`,
                                ),
                            );
                        }
                        return Promise.resolve(readFdRangeSync(siblingFd, 0, bytesToRead));
                    } finally {
                        closeSync(siblingFd);
                    }
                }
                const siblingStat = statSync(siblingPath);
                recordSiblingRevision(siblingPath, siblingStat);
                if (siblingStat.size > DJVU_MAX_COMPONENT_BYTES) {
                    return Promise.reject(
                        new RangeError(
                            `DjVu component ${name} (${siblingStat.size} bytes) exceeds the ${DJVU_MAX_COMPONENT_BYTES}-byte limit`,
                        ),
                    );
                }
                const bytes = readFileSync(siblingPath);
                return Promise.resolve(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
            },
        };
        const layout = await readDjvuSourceLayout({
            fileSize,
            readRange,
            componentFiles,
        });

        const componentIndexByName = new Map<string, number>();
        const readComponentSync = (name: string): Uint8Array | null | false => {
            if (layout.isIndirect) {
                const siblingPath = resolveSafeSiblingComponentPath(djvuPath, name);
                if (!siblingPath) {
                    return false;
                }
                let siblingStat;
                try {
                    siblingStat = statSync(siblingPath);
                } catch {
                    return false;
                }
                recordSiblingRevision(siblingPath, siblingStat);
                if (siblingStat.size > DJVU_MAX_COMPONENT_BYTES) {
                    throw new RangeError(
                        `DjVu component ${name} (${siblingStat.size} bytes) exceeds the ${DJVU_MAX_COMPONENT_BYTES}-byte limit`,
                    );
                }
                try {
                    const bytes = readFileSync(siblingPath);
                    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                } catch {
                    return false;
                }
            }
            const index = componentIndexByName.get(name);
            const offset = index === undefined ? undefined : layout.bundledOffsets?.[index];
            if (offset === undefined || offset < 16 || offset + CHUNK_HEADER_BYTES > fileSize) {
                return false;
            }
            const header = readFdRangeSync(fd, offset, CHUNK_HEADER_BYTES);
            if (
                header.byteLength < CHUNK_HEADER_BYTES ||
                header[0] !== 0x46 ||
                header[1] !== 0x4f ||
                header[2] !== 0x52 ||
                header[3] !== 0x4d
            ) {
                return false;
            }
            const formLen = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4);
            const totalLen = CHUNK_HEADER_BYTES + formLen;
            if (offset + totalLen > fileSize) {
                return false;
            }
            if (4 + totalLen > DJVU_MAX_COMPONENT_BYTES) {
                throw new RangeError(`DjVu component ${name} (${4 + totalLen} bytes) exceeds the ${DJVU_MAX_COMPONENT_BYTES}-byte limit`);
            }
            const payload = readFdRangeSync(fd, offset, totalLen);
            if (payload.byteLength !== totalLen) {
                return false;
            }
            return wrapDjvuComponentWithIffMagic(payload);
        };

        doc = await engine.openDocument({
            initBytes: layout.documentBytes,
            ...(layout.hasComponents ? {readComponentSync} : {}),
        });
        const docInfo = await doc.getDocInfo();
        const directory = await doc.getComponentDirectory();
        if (directory) {
            for (let index = directory.names.length - 1; index >= 0; index -= 1) {
                const name = directory.names[index];
                if (name) {
                    componentIndexByName.set(name, index);
                }
            }
        }
        // Also index by file.id and file.name so DjVuDocument URLs match either form.
        for (let index = docInfo.files.length - 1; index >= 0; index -= 1) {
            const file = docInfo.files[index];
            if (!file) {
                continue;
            }
            if (file.id) {
                componentIndexByName.set(file.id, index);
            }
            if (file.name && !componentIndexByName.has(file.name)) {
                componentIndexByName.set(file.name, index);
            }
        }

        const entry: IOpenDiskDjvuDoc = {
            key,
            djvuPath,
            fd,
            fileSize,
            layout,
            doc,
            docInfo,
            directory,
            componentIndexByName,
            pageComponents: buildDjvuPageComponentMap(docInfo.files),
            componentRevisions: layout.isIndirect ? componentRevisions : null,
            close() {
                doc?.close();
                try {
                    closeSync(fd);
                } catch {
                    // Ignore already-closed descriptors.
                }
            },
        };
        openDocs.set(key, entry);
        return entry;
    } catch (error) {
        doc?.close();
        try {
            closeSync(fd);
        } catch {
            // Ignore cleanup errors.
        }
        throw error;
    }
}

async function readPageSizesFast(entry: IOpenDiskDjvuDoc, pageNumbers?: readonly number[]): Promise<IDjvuPageSize[]> {
    const pageRequests = entry.directory
        ? entry.directory.flags.flatMap((flags, index) =>
              (flags & DIRM_TYPE_MASK) === DIRM_PAGE_FLAG
                  ? [
                        {
                            index,
                            name: entry.directory!.names[index] ?? '',
                        },
                    ]
                  : [],
          )
        : Array.from({length: Math.max(1, entry.docInfo.pageCount)}, (_, index) => ({
              index,
              name: '',
          }));
    if (pageRequests.length === 0) {
        return [];
    }
    const targetIndices = pageNumbers ? pageNumbers.map((pageNumber) => pageNumber - 1) : pageRequests.map((_, idx) => idx);
    const selectedRequests = targetIndices.map((idx) => {
        const req = pageRequests[idx];
        if (!req) {
            throw new RangeError(`Requested DjVu page ${idx + 1} is outside 1..${pageRequests.length}`);
        }
        return req;
    });
    const heads = await entry.layout.readComponentHeads(selectedRequests);
    const results: IDjvuPageSize[] = [];
    for (let pos = 0; pos < heads.length; pos += 1) {
        const pageNumber = targetIndices[pos]! + 1;
        const head = heads[pos]!;
        try {
            results.push(parseDjvuPageHead(head, pageNumber));
        } catch {
            // Fall back to full IFF page inspection for legacy forms whose INFO/BM44/PM44
            // chunk follows NDIR/ANTa or for OLD_INDEXED documents.
            const info = await entry.doc.getPageInfo(pageNumber);
            results.push({
                width: info.width,
                height: info.height,
                dpi: info.dpi,
            });
        }
    }
    return results;
}

function encodePgmP5(width: number, height: number, rgbBytes: Uint8Array): Uint8Array {
    const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
    const pixelCount = width * height;
    const output = new Uint8Array(header.byteLength + pixelCount);
    output.set(header, 0);
    for (let i = 0; i < pixelCount; i += 1) {
        const r = rgbBytes[i * 3] ?? 255;
        const g = rgbBytes[i * 3 + 1] ?? 255;
        const b = rgbBytes[i * 3 + 2] ?? 255;
        output[header.byteLength + i] = (5 * r + 9 * g + 2 * b) >> 4;
    }
    return output;
}

async function renderPageToNetpbmFile(
    entry: IOpenDiskDjvuDoc,
    pageNumber: number,
    outputPath: string,
    options: IDjvuEngineRenderToFileOptions,
) {
    let targetWidth = options.targetWidthPx;
    let targetHeight = options.targetHeightPx;
    if ((targetWidth === undefined || targetHeight === undefined) && options.subsample && options.subsample > 1) {
        const info = await entry.doc.getPageInfo(pageNumber);
        const sub = Math.max(1, Math.trunc(options.subsample));
        // Exact ddjvu -subsample=S formula: (dim + sub - 1) / sub
        targetWidth = Math.max(1, Math.ceil(info.width / sub));
        targetHeight = Math.max(1, Math.ceil(info.height / sub));
    }

    const pixelFormat: TDjvuPixelFormat = options.format === 'pbm' ? 'pbm' : 'rgb';
    const rendered = await entry.doc.renderPage(pageNumber, {
        mode: options.mode ?? 'color',
        pixelFormat,
        ...(targetWidth !== undefined && targetHeight !== undefined
            ? {
                  targetWidth,
                  targetHeight,
              }
            : {}),
    });

    const width = rendered.width;
    const height = rendered.height;
    let payload: Uint8Array;
    if (options.format === 'pbm') {
        const rowBytes = Math.ceil(width / 8);
        const bits = rendered.present && rendered.bytes.byteLength > 0 ? rendered.bytes : new Uint8Array(rowBytes * height);
        payload = encodePbmP4(width, height, bits);
    } else if (options.format === 'pgm') {
        const rgb = rendered.present && rendered.bytes.byteLength > 0 ? rendered.bytes : new Uint8Array(width * height * 3).fill(255);
        payload = encodePgmP5(width, height, rgb);
    } else {
        const rgb = rendered.present && rendered.bytes.byteLength > 0 ? rendered.bytes : new Uint8Array(width * height * 3).fill(255);
        payload = encodePpmP6(width, height, rgb);
    }
    await writeFile(outputPath, payload);
    return {
        width,
        height,
        present: rendered.present,
    };
}

async function handleRequest(request: TDjvuEngineWorkerRequest): Promise<unknown> {
    const entry = await openDiskDjvuDocument(request.djvuPath);
    switch (request.type) {
        case 'getDocInfo': {
            let sourceDpi = 300;
            try {
                const page1Sizes = await readPageSizesFast(entry, [1]);
                sourceDpi = page1Sizes[0]?.dpi ?? 300;
            } catch {
                try {
                    sourceDpi = (await entry.doc.getPageInfo(1)).dpi;
                } catch {
                    sourceDpi = 300;
                }
            }
            return {
                ...entry.docInfo,
                sourceDpi,
            };
        }
        case 'getPageInfo':
            return entry.doc.getPageInfo(request.pageNumber);
        case 'getPageSizes':
            return readPageSizesFast(entry, request.pageNumbers);
        case 'getPageStructures': {
            const pages = request.pageNumbers ? [...request.pageNumbers] : Array.from({length: entry.docInfo.pageCount}, (_, i) => i + 1);
            const structures: IDjvuPageStructure[] = [];
            for (const pageNumber of pages) {
                structures.push(await entry.doc.getPageStructure(pageNumber));
            }
            return structures;
        }
        case 'getOutline': {
            const raw = await entry.doc.getOutline();
            return {
                raw,
                pageComponents: Object.fromEntries(entry.pageComponents),
                pageCount: entry.docInfo.pageCount,
            };
        }
        case 'getMetadata':
            return entry.doc.getMetadata();
        case 'hasText':
            return entry.doc.hasText();
        case 'getPageText':
            return entry.doc.getPageText(request.pageNumber, {includeZones: request.includeZones});
        case 'renderPageToFile':
            return renderPageToNetpbmFile(entry, request.pageNumber, request.outputPath, request.options);
    }
}

let queue: Promise<void> = Promise.resolve();

parentPort!.on('message', (request: TDjvuEngineWorkerRequest) => {
    queue = queue.then(async () => {
        try {
            const result = await handleRequest(request);
            parentPort!.postMessage({
                id: request.id,
                ok: true,
                heapBytes: engine.getHeapBytes(),
                result,
            } satisfies TDjvuEngineWorkerReply);
        } catch (error) {
            parentPort!.postMessage({
                id: request.id,
                ok: false,
                heapBytes: engine.getHeapBytes(),
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof Error && error.name ? {errorName: error.name} : {}),
            } satisfies TDjvuEngineWorkerReply);
        }
    });
});
