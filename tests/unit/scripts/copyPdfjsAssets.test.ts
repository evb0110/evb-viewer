import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface ICopyPdfjsAssetsModule {
    copyPdfjsAssets: (options?: {
        root?: string;
        targetRoot?: string;
    }) => Promise<void>;
    minifyPdfjsWorker: (source: string) => Promise<string>;
    PDFJS_WORKER_MAX_BYTES: number;
    PDFJS_WORKER_MAX_LINES: number;
    readPdfjsPackageVersion: (root?: string) => Promise<string>;
    writePdfjsVersionStamp: (options?: {
        root?: string;
        targetRoot?: string;
    }) => Promise<string>;
}

const {
    copyPdfjsAssets,
    minifyPdfjsWorker,
    PDFJS_WORKER_MAX_BYTES,
    PDFJS_WORKER_MAX_LINES,
    readPdfjsPackageVersion,
    writePdfjsVersionStamp,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/copy-pdfjs-assets.mjs')).href
) as ICopyPdfjsAssetsModule;

describe('copy-pdfjs-assets', () => {
    it('minifies the patched worker without dropping its sparse-read behavior', async () => {
        const source = `/** worker license */
/** worker version */
class MissingDataException extends Error {}
class Stream {
    constructor(...args) {
        this.args = args;
    }
}
class ChunkedStream extends Stream {
    _storedChunks = new Map();
    constructor(length, chunkSize, manager) {
        super(new Uint8Array(0), 0, 0, null);
        this.end = length;
        this.chunkSize = chunkSize;
        this.manager = manager;
    }
    _storeBytes(begin, bytes) {
        this._storedChunks.set(begin, bytes);
    }
    _getStoredByte(pos) {
        const bytes = this._storedChunks.get(0);
        if (!bytes) {
            throw new MissingDataException(pos, pos + 1);
        }
        return bytes[pos];
    }
    _getStoredRange(begin, end) {
        const bytes = this._storedChunks.get(0);
        if (!bytes) {
            throw new MissingDataException(begin, end);
        }
        return bytes.subarray(begin, end);
    }
    getByteRange(begin, end) {
        return this._getStoredRange(begin, end);
    }
    discardChunksBefore(position) {
        for (const chunk of this._storedChunks.keys()) {
            if (chunk < position) {
                this._storedChunks.delete(chunk);
            }
        }
    }
    clone() {
        function ChunkedStreamClone() {}
        ChunkedStreamClone.prototype = Object.create(this);
        const clone = new ChunkedStreamClone();
        clone.pos = clone.start = this.start;
        clone.end = this.end;
        return clone;
    }
}
class NetworkPdfManager {}
function indexObjectsBounded(stream, scanWindowBytes) {
    let position = stream.start;
    while (position < stream.end) {
        stream.getByteRange(position, Math.min(position + scanWindowBytes, stream.end));
        stream.discardChunksBefore(position + scanWindowBytes);
        position += scanWindowBytes;
    }
    return true;
}
function sendRange(pdfStream, begin, end) {
    const rangeReader = pdfStream.getRangeReader(begin, end);
    let nextBegin = begin;
    let receivedBytes = 0;
    return rangeReader.read().then(({value, done}) => {
        if (done) {
            return;
        }
        receivedBytes += value.byteLength;
        nextBegin += value.byteLength;
        return {begin: nextBegin, receivedBytes};
    });
}
export {
    ChunkedStream,
    NetworkPdfManager,
    indexObjectsBounded,
    sendRange,
};
`;
        const minifiedSource = await minifyPdfjsWorker(source);
        const minifiedBody = minifiedSource.replace(
            /^(?:\/\*\*[\s\S]*?\*\/\s*)+/u,
            '',
        );

        for (const marker of [
            'ChunkedStreamClone',
            '_storedChunks',
            '_storeBytes',
            '_getStoredByte',
            '_getStoredRange',
            'discardChunksBefore',
            'indexObjectsBounded',
            'receivedBytes',
        ]) {
            expect(minifiedSource).toContain(marker);
        }
        expect(minifiedSource).not.toContain('PDF.js xref recovery is disabled for range-backed documents above 16 MiB');
        expect(minifiedBody).not.toMatch(/\n\s{2,}/u);
        expect(Buffer.byteLength(minifiedSource, 'utf8')).toBeLessThan(PDFJS_WORKER_MAX_BYTES);
        expect(minifiedSource.split(/\r?\n/u).length).toBeLessThanOrEqual(PDFJS_WORKER_MAX_LINES);
    });

    it('copies a bounded minified patched worker asset', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-pdfjs-assets-'));
        const pdfjsRoot = path.join(tempRoot, 'node_modules', 'pdfjs-dist');
        const targetRoot = path.join(tempRoot, 'public', 'pdf');
        const workerSource = `/** worker license */
/** worker version */
class ChunkedStream {
    _storedChunks = new Map();
    clone() {
        function ChunkedStreamClone() {}
        return new ChunkedStreamClone();
    }
    discardChunksBefore(position) {
        for (const chunk of this._storedChunks.keys()) {
            if (chunk < position) {
                this._storedChunks.delete(chunk);
            }
        }
    }
}
function indexObjectsBounded(stream, scanWindowBytes) {
    let position = 0;
    while (position < stream.end) {
        stream.discardChunksBefore(position + scanWindowBytes);
        position += scanWindowBytes;
    }
    return position;
}
function sendRange(rangeReader, begin) {
    let nextBegin = begin;
    let receivedBytes = 0;
    return rangeReader.read().then(({value, done}) => {
        if (done) {
            return;
        }
        receivedBytes += value.byteLength;
        nextBegin += value.byteLength;
        return {nextBegin, receivedBytes};
    });
}
export { ChunkedStream, indexObjectsBounded, sendRange };
`;
        try {
            await mkdir(path.join(pdfjsRoot, 'build'), {recursive: true});
            await writeFile(
                path.join(pdfjsRoot, 'package.json'),
                JSON.stringify({version: '9.8.7'}),
            );
            await writeFile(path.join(pdfjsRoot, 'build', 'pdf.worker.mjs'), workerSource);
            for (const directory of [
                'standard_fonts',
                'cmaps',
                'wasm',
                'iccs',
            ]) {
                await mkdir(path.join(pdfjsRoot, directory), {recursive: true});
            }
            await writeFile(path.join(pdfjsRoot, 'wasm', 'README.md'), 'documentation');
            await writeFile(path.join(pdfjsRoot, 'wasm', 'CHANGELOG.md'), 'documentation');

            await copyPdfjsAssets({
                root: pdfjsRoot,
                targetRoot,
            });

            const publicWorkerSource = await readFile(
                path.join(targetRoot, 'pdf.worker.min.mjs'),
                'utf8',
            );
            expect(publicWorkerSource).toContain('ChunkedStreamClone');
            expect(publicWorkerSource).toContain('_storedChunks');
            expect(publicWorkerSource).toContain('discardChunksBefore');
            expect(publicWorkerSource).toContain('indexObjectsBounded');
            expect(publicWorkerSource).toContain('receivedBytes');
            expect(publicWorkerSource).not.toContain(
                'PDF.js xref recovery is disabled for range-backed documents above 16 MiB',
            );
            expect(publicWorkerSource.split(/\r?\n/u).length)
                .toBeLessThanOrEqual(PDFJS_WORKER_MAX_LINES);
            expect(Buffer.byteLength(publicWorkerSource, 'utf8'))
                .toBeLessThan(PDFJS_WORKER_MAX_BYTES);
            expect(publicWorkerSource).not.toContain('\n    class ChunkedStream');
            await expect(readFile(path.join(targetRoot, 'wasm', 'README.md')))
                .rejects
                .toMatchObject({code: 'ENOENT'});
            await expect(readFile(path.join(targetRoot, 'wasm', 'CHANGELOG.md')))
                .rejects
                .toMatchObject({code: 'ENOENT'});

            const publicWorkerModule = await import(
                `${pathToFileURL(path.join(targetRoot, 'pdf.worker.min.mjs')).href}?asset-contract`
            );
            const stream = new publicWorkerModule.ChunkedStream();
            expect(stream._storedChunks).toBeInstanceOf(Map);
            expect(stream.clone().constructor.name).toBe('ChunkedStreamClone');
            stream.end = 1024;
            expect(publicWorkerModule.indexObjectsBounded(stream, 1024)).toBe(1024);
            await expect(publicWorkerModule.sendRange({read: async () => ({
                value: new Uint8Array(4),
                done: false,
            })}, 16)).resolves.toEqual({
                nextBegin: 20,
                receivedBytes: 4,
            });
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('writes a pdf.js version stamp from the installed package metadata', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-pdfjs-assets-'));
        const pdfjsRoot = path.join(tempRoot, 'node_modules', 'pdfjs-dist');
        const targetRoot = path.join(tempRoot, 'public', 'pdf');
        try {
            await mkdir(pdfjsRoot, {recursive: true});
            await writeFile(
                path.join(pdfjsRoot, 'package.json'),
                JSON.stringify({version: '9.8.7'}),
            );

            await expect(writePdfjsVersionStamp({
                root: pdfjsRoot,
                targetRoot,
            })).resolves.toBe('9.8.7');

            await expect(readFile(path.join(targetRoot, '.pdfjs-version'), 'utf8'))
                .resolves
                .toBe('9.8.7\n');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('keeps the committed public stamp aligned with pdfjs-dist', async () => {
        const installedVersion = await readPdfjsPackageVersion();
        const committedStamp = await readFile(
            path.join(process.cwd(), 'public', 'pdf', '.pdfjs-version'),
            'utf8',
        );

        expect(committedStamp.trim()).toBe(installedVersion);
    });
});
