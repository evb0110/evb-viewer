import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    truncate,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import esbuild from 'esbuild';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    TDjvuEngineWorkerReply,
    TDjvuEngineWorkerRequest,
} from '@electron/features/djvu/main/djvuEngineProtocol';
import {
    createDjvuLibreEngine,
    type IDjvuLibreEngine,
    type TDjvuLibreModuleFactory,
} from '@djvu-core/djvuLibreEngine';
import {
    DJVU_MAX_COMPONENT_BYTES,
    DJVU_MAX_INDEX_BYTES,
    DJVU_MAX_LEGACY_BUNDLED_BYTES,
    parseDjvuPageHead,
    readDjvuSourceLayout,
} from '@djvu-core/djvuSourceLayout';

const DJVU_TEST_TIMEOUT_MS = 60_000;

// Real 64x48 grayscale IW44 chunk generated via `c44 -slice 74` (major=0x81, minor=0x02).
const GRAY_IW44_64X48_HEX = (
    '004a81020040003000d73ea400d8ff0c512531a83b716987311217cde7bbdd0d1d22540ec56bdce8261ba885812ee8c379798541264c4894d005cd78594dd356584241bef2813bd279a856b6528b2ff36cb53e9447b8ad3bd840c6c9ca16cea85a9066444424228f8c5dd0e1cbb0e9c720804df67c634be978'
);

// Valid indirect FORM:DJVM DIRM index listing:
//   dict1.djvi (include), dict2.djvi (include), page1.djvu (page), page2.djvu (page)
const INDIRECT_DIRM_WITH_TWO_DICTS_HEX = (
    '41542654464f524d00000034444a564d4449524d00000028010004ffffc2bf8a21d8c882caf28d3943bb1f62b9520631be3be1f02240b555570e263f25300ffe'
);

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function asciiBytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

function makeChunk(id: string, payload: Uint8Array): Uint8Array {
    const padded = payload.byteLength + (payload.byteLength & 1);
    const out = new Uint8Array(8 + padded);
    out.set(asciiBytes(id), 0);
    new DataView(out.buffer).setUint32(4, payload.byteLength);
    out.set(payload, 8);
    return out;
}

function makeForm(formType: string, chunks: readonly Uint8Array[], includeMagic = true): Uint8Array {
    const body = concatBytes(chunks);
    const prefix = includeMagic ? asciiBytes('AT&T') : new Uint8Array(0);
    const header = new Uint8Array(12);
    header.set(asciiBytes('FORM'), 0);
    new DataView(header.buffer).setUint32(4, 4 + body.byteLength);
    header.set(asciiBytes(formType), 8);
    return concatBytes([
        prefix,
        header,
        body,
    ]);
}

function makeInfoChunk(width: number, height: number, dpi = 300): Uint8Array {
    const payload = new Uint8Array(10);
    const view = new DataView(payload.buffer);
    view.setUint16(0, width);
    view.setUint16(2, height);
    payload[4] = 24;
    payload[5] = 0;
    view.setUint16(6, dpi, true);
    payload[8] = 22;
    payload[9] = 1;
    return makeChunk('INFO', payload);
}

function extractFirstChunkPayload(djvuBytes: Uint8Array, chunkId: string): Uint8Array {
    const view = new DataView(djvuBytes.buffer, djvuBytes.byteOffset, djvuBytes.byteLength);
    let pos = 16;
    while (pos + 8 <= djvuBytes.byteLength) {
        const id = new TextDecoder('ascii').decode(djvuBytes.subarray(pos, pos + 4));
        const len = view.getUint32(pos + 4);
        if (id === chunkId) {
            return djvuBytes.slice(pos + 8, pos + 8 + len);
        }
        pos += 8 + len + (len & 1);
    }
    throw new Error(`Chunk ${chunkId} not found`);
}

function buildMalformedTextZoneTxta(zoneTypes: readonly number[]): Uint8Array {
    const text = asciiBytes('hello');
    const totalBytes = 3 + text.byteLength + 1 + (zoneTypes.length * 17);
    const buf = new Uint8Array(totalBytes);
    const view = new DataView(buf.buffer);
    // 24-bit text length
    buf[0] = (text.byteLength >>> 16) & 0xff;
    buf[1] = (text.byteLength >>> 8) & 0xff;
    buf[2] = text.byteLength & 0xff;
    buf.set(text, 3);
    let pos = 3 + text.byteLength;
    buf[pos++] = 1; // Zone::version
    for (let i = 0; i < zoneTypes.length; i += 1) {
        const isLast = i === zoneTypes.length - 1;
        buf[pos++] = zoneTypes[i]!;
        // x, y, width, height relative (for first node: x=0,y=0,w=100,h=100; for children: x=0,y=0,w=100,h=100)
        view.setUint16(pos, 0x8000);
        pos += 2;
        view.setUint16(pos, 0x8000);
        pos += 2;
        view.setUint16(pos, 0x8000 + 100);
        pos += 2;
        view.setUint16(pos, 0x8000 + 100);
        pos += 2;
        // text_start delta = 0
        view.setUint16(pos, 0x8000);
        pos += 2;
        // text_length = 5 (24-bit)
        buf[pos++] = 0;
        buf[pos++] = 0;
        buf[pos++] = text.byteLength;
        // children count = 1 (or 0 for leaf)
        buf[pos++] = 0;
        buf[pos++] = 0;
        buf[pos++] = isLast ? 0 : 1;
    }
    return makeChunk('TXTa', buf);
}

function buildDir0BundledDjvu(pages: ReadonlyArray<{
    name: string;
    formBytes: Uint8Array;
}>): Uint8Array {
    // Compute DIR0 payload size: 2 + sum(name.length + 1 + 1 + 4 + 4)
    const dir0BodySize = 2 + pages.reduce((sum, entry) => sum + asciiBytes(entry.name).byteLength + 10, 0);
    const dir0ChunkLen = 8 + dir0BodySize + (dir0BodySize & 1);
    let currentOffset = 16 + dir0ChunkLen;
    const offsets: number[] = [];
    const paddedPages: Uint8Array[] = [];
    for (const page of pages) {
        offsets.push(currentOffset);
        const paddedLen = page.formBytes.byteLength + (page.formBytes.byteLength & 1);
        const padded = new Uint8Array(paddedLen);
        padded.set(page.formBytes, 0);
        paddedPages.push(padded);
        currentOffset += paddedLen;
    }

    const dir0Payload = new Uint8Array(dir0BodySize);
    const dir0View = new DataView(dir0Payload.buffer);
    dir0View.setUint16(0, pages.length);
    let pos = 2;
    for (let i = 0; i < pages.length; i += 1) {
        const nameBytes = asciiBytes(pages[i]!.name);
        dir0Payload.set(nameBytes, pos);
        pos += nameBytes.byteLength;
        dir0Payload[pos++] = 0; // NUL
        dir0Payload[pos++] = 1; // iff_file = true
        dir0View.setUint32(pos, offsets[i]!);
        pos += 4;
        dir0View.setUint32(pos, pages[i]!.formBytes.byteLength);
        pos += 4;
    }
    const dir0Chunk = makeChunk('DIR0', dir0Payload);
    return makeForm('DJVM', [
        dir0Chunk,
        ...paddedPages,
    ], true);
}

describe('DjVuLibre WASM hardening (memory limits, text zones, legacy formats)', () => {
    let engine: IDjvuLibreEngine;
    let photoArtBytes: Uint8Array;
    let photoArtBg44: Uint8Array;
    let tempDir = '';

    beforeAll(async () => {
        photoArtBytes = new Uint8Array(await readFile(resolve('tests/fixtures/djvu/sources/photo-art.djvu')));
        photoArtBg44 = extractFirstChunkPayload(photoArtBytes, 'BG44');
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-wasm-hardening-'));
        engine = createDjvuLibreEngine({
            loadEngine: async () => {
                const [
                    imported,
                    wasmBytes,
                ] = await Promise.all([
                    import(pathToFileURL(resolve(process.cwd(), 'public/wasm/evb-djvulibre.mjs')).href) as Promise<{ default: TDjvuLibreModuleFactory }>,
                    readFile(resolve(process.cwd(), 'public/wasm/evb-djvulibre.wasm')),
                ]);
                return {
                    factory: imported.default,
                    module: await WebAssembly.compile(wasmBytes),
                };
            },
        });
    }, DJVU_TEST_TIMEOUT_MS);

    afterAll(async () => {
        engine?.dispose();
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    describe('Finding 1: byte limits, pre-decode raster checks, and dictionary cache eviction', () => {
        it('rejects oversized single-page DjVu before reading the full file', async () => {
            const fakeSize = DJVU_MAX_COMPONENT_BYTES + 4096;
            const header = new Uint8Array(16);
            header.set(asciiBytes('AT&TFORM'), 0);
            new DataView(header.buffer).setUint32(8, fakeSize - 12);
            header.set(asciiBytes('DJVU'), 12);

            const requestedLengths: number[] = [];
            const readRange = vi.fn(async (offset: number, length: number) => {
                requestedLengths.push(length);
                if (length > 4 * 1024 * 1024) {
                    throw new Error('Should never attempt to allocate full oversized file');
                }
                const buf = new Uint8Array(length);
                if (offset === 0) {
                    buf.set(header.subarray(0, Math.min(length, header.byteLength)), 0);
                }
                return buf;
            });

            await expect(readDjvuSourceLayout({
                fileSize: fakeSize,
                readRange,
            })).rejects.toThrow(RangeError);
            expect(requestedLengths.every(len => len <= 4 * 1024 * 1024)).toBe(true);
        });

        it('rejects oversized DIRM index chunks before reading them', async () => {
            const fakeSize = DJVU_MAX_INDEX_BYTES + 8192;
            const head = new Uint8Array(24);
            head.set(asciiBytes('AT&TFORM'), 0);
            new DataView(head.buffer).setUint32(8, fakeSize - 12);
            head.set(asciiBytes('DJVMDIRM'), 12);
            new DataView(head.buffer).setUint32(20, DJVU_MAX_INDEX_BYTES + 1024);

            const readRange = vi.fn(async (offset: number, length: number) => {
                if (length > 4 * 1024 * 1024) {
                    throw new Error('Should never attempt to read oversized DIRM');
                }
                const buf = new Uint8Array(length);
                if (offset < head.byteLength) {
                    buf.set(head.subarray(offset, Math.min(head.byteLength, offset + length)), 0);
                }
                return buf;
            });

            await expect(readDjvuSourceLayout({
                fileSize: fakeSize,
                readRange,
            })).rejects.toThrow(RangeError);
        });

        it('rejects oversized bundled components in readDjvuSourceLayout before full allocation', async () => {
            const componentOffset = 4_500_000;
            const oversizedFormBody = DJVU_MAX_COMPONENT_BYTES + 1024;
            const totalFileSize = componentOffset + 8 + oversizedFormBody + 64;

            // Minimal bundled DIRM with 1 component at componentOffset.
            const dirmData = new Uint8Array(3 + 4 + 1);
            dirmData[0] = 0x81;
            new DataView(dirmData.buffer).setUint16(1, 1);
            new DataView(dirmData.buffer).setUint32(3, componentOffset);
            const dirmChunk = makeChunk('DIRM', dirmData);
            const fileHeader = new Uint8Array(16 + dirmChunk.byteLength);
            fileHeader.set(asciiBytes('AT&TFORM'), 0);
            new DataView(fileHeader.buffer).setUint32(8, totalFileSize - 12);
            fileHeader.set(asciiBytes('DJVM'), 12);
            fileHeader.set(dirmChunk, 16);

            const compHeader = new Uint8Array(12);
            compHeader.set(asciiBytes('FORM'), 0);
            new DataView(compHeader.buffer).setUint32(4, oversizedFormBody);
            compHeader.set(asciiBytes('DJVU'), 8);

            const requestedLengths: number[] = [];
            const readRange = vi.fn(async (offset: number, length: number) => {
                requestedLengths.push(length);
                if (length > 4 * 1024 * 1024) {
                    throw new Error(`Oversized readRange should not be called (got ${length})`);
                }
                const out = new Uint8Array(length);
                if (offset < fileHeader.byteLength) {
                    const end = Math.min(fileHeader.byteLength, offset + length);
                    out.set(fileHeader.subarray(offset, end), 0);
                }
                const compStart = Math.max(offset, componentOffset);
                const compEnd = Math.min(offset + length, componentOffset + compHeader.byteLength);
                if (compStart < compEnd) {
                    out.set(compHeader.subarray(compStart - componentOffset, compEnd - componentOffset), compStart - offset);
                }
                return out;
            });

            const layout = await readDjvuSourceLayout({
                fileSize: totalFileSize,
                readRange,
            });
            await expect(layout.readComponent({
                index: 0,
                name: 'huge.djvu',
            })).rejects.toThrow(RangeError);
            expect(requestedLengths.every(len => len <= 4 * 1024 * 1024)).toBe(true);
        });

        it('rejects oversized indirect components before full read', async () => {
            const indexBytes = hexToBytes(INDIRECT_DIRM_WITH_TWO_DICTS_HEX);
            const hugeHeader = new Uint8Array(16);
            hugeHeader.set(asciiBytes('AT&TFORM'), 0);
            new DataView(hugeHeader.buffer).setUint32(8, DJVU_MAX_COMPONENT_BYTES + 2048);
            hugeHeader.set(asciiBytes('DJVU'), 12);

            const readComponentSpy = vi.fn(async (_name: string, length?: number) => {
                if (length === undefined || length > 1024) {
                    throw new Error(`Should not attempt full read of oversized indirect component (length=${length})`);
                }
                return hugeHeader.slice(0, Math.min(length, hugeHeader.byteLength));
            });

            const layout = await readDjvuSourceLayout({
                fileSize: indexBytes.byteLength,
                readRange: async (offset, length) => indexBytes.slice(offset, offset + length),
                componentFiles: { readComponent: readComponentSpy },
            });

            await expect(layout.readComponent({
                index: 2,
                name: 'page1.djvu',
            })).rejects.toThrow(RangeError);
            expect(readComponentSpy).toHaveBeenCalledWith('page1.djvu', 16);
        });

        it('rejects oversized native page dimensions before JB2/IW44 decode even for a small preview', async () => {
            // INFO claims 40000x40000 (1.6 GP > 128 MP) and Sjbz is intentionally corrupt.
            // If decode ran first, DjVuLibre would throw a JB2 decode error instead of RangeError.
            const corruptHugePage = makeForm('DJVU', [
                makeInfoChunk(40_000, 40_000, 300),
                makeChunk('Sjbz', new Uint8Array([
                    0xff,
                    0xfe,
                    0xfd,
                    0xfc,
                ])),
            ], true);

            const doc = await engine.openDocument({ initBytes: corruptHugePage });
            try {
                await expect(doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgba',
                    targetWidth: 200,
                    targetHeight: 200,
                })).rejects.toThrow(RangeError);
            } finally {
                doc.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);

        it('rejects oversized target raster dimensions before raster allocation', async () => {
            const doc = await engine.openDocument({ initBytes: photoArtBytes });
            try {
                await expect(doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgba',
                    targetWidth: 20_000,
                    targetHeight: 20_000,
                })).rejects.toThrow(RangeError);
            } finally {
                doc.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);

        it('still renders subsampled previews of huge-page.djvu cleanly', async () => {
            const hugeBytes = new Uint8Array(await readFile(resolve('tests/fixtures/djvu/sources/huge-page.djvu')));
            const doc = await engine.openDocument({ initBytes: hugeBytes });
            try {
                const rendered = await doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                    targetWidth: 400,
                    targetHeight: 320,
                });
                expect(rendered.present).toBe(true);
                expect(rendered.width).toBe(400);
                expect(rendered.height).toBe(320);
                expect(rendered.bytes.byteLength).toBe(400 * 320 * 3);
            } finally {
                doc.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);

        it('rejects oversized sync components in the bridge before WASM heap allocation', async () => {
            const indexBytes = hexToBytes(INDIRECT_DIRM_WITH_TWO_DICTS_HEX);
            const doc = await engine.openDocument({
                initBytes: indexBytes,
                readComponentSync: () => {
                    throw new RangeError('Component exceeds byte limit before disk read');
                },
            });
            try {
                await expect(doc.getPageInfo(1)).rejects.toThrow(RangeError);
            } finally {
                doc.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);

        it('evicts unpinned shared dictionary components under the 32 MiB cache budget', async () => {
            const indexBytes = hexToBytes(INDIRECT_DIRM_WITH_TWO_DICTS_HEX);
            // Each shared DJVI dictionary is ~18 MiB (individually < 32 MiB, combined 36 MiB > 32 MiB).
            const padBytes = new Uint8Array(18 * 1024 * 1024);
            const dict1Bytes = makeForm('DJVI', [makeChunk('PAD0', padBytes)], true);
            const dict2Bytes = makeForm('DJVI', [makeChunk('PAD0', padBytes)], true);
            const grayIw44 = hexToBytes(GRAY_IW44_64X48_HEX);
            const page1Bytes = makeForm('DJVU', [
                makeInfoChunk(64, 48, 300),
                makeChunk('INCL', asciiBytes('dict1.djvi')),
                makeChunk('BG44', grayIw44),
            ], true);
            const page2Bytes = makeForm('DJVU', [
                makeInfoChunk(64, 48, 300),
                makeChunk('INCL', asciiBytes('dict2.djvi')),
                makeChunk('BG44', grayIw44),
            ], true);

            const components = new Map<string, Uint8Array>([
                [
                    'dict1.djvi',
                    dict1Bytes,
                ],
                [
                    'dict2.djvi',
                    dict2Bytes,
                ],
                [
                    'page1.djvu',
                    page1Bytes,
                ],
                [
                    'page2.djvu',
                    page2Bytes,
                ],
            ]);
            const fetchCounts = new Map<string, number>();

            const doc = await engine.openDocument({
                initBytes: indexBytes,
                cacheBytes: 4 * 1024 * 1024,
                readComponentAsync: async (name) => {
                    fetchCounts.set(name, (fetchCounts.get(name) ?? 0) + 1);
                    const bytes = components.get(name);
                    if (!bytes) {
                        throw new Error(`Missing test component: ${name}`);
                    }
                    return bytes;
                },
            });
            try {
                const info = await doc.getDocInfo();
                expect(info.files.filter(file => file.type === 'include').map(file => file.id)).toEqual([
                    'dict1.djvi',
                    'dict2.djvi',
                ]);

                const r1 = await doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                });
                expect(r1.present).toBe(true);
                expect(fetchCounts.get('dict1.djvi')).toBe(1);

                const r2 = await doc.renderPage(2, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                });
                expect(r2.present).toBe(true);
                expect(fetchCounts.get('dict2.djvi')).toBe(1);

                // dict1.djvi was unpinned after page 1 finished and evicted when dict2.djvi pushed
                // providedBytes over the 32 MiB cache budget; rendering page 1 again must re-fetch it.
                const r1Again = await doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                });
                expect(r1Again.present).toBe(true);
                expect(fetchCounts.get('dict1.djvi')).toBe(2);
            } finally {
                doc.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);

        it('unpins and evicts an oversized cached page when a subsequent dictionary fetch rejects', async () => {
            const indexBytes = hexToBytes(INDIRECT_DIRM_WITH_TWO_DICTS_HEX);
            const padBytes = new Uint8Array(33 * 1024 * 1024);
            const hugePage1Bytes = makeForm('DJVU', [
                makeInfoChunk(64, 48, 300),
                makeChunk('INCL', asciiBytes('dict1.djvi')),
                makeChunk('PAD0', padBytes),
                makeChunk('BG44', hexToBytes(GRAY_IW44_64X48_HEX)),
            ], true);

            const fetchCounts = new Map<string, number>();
            const doc = await engine.openDocument({
                initBytes: indexBytes,
                cacheBytes: 4 * 1024 * 1024,
                readComponentAsync: async (name) => {
                    fetchCounts.set(name, (fetchCounts.get(name) ?? 0) + 1);
                    if (name === 'page1.djvu') {
                        return hugePage1Bytes;
                    }
                    throw new Error(`Missing dictionary ${name}`);
                },
            });
            try {
                await expect(doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                })).rejects.toThrow('Missing dictionary dict1.djvi');
                expect(fetchCounts.get('page1.djvu')).toBe(1);
                expect(fetchCounts.get('dict1.djvi')).toBe(1);

                // The 33 MiB page must have been unpinned and evicted when the fetch failed,
                // so a second attempt must re-fetch page1.djvu rather than keeping > 32 MiB resident.
                await expect(doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                })).rejects.toThrow('Missing dictionary dict1.djvi');
                expect(fetchCounts.get('page1.djvu')).toBe(2);
            } finally {
                doc.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);

        it('rejects >16 MiB BGjp JPEG layers with oversized SOF dimensions before decompression', async () => {
            // Minimal valid JPEG SOI + SOF0 (40000x40000) followed by >16 MiB padding so a
            // size-capped buffer scanner would miss it, while streaming SOF inspection catches it.
            const bgjpPayload = new Uint8Array(17 * 1024 * 1024);
            // SOI
            bgjpPayload[0] = 0xff;
            bgjpPayload[1] = 0xd8;
            // SOF0 marker (0xFFC0), segment length 11, precision 8, height 40000, width 40000
            bgjpPayload[2] = 0xff;
            bgjpPayload[3] = 0xc0;
            bgjpPayload[4] = 0x00;
            bgjpPayload[5] = 0x0b;
            bgjpPayload[6] = 0x08;
            bgjpPayload[7] = (40_000 >>> 8) & 0xff;
            bgjpPayload[8] = 40_000 & 0xff;
            bgjpPayload[9] = (40_000 >>> 8) & 0xff;
            bgjpPayload[10] = 40_000 & 0xff;
            bgjpPayload[11] = 0x01;
            const hugeJpegLayerPage = makeForm('DJVU', [
                makeInfoChunk(640, 480, 300),
                makeChunk('BGjp', bgjpPayload),
            ], true);

            const doc = await engine.openDocument({ initBytes: hugeJpegLayerPage });
            try {
                await expect(doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                    targetWidth: 200,
                    targetHeight: 150,
                })).rejects.toThrow(RangeError);
            } finally {
                doc.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);

        it('caps indirect component reads to the declared FORM length and rejects non-FORM siblings after 16 bytes', async () => {
            const indexBytes = hexToBytes(INDIRECT_DIRM_WITH_TWO_DICTS_HEX);
            const validSmallPage = makeForm('DJVU', [makeInfoChunk(64, 48, 300)], true);
            const requestedLengths: number[] = [];

            const layout = await readDjvuSourceLayout({
                fileSize: indexBytes.byteLength,
                readRange: async (offset, length) => indexBytes.slice(offset, offset + length),
                componentFiles: {
                    readComponent: async (name, length) => {
                        requestedLengths.push(length ?? -1);
                        if (name === 'page1.djvu') {
                            return validSmallPage.slice(0, length ?? validSmallPage.byteLength);
                        }
                        return new Uint8Array(Math.min(length ?? 16, 16)).fill(0x41);
                    },
                },
            });

            const small = await layout.readComponent({
                index: 2,
                name: 'page1.djvu',
            });
            expect(small.byteLength).toBe(validSmallPage.byteLength);
            expect(requestedLengths).toEqual([
                16,
                validSmallPage.byteLength,
            ]);

            requestedLengths.length = 0;
            await expect(layout.readComponent({
                index: 3,
                name: 'page2.djvu',
            })).rejects.toThrow('does not start with a valid FORM header');
            expect(requestedLengths).toEqual([16]);
        });
    });

    describe('Finding 2: malformed text zones reject cleanly without WASM stack overflow', () => {
        it.each([
            {
                label: 'deep chain of PAGE -> PAGE zones',
                zoneTypes: Array.from({ length: 5000 }, () => 1),
            },
            {
                label: 'deep chain of WORD -> WORD zones',
                zoneTypes: [
                    1,
                    ...Array.from({ length: 5000 }, () => 6),
                ],
            },
            {
                label: 'inverted WORD -> LINE hierarchy',
                zoneTypes: [
                    1,
                    6,
                    5,
                ],
            },
        ])('cleanly rejects $label on both pageHasText and getPageText without trapping WASM', async ({ zoneTypes }) => {
            const malformed = makeForm('DJVU', [
                makeInfoChunk(100, 100, 300),
                buildMalformedTextZoneTxta(zoneTypes),
            ], true);

            const doc = await engine.openDocument({ initBytes: malformed });
            try {
                await expect(doc.pageHasText(1)).rejects.toThrow(/corrupt_text|Failed to probe/iu);
                await expect(doc.getPageText(1, { includeZones: true })).rejects.toThrow(/corrupt_text|Failed to extract/iu);
                await expect(doc.getPageText(1, { includeZones: false })).rejects.toThrow(/corrupt_text|Failed to extract/iu);
            } finally {
                doc.close();
            }

            // Confirm the shared WASM instance did not trap and still renders valid documents.
            const healthy = await engine.openDocument({ initBytes: photoArtBytes });
            try {
                const pageInfo = await healthy.getPageInfo(1);
                expect(pageInfo.width).toBe(640);
                expect(pageInfo.height).toBe(480);
            } finally {
                healthy.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);
    });

    describe('Finding 3: legacy FORM:DJVM+DIR0, FORM:BM44, and FORM:PM44 support', () => {
        it('opens, inspects, and decodes standalone FORM:BM44 grayscale IW44 files (including with leading ANTa)', async () => {
            const bm44Bytes = makeForm('BM44', [
                makeChunk('ANTa', asciiBytes('(metadata (Title "BM44 with leading ANTa"))')),
                makeChunk('BM44', hexToBytes(GRAY_IW44_64X48_HEX)),
            ], true);
            const layout = await readDjvuSourceLayout({
                fileSize: bm44Bytes.byteLength,
                readRange: async (offset, length) => bm44Bytes.slice(offset, offset + length),
            });
            const [head] = await layout.readComponentHeads([{
                index: 0,
                name: '',
            }]);
            expect(parseDjvuPageHead(head!, 1)).toEqual({
                width: 64,
                height: 48,
                dpi: 100,
            });

            const doc = await engine.openDocument({ initBytes: layout.documentBytes });
            try {
                const docInfo = await doc.getDocInfo();
                expect(docInfo.pageCount).toBe(1);
                const pageInfo = await doc.getPageInfo(1);
                expect(pageInfo).toMatchObject({
                    width: 64,
                    height: 48,
                    dpi: 100,
                    rotation: 0,
                    pageType: 'photo',
                });
                const structure = await doc.getPageStructure(1);
                expect(structure.info).toEqual({
                    width: 64,
                    height: 48,
                    dpi: 100,
                });
                expect(structure.background).toMatchObject({
                    present: true,
                    kind: 'BM44',
                    width: 64,
                    height: 48,
                });
                const rendered = await doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                });
                expect(rendered.present).toBe(true);
                expect(rendered.width).toBe(64);
                expect(rendered.height).toBe(48);
                expect(rendered.bytes.byteLength).toBe(64 * 48 * 3);
            } finally {
                doc.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);

        it('opens, inspects, and decodes standalone FORM:PM44 color IW44 files', async () => {
            const pm44Bytes = makeForm('PM44', [makeChunk('PM44', photoArtBg44)], true);
            const layout = await readDjvuSourceLayout({
                fileSize: pm44Bytes.byteLength,
                readRange: async (offset, length) => pm44Bytes.slice(offset, offset + length),
            });
            const [head] = await layout.readComponentHeads([{
                index: 0,
                name: '',
            }]);
            expect(parseDjvuPageHead(head!, 1)).toEqual({
                width: 640,
                height: 480,
                dpi: 100,
            });

            const doc = await engine.openDocument({ initBytes: layout.documentBytes });
            try {
                const docInfo = await doc.getDocInfo();
                expect(docInfo.pageCount).toBe(1);
                const pageInfo = await doc.getPageInfo(1);
                expect(pageInfo).toMatchObject({
                    width: 640,
                    height: 480,
                    dpi: 100,
                    rotation: 0,
                    pageType: 'photo',
                });
                const structure = await doc.getPageStructure(1);
                expect(structure.info).toEqual({
                    width: 640,
                    height: 480,
                    dpi: 100,
                });
                expect(structure.background).toMatchObject({
                    present: true,
                    kind: 'PM44',
                    width: 640,
                    height: 480,
                });
                const rendered = await doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                });
                expect(rendered.present).toBe(true);
                expect(rendered.width).toBe(640);
                expect(rendered.height).toBe(480);
                expect(rendered.bytes.byteLength).toBe(640 * 480 * 3);
            } finally {
                doc.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);

        it('opens, inspects, and decodes legacy multi-page FORM:DJVM with DIR0', async () => {
            const page1Form = makeForm('DJVU', [
                makeInfoChunk(64, 48, 200),
                makeChunk('NDIR', asciiBytes('page1.djvu\npage2.pm44\n')),
                makeChunk('BG44', hexToBytes(GRAY_IW44_64X48_HEX)),
            ], false);
            const page2Form = makeForm('PM44', [makeChunk('PM44', photoArtBg44)], false);
            const dir0Bytes = buildDir0BundledDjvu([
                {
                    name: 'page1.djvu',
                    formBytes: page1Form,
                },
                {
                    name: 'page2.pm44',
                    formBytes: page2Form,
                },
            ]);

            const layout = await readDjvuSourceLayout({
                fileSize: dir0Bytes.byteLength,
                readRange: async (offset, length) => dir0Bytes.slice(offset, offset + length),
            });
            expect(layout.hasComponents).toBe(true);
            expect(layout.isIndirect).toBe(false);

            const doc = await engine.openDocument({ initBytes: layout.documentBytes });
            try {
                const docInfo = await doc.getDocInfo();
                expect(docInfo.docType).toBe('old-bundled');
                expect(docInfo.pageCount).toBe(2);
                expect(docInfo.files.map(file => file.id)).toEqual([
                    'page1.djvu',
                    'page2.pm44',
                ]);

                const directory = await doc.getComponentDirectory();
                expect(directory).toEqual({
                    names: [
                        'page1.djvu',
                        'page2.pm44',
                    ],
                    flags: [
                        1,
                        1,
                    ],
                });

                const heads = await layout.readComponentHeads([
                    {
                        index: 0,
                        name: 'page1.djvu',
                    },
                    {
                        index: 1,
                        name: 'page2.pm44',
                    },
                ]);
                expect(parseDjvuPageHead(heads[0]!, 1)).toEqual({
                    width: 64,
                    height: 48,
                    dpi: 200,
                });
                expect(parseDjvuPageHead(heads[1]!, 2)).toEqual({
                    width: 640,
                    height: 480,
                    dpi: 100,
                });

                const rendered1 = await doc.renderPage(1, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                });
                const rendered2 = await doc.renderPage(2, {
                    mode: 'color',
                    pixelFormat: 'rgb',
                });
                expect(rendered1).toMatchObject({
                    present: true,
                    width: 64,
                    height: 48,
                });
                expect(rendered2).toMatchObject({
                    present: true,
                    width: 640,
                    height: 480,
                });
            } finally {
                doc.close();
            }
        }, DJVU_TEST_TIMEOUT_MS);

        it('rejects oversized legacy DIR0 files before full allocation', async () => {
            const fakeSize = DJVU_MAX_LEGACY_BUNDLED_BYTES + 4096;
            const head = new Uint8Array(24);
            head.set(asciiBytes('AT&TFORM'), 0);
            new DataView(head.buffer).setUint32(8, fakeSize - 12);
            head.set(asciiBytes('DJVMDIR0'), 12);
            new DataView(head.buffer).setUint32(20, 32);

            const readRange = vi.fn(async (offset: number, length: number) => {
                if (length > 4 * 1024 * 1024) {
                    throw new Error('Should never attempt to read oversized DIR0 file');
                }
                const out = new Uint8Array(length);
                if (offset < head.byteLength) {
                    out.set(head.subarray(offset, Math.min(head.byteLength, offset + length)), 0);
                }
                return out;
            });

            await expect(readDjvuSourceLayout({
                fileSize: fakeSize,
                readRange,
            })).rejects.toThrow(RangeError);
        });

        it('handles oversized sparse indirect sibling files on disk without crashing', async () => {
            const dir = join(tempDir, 'oversized-indirect');
            const indexPath = join(dir, 'index.djvu');
            const hugeSiblingPath = join(dir, 'page1.djvu');
            const totalSiblingBytes = DJVU_MAX_COMPONENT_BYTES + 4096;
            await mkdir(dir, { recursive: true });
            await writeFile(indexPath, hexToBytes(INDIRECT_DIRM_WITH_TWO_DICTS_HEX));
            const hugeHeader = new Uint8Array(16);
            hugeHeader.set(asciiBytes('AT&TFORM'), 0);
            new DataView(hugeHeader.buffer).setUint32(8, totalSiblingBytes - 12);
            hugeHeader.set(asciiBytes('DJVU'), 12);
            await writeFile(hugeSiblingPath, hugeHeader);
            await truncate(hugeSiblingPath, totalSiblingBytes);

            const {
                closeSync,
                fstatSync,
                openSync,
                readSync,
                statSync,
            } = await import('node:fs');
            const fd = openSync(indexPath, 'r');
            try {
                const indexSize = fstatSync(fd).size;
                const layout = await readDjvuSourceLayout({
                    fileSize: indexSize,
                    readRange: async (offset, length) => {
                        const buf = Buffer.alloc(length);
                        const n = readSync(fd, buf, 0, length, offset);
                        return new Uint8Array(buf.buffer, buf.byteOffset, n);
                    },
                    componentFiles: {
                        async readComponent(name, length) {
                            const siblingPath = join(dir, name);
                            const st = statSync(siblingPath);
                            const bytesToRead = length === undefined ? st.size : Math.min(length, st.size);
                            if (bytesToRead > DJVU_MAX_COMPONENT_BYTES) {
                                throw new RangeError(`DjVu component ${name} exceeds limit`);
                            }
                            const sfd = openSync(siblingPath, 'r');
                            try {
                                const buf = Buffer.alloc(bytesToRead);
                                const n = readSync(sfd, buf, 0, bytesToRead, 0);
                                return new Uint8Array(buf.buffer, buf.byteOffset, n);
                            } finally {
                                closeSync(sfd);
                            }
                        },
                    },
                });
                await expect(layout.readComponent({
                    index: 2,
                    name: 'page1.djvu',
                })).rejects.toThrow(RangeError);
            } finally {
                closeSync(fd);
            }
        });
    });

    describe('Desktop worker end-to-end (djvuEngineWorker.ts)', () => {
        let workerPath = '';

        beforeAll(async () => {
            workerPath = join(tempDir, 'djvuEngineWorker.mjs');
            await esbuild.build({
                entryPoints: [resolve('electron/features/djvu/main/djvuEngineWorker.ts')],
                bundle: true,
                platform: 'node',
                format: 'esm',
                outfile: workerPath,
            });
        }, DJVU_TEST_TIMEOUT_MS);

        type TDjvuWorkerRequestPayload = TDjvuEngineWorkerRequest extends infer T
            ? T extends TDjvuEngineWorkerRequest ? Omit<T, 'id'> : never
            : never;

        async function withDesktopWorker<T>(run: (send: <TRes = unknown>(req: TDjvuWorkerRequestPayload) => Promise<TRes>) => Promise<T>): Promise<T> {
            const worker = new Worker(workerPath, {
                workerData: { engineDir: resolve('public/wasm') },
            });
            let nextId = 1;
            const pending = new Map<number, {
                resolve: (value: unknown) => void;
                reject: (error: Error) => void;
            }>();
            worker.on('message', (reply: TDjvuEngineWorkerReply) => {
                const entry = pending.get(reply.id);
                if (!entry) return;
                pending.delete(reply.id);
                if (reply.ok) {
                    entry.resolve(reply.result);
                } else {
                    const err = reply.errorName === 'RangeError'
                        ? new RangeError(reply.error)
                        : new Error(reply.error);
                    if (reply.errorName) err.name = reply.errorName;
                    entry.reject(err);
                }
            });
            const send = <TRes = unknown>(req: TDjvuWorkerRequestPayload) => new Promise<TRes>((resolvePromise, rejectPromise) => {
                const id = nextId++;
                pending.set(id, {
                    resolve: value => resolvePromise(value as TRes),
                    reject: rejectPromise,
                });
                worker.postMessage({
                    ...req,
                    id,
                });
            });
            try {
                return await run(send);
            } finally {
                await worker.terminate();
            }
        }

        it('opens, queries page sizes, and renders FORM:BM44, FORM:PM44, and FORM:DJVM+DIR0 files via the desktop worker', async () => {
            // BM44 with an ANTa chunk preceding BM44 exercises the worker's getPageInfo fallback path.
            const bm44Path = join(tempDir, 'legacy-gray.djvu');
            const bm44Bytes = makeForm('BM44', [
                makeChunk('ANTa', asciiBytes('(metadata (Title "Legacy BM44"))')),
                makeChunk('BM44', hexToBytes(GRAY_IW44_64X48_HEX)),
            ], true);
            await writeFile(bm44Path, bm44Bytes);

            const pm44Path = join(tempDir, 'legacy-color.djvu');
            const pm44Bytes = makeForm('PM44', [makeChunk('PM44', photoArtBg44)], true);
            await writeFile(pm44Path, pm44Bytes);

            const dir0Path = join(tempDir, 'legacy-dir0.djvu');
            const dir0Bytes = buildDir0BundledDjvu([
                {
                    name: 'p1.djvu',
                    formBytes: makeForm('DJVU', [
                        makeInfoChunk(64, 48, 200),
                        makeChunk('NDIR', asciiBytes('p1.djvu\np2.pm44\n')),
                        makeChunk('BG44', hexToBytes(GRAY_IW44_64X48_HEX)),
                    ], false),
                },
                {
                    name: 'p2.pm44',
                    formBytes: makeForm('PM44', [makeChunk('PM44', photoArtBg44)], false),
                },
            ]);
            await writeFile(dir0Path, dir0Bytes);

            await withDesktopWorker(async (send) => {
                const bm44Doc = await send<{
                    pageCount: number;
                    sourceDpi: number;
                }>({
                    type: 'getDocInfo',
                    djvuPath: bm44Path,
                });
                expect(bm44Doc.pageCount).toBe(1);
                expect(bm44Doc.sourceDpi).toBe(100);
                expect(await send({
                    type: 'getPageSizes',
                    djvuPath: bm44Path,
                })).toEqual([{
                    width: 64,
                    height: 48,
                    dpi: 100,
                }]);
                const bm44Out = join(tempDir, 'bm44.ppm');
                expect(await send({
                    type: 'renderPageToFile',
                    djvuPath: bm44Path,
                    pageNumber: 1,
                    outputPath: bm44Out,
                    options: { format: 'ppm' },
                })).toEqual({
                    width: 64,
                    height: 48,
                    present: true,
                });

                const pm44Doc = await send<{
                    pageCount: number;
                    sourceDpi: number;
                }>({
                    type: 'getDocInfo',
                    djvuPath: pm44Path,
                });
                expect(pm44Doc.pageCount).toBe(1);
                expect(pm44Doc.sourceDpi).toBe(100);
                expect(await send({
                    type: 'getPageSizes',
                    djvuPath: pm44Path,
                })).toEqual([{
                    width: 640,
                    height: 480,
                    dpi: 100,
                }]);
                const pm44Out = join(tempDir, 'pm44.ppm');
                expect(await send({
                    type: 'renderPageToFile',
                    djvuPath: pm44Path,
                    pageNumber: 1,
                    outputPath: pm44Out,
                    options: { format: 'ppm' },
                })).toEqual({
                    width: 640,
                    height: 480,
                    present: true,
                });

                const dir0Doc = await send<{
                    pageCount: number;
                    docType: string;
                    sourceDpi: number;
                }>({
                    type: 'getDocInfo',
                    djvuPath: dir0Path,
                });
                expect(dir0Doc.docType).toBe('old-bundled');
                expect(dir0Doc.pageCount).toBe(2);
                expect(dir0Doc.sourceDpi).toBe(200);
                expect(await send({
                    type: 'getPageSizes',
                    djvuPath: dir0Path,
                })).toEqual([
                    {
                        width: 64,
                        height: 48,
                        dpi: 200,
                    },
                    {
                        width: 640,
                        height: 480,
                        dpi: 100,
                    },
                ]);
                const dir0Out2 = join(tempDir, 'dir0-p2.ppm');
                expect(await send({
                    type: 'renderPageToFile',
                    djvuPath: dir0Path,
                    pageNumber: 2,
                    outputPath: dir0Out2,
                    options: { format: 'ppm' },
                })).toEqual({
                    width: 640,
                    height: 480,
                    present: true,
                });
            });
        }, DJVU_TEST_TIMEOUT_MS);

        it('rejects oversized indirect sibling components in the desktop worker before reading them', async () => {
            const dir = join(tempDir, 'worker-oversized-indirect');
            await mkdir(dir, { recursive: true });
            const indexPath = join(dir, 'index.djvu');
            const hugePagePath = join(dir, 'page1.djvu');
            await writeFile(indexPath, hexToBytes(INDIRECT_DIRM_WITH_TWO_DICTS_HEX));
            await writeFile(hugePagePath, makeForm('DJVU', [makeInfoChunk(64, 48, 300)], true));
            await truncate(hugePagePath, DJVU_MAX_COMPONENT_BYTES + 4096);

            await withDesktopWorker(async (send) => {
                await expect(send({
                    type: 'getPageInfo',
                    djvuPath: indexPath,
                    pageNumber: 1,
                })).rejects.toThrow(RangeError);

                // Worker remains alive and responsive after rejecting the oversized component.
                const healthyPath = join(dir, 'healthy.djvu');
                await writeFile(healthyPath, photoArtBytes);
                const info = await send<{ pageCount: number }>({
                    type: 'getDocInfo',
                    djvuPath: healthyPath,
                });
                expect(info.pageCount).toBe(1);
            });
        }, DJVU_TEST_TIMEOUT_MS);

        it('rejects oversized bundled components in the desktop worker before reading them', async () => {
            const dir = join(tempDir, 'worker-oversized-bundled');
            await mkdir(dir, { recursive: true });
            const bundledPath = join(dir, 'oversized-bundled.djvu');

            // Construct a real bundled FORM:DJVM from searchable-mixed-dpi.djvu, but enlarge
            // the first component's FORM size header past DJVU_MAX_COMPONENT_BYTES on a sparse file.
            const baseBundled = new Uint8Array(await readFile(resolve('tests/fixtures/djvu/sources/searchable-mixed-dpi.djvu')));
            const dirmLen = new DataView(baseBundled.buffer, baseBundled.byteOffset, baseBundled.byteLength).getUint32(20);
            const firstCompOffset = new DataView(baseBundled.buffer, baseBundled.byteOffset, baseBundled.byteLength).getUint32(27);
            const oversizedFormLen = DJVU_MAX_COMPONENT_BYTES + 1024;
            const totalSize = firstCompOffset + 8 + oversizedFormLen + 64;
            expect(dirmLen).toBeGreaterThan(0);

            const patchedPrefix = new Uint8Array(baseBundled);
            const view = new DataView(patchedPrefix.buffer);
            view.setUint32(8, totalSize - 12);
            view.setUint32(firstCompOffset + 4, oversizedFormLen);
            await writeFile(bundledPath, patchedPrefix);
            await truncate(bundledPath, totalSize);

            await withDesktopWorker(async (send) => {
                await expect(send({
                    type: 'getPageInfo',
                    djvuPath: bundledPath,
                    pageNumber: 1,
                })).rejects.toThrow(RangeError);
            });
        }, DJVU_TEST_TIMEOUT_MS);
    });
});
