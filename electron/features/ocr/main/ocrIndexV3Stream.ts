import {open} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import { getErrorMessage } from '@electron/utils/error';
import type {
    IDocumentRevisionStamp,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';

// O_RDONLY is zero. These are the stable POSIX O_NOFOLLOW values used by the
// Electron hosts. Windows has no equivalent, so its validated lstat path is
// the fallback.
const READ_ONLY_NOFOLLOW_FLAGS = process.platform === 'darwin'
    ? 0x100
    : process.platform === 'linux'
        ? 0x20_000
        : 0;
const JSON_READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSON_STRING_CHARS = 1_048_576;
const MAX_JSON_DEPTH = 64;

export interface IOcrIndexV3ManifestStreamMetadata {
    version: 3;
    documentRevision: IDocumentRevisionStamp;
    createdAt: number;
    source: {pdfPath: string};
    pageCount: number;
    mappedPageCount: number;
    pageBox: 'crop';
    ocr: {
        engine: 'tesseract';
        languages: string[];
        renderDpi: number;
    };
}

export interface IOcrIndexV3ManifestStreamMapping {
    pageNumber: number;
    path: string;
    generation?: string;
}

export class OcrIndexV3ManifestStreamError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OcrIndexV3ManifestStreamError';
    }
}

function fail(message: string): never {
    throw new OcrIndexV3ManifestStreamError(message);
}

function isSafePositiveInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isErrnoCode(error: unknown, code: string): boolean {
    return !!error
        && typeof error === 'object'
        && 'code' in error
        && error.code === code;
}

class JsonStreamReader {
    private readonly bytes = Buffer.alloc(JSON_READ_CHUNK_BYTES);
    private readonly decoder = new TextDecoder('utf-8', {fatal: true});
    private text = '';
    private textOffset = 0;
    private byteOffset = 0;
    private ended = false;

    constructor(private readonly file: FileHandle) {}

    private async fill(): Promise<boolean> {
        while (this.textOffset >= this.text.length && !this.ended) {
            this.text = '';
            this.textOffset = 0;
            const result = await this.file.read(this.bytes, 0, this.bytes.byteLength, this.byteOffset);
            if (result.bytesRead <= 0) {
                try {
                    this.text = this.decoder.decode();
                } catch {
                    fail('v3 manifest is not valid UTF-8');
                }
                this.ended = true;
                break;
            }
            this.byteOffset += result.bytesRead;
            try {
                this.text = this.decoder.decode(this.bytes.subarray(0, result.bytesRead), {stream: true});
            } catch {
                fail('v3 manifest is not valid UTF-8');
            }
        }
        return this.textOffset < this.text.length;
    }

    async peek(): Promise<string | null> {
        return await this.fill() ? this.text[this.textOffset]! : null;
    }

    async next(): Promise<string | null> {
        if (!await this.fill()) {
            return null;
        }
        const character = this.text[this.textOffset]!;
        this.textOffset += 1;
        return character;
    }

    async expect(character: string): Promise<void> {
        const actual = await this.next();
        if (actual !== character) {
            fail(`expected ${JSON.stringify(character)} but found ${JSON.stringify(actual)}`);
        }
    }

    async skipWhitespace(): Promise<void> {
        for (;;) {
            const character = await this.peek();
            if (character === null || !/\s/u.test(character)) {
                return;
            }
            await this.next();
        }
    }

    async readString(): Promise<string> {
        await this.skipWhitespace();
        await this.expect('"');
        let encoded = '"';
        for (;;) {
            const character = await this.next();
            if (character === null) {
                fail('unterminated JSON string');
            }
            encoded += character;
            if (encoded.length > MAX_JSON_STRING_CHARS) {
                fail('v3 manifest JSON string is too large');
            }
            if (character === '"') {
                break;
            }
            if (character === '\\') {
                const escaped = await this.next();
                if (escaped === null) {
                    fail('unterminated JSON escape');
                }
                encoded += escaped;
                if (encoded.length > MAX_JSON_STRING_CHARS) {
                    fail('v3 manifest JSON string is too large');
                }
                if (escaped === 'u') {
                    for (let index = 0; index < 4; index += 1) {
                        const hex = await this.next();
                        if (hex === null || !/[0-9a-f]/iu.test(hex)) {
                            fail('invalid JSON unicode escape');
                        }
                        encoded += hex;
                    }
                }
            } else if (character < ' ') {
                fail('JSON string contains an unescaped control character');
            }
        }
        try {
            const value = JSON.parse(encoded) as unknown;
            if (typeof value !== 'string') {
                fail('JSON string did not decode to a string');
            }
            return value;
        } catch (error) {
            if (error instanceof OcrIndexV3ManifestStreamError) {
                throw error;
            }
            fail('invalid JSON string');
        }
    }

    async readNumber(): Promise<number> {
        await this.skipWhitespace();
        let token = '';
        for (;;) {
            const character = await this.peek();
            if (character === null || /[\s,}\]]/u.test(character)) {
                break;
            }
            token += await this.next();
            if (token.length > 128) {
                fail('JSON number is too large');
            }
        }
        if (token.length === 0) {
            fail('expected JSON number');
        }
        try {
            const value = JSON.parse(token) as unknown;
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                fail('invalid JSON number');
            }
            return value;
        } catch (error) {
            if (error instanceof OcrIndexV3ManifestStreamError) {
                throw error;
            }
            fail('invalid JSON number');
        }
    }

    async readLiteral(literal: 'true' | 'false' | 'null'): Promise<void> {
        for (const expected of literal) {
            if (await this.next() !== expected) {
                fail(`invalid JSON literal, expected ${literal}`);
            }
        }
    }

    async skipValue(depth = 0): Promise<void> {
        if (depth > MAX_JSON_DEPTH) {
            fail('v3 manifest JSON nesting is too deep');
        }
        await this.skipWhitespace();
        const character = await this.peek();
        if (character === '"') {
            await this.readString();
            return;
        }
        if (character === '{') {
            await this.next();
            await this.skipWhitespace();
            if (await this.peek() === '}') {
                await this.next();
                return;
            }
            for (;;) {
                await this.readString();
                await this.skipWhitespace();
                await this.expect(':');
                await this.skipValue(depth + 1);
                await this.skipWhitespace();
                const delimiter = await this.next();
                if (delimiter === '}') {
                    return;
                }
                if (delimiter !== ',') {
                    fail('invalid JSON object delimiter');
                }
            }
        }
        if (character === '[') {
            await this.next();
            await this.skipWhitespace();
            if (await this.peek() === ']') {
                await this.next();
                return;
            }
            for (;;) {
                await this.skipValue(depth + 1);
                await this.skipWhitespace();
                const delimiter = await this.next();
                if (delimiter === ']') {
                    return;
                }
                if (delimiter !== ',') {
                    fail('invalid JSON array delimiter');
                }
            }
        }
        if (character === 't') {
            await this.readLiteral('true');
            return;
        }
        if (character === 'f') {
            await this.readLiteral('false');
            return;
        }
        if (character === 'n') {
            await this.readLiteral('null');
            return;
        }
        await this.readNumber();
    }
}

interface IRootFields {
    version?: number;
    documentRevision?: IDocumentRevisionStamp;
    createdAt?: number;
    sourcePdfPath?: string;
    pageCount?: number;
    pageBox?: string;
    ocrEngine?: string;
    ocrLanguages?: string[];
    renderDpi?: number;
    pagesSeen: boolean;
    maxPageNumber: number;
    mappedPageCount: number;
    invalidPage: boolean;
}

function emptyRootFields(): IRootFields {
    return {
        pagesSeen: false,
        maxPageNumber: 0,
        mappedPageCount: 0,
        invalidPage: false,
    };
}

async function readRevision(reader: JsonStreamReader): Promise<IDocumentRevisionStamp | undefined> {
    await reader.skipWhitespace();
    if (await reader.peek() !== '{') {
        await reader.skipValue();
        return undefined;
    }
    await reader.next();
    let token: TDocumentRevisionToken | undefined;
    await reader.skipWhitespace();
    if (await reader.peek() === '}') {
        await reader.next();
        return undefined;
    }
    for (;;) {
        const key = await reader.readString();
        await reader.skipWhitespace();
        await reader.expect(':');
        if (key === 'token') {
            await reader.skipWhitespace();
            if (await reader.peek() === '"') {
                token = parseDocumentRevisionToken(await reader.readString()) ?? undefined;
            } else {
                await reader.skipValue();
                token = undefined;
            }
        } else {
            await reader.skipValue();
        }
        await reader.skipWhitespace();
        const delimiter = await reader.next();
        if (delimiter === '}') {
            break;
        }
        if (delimiter !== ',') {
            fail('invalid documentRevision object delimiter');
        }
    }
    return token === undefined ? undefined : {token};
}

async function readSource(reader: JsonStreamReader): Promise<string | undefined> {
    await reader.skipWhitespace();
    if (await reader.peek() !== '{') {
        await reader.skipValue();
        return undefined;
    }
    await reader.next();
    let pdfPath: string | undefined;
    await reader.skipWhitespace();
    if (await reader.peek() === '}') {
        await reader.next();
        return undefined;
    }
    for (;;) {
        const key = await reader.readString();
        await reader.skipWhitespace();
        await reader.expect(':');
        if (key === 'pdfPath') {
            await reader.skipWhitespace();
            if (await reader.peek() === '"') {
                pdfPath = await reader.readString();
            } else {
                await reader.skipValue();
                pdfPath = undefined;
            }
        } else {
            await reader.skipValue();
        }
        await reader.skipWhitespace();
        const delimiter = await reader.next();
        if (delimiter === '}') {
            break;
        }
        if (delimiter !== ',') {
            fail('invalid source object delimiter');
        }
    }
    return pdfPath;
}

async function readOcr(reader: JsonStreamReader): Promise<Pick<IRootFields, 'ocrEngine' | 'ocrLanguages' | 'renderDpi'>> {
    await reader.skipWhitespace();
    if (await reader.peek() !== '{') {
        await reader.skipValue();
        return {};
    }
    await reader.next();
    let ocrEngine: string | undefined;
    let ocrLanguages: string[] | undefined;
    let renderDpi: number | undefined;
    await reader.skipWhitespace();
    if (await reader.peek() === '}') {
        await reader.next();
        return {};
    }
    for (;;) {
        const key = await reader.readString();
        await reader.skipWhitespace();
        await reader.expect(':');
        if (key === 'engine') {
            await reader.skipWhitespace();
            if (await reader.peek() === '"') {
                ocrEngine = await reader.readString();
            } else {
                await reader.skipValue();
            }
        } else if (key === 'renderDpi') {
            await reader.skipWhitespace();
            const next = await reader.peek();
            if (next !== null && /[-0-9]/u.test(next)) {
                renderDpi = await reader.readNumber();
            } else {
                await reader.skipValue();
            }
        } else if (key === 'languages') {
            await reader.skipWhitespace();
            if (await reader.peek() !== '[') {
                await reader.skipValue();
            } else {
                await reader.next();
                const languages: string[] = [];
                let validLanguages = true;
                await reader.skipWhitespace();
                if (await reader.peek() !== ']') {
                    for (;;) {
                        await reader.skipWhitespace();
                        if (await reader.peek() !== '"') {
                            await reader.skipValue();
                            validLanguages = false;
                        } else {
                            languages.push(await reader.readString());
                        }
                        await reader.skipWhitespace();
                        const delimiter = await reader.next();
                        if (delimiter === ']') {
                            break;
                        }
                        if (delimiter !== ',') {
                            fail('invalid OCR languages array delimiter');
                        }
                    }
                } else {
                    await reader.next();
                }
                ocrLanguages = validLanguages ? languages : undefined;
            }
        } else {
            await reader.skipValue();
        }
        await reader.skipWhitespace();
        const delimiter = await reader.next();
        if (delimiter === '}') {
            break;
        }
        if (delimiter !== ',') {
            fail('invalid OCR object delimiter');
        }
    }
    return {
        ...(ocrEngine === undefined ? {} : {ocrEngine}),
        ...(ocrLanguages === undefined ? {} : {ocrLanguages}),
        ...(renderDpi === undefined ? {} : {renderDpi}),
    };
}

async function readPageMapping(reader: JsonStreamReader): Promise<{
    path?: string;
    generation?: string
}> {
    await reader.skipWhitespace();
    if (await reader.peek() !== '{') {
        await reader.skipValue();
        return {};
    }
    await reader.next();
    let path: string | undefined;
    let generation: string | undefined;
    await reader.skipWhitespace();
    if (await reader.peek() === '}') {
        await reader.next();
        return {};
    }
    for (;;) {
        const key = await reader.readString();
        await reader.skipWhitespace();
        await reader.expect(':');
        await reader.skipWhitespace();
        if (key === 'path' && await reader.peek() === '"') {
            path = await reader.readString();
        } else if (key === 'generation' && await reader.peek() === '"') {
            generation = await reader.readString();
        } else {
            await reader.skipValue();
        }
        await reader.skipWhitespace();
        const delimiter = await reader.next();
        if (delimiter === '}') {
            break;
        }
        if (delimiter !== ',') {
            fail('invalid page mapping object delimiter');
        }
    }
    return {
        ...(path === undefined ? {} : {path}),
        ...(generation === undefined ? {} : {generation}),
    };
}

async function readPages(
    reader: JsonStreamReader,
    fields: IRootFields,
    onPage?: (mapping: IOcrIndexV3ManifestStreamMapping) => Promise<void> | void,
): Promise<void> {
    await reader.skipWhitespace();
    if (await reader.peek() !== '{') {
        await reader.skipValue();
        fields.invalidPage = true;
        return;
    }
    await reader.next();
    await reader.skipWhitespace();
    if (await reader.peek() === '}') {
        await reader.next();
        return;
    }
    for (;;) {
        const rawPageNumber = await reader.readString();
        const pageNumber = Number(rawPageNumber);
        const validPageNumber = isSafePositiveInteger(pageNumber)
            && String(pageNumber) === rawPageNumber;
        if (validPageNumber) {
            fields.maxPageNumber = Math.max(fields.maxPageNumber, pageNumber);
        } else {
            fields.invalidPage = true;
        }
        await reader.skipWhitespace();
        await reader.expect(':');
        const mapping = await readPageMapping(reader);
        if (
            !validPageNumber
            || typeof mapping.path !== 'string'
            || mapping.path.length === 0
        ) {
            fields.invalidPage = true;
        } else {
            fields.mappedPageCount += 1;
            if (onPage) {
                await onPage({
                    pageNumber,
                    path: mapping.path,
                    ...(mapping.generation === undefined ? {} : {generation: mapping.generation}),
                });
            }
        }
        await reader.skipWhitespace();
        const delimiter = await reader.next();
        if (delimiter === '}') {
            break;
        }
        if (delimiter !== ',') {
            fail('invalid v3 pages object delimiter');
        }
    }
}

function validateFields(fields: IRootFields): IOcrIndexV3ManifestStreamMetadata | null {
    if (
        fields.version !== 3
        || fields.documentRevision === undefined
        || typeof fields.sourcePdfPath !== 'string'
        || !isSafePositiveInteger(fields.pageCount)
        || fields.pageBox !== 'crop'
        || fields.ocrEngine !== 'tesseract'
        || fields.ocrLanguages === undefined
        || !fields.ocrLanguages.every(language => typeof language === 'string')
        || !isFiniteNonNegativeNumber(fields.createdAt)
        || !isFinitePositiveNumber(fields.renderDpi)
        || !fields.pagesSeen
        || fields.invalidPage
        || fields.maxPageNumber > fields.pageCount
    ) {
        return null;
    }
    return {
        version: 3,
        documentRevision: fields.documentRevision,
        createdAt: fields.createdAt,
        source: {pdfPath: fields.sourcePdfPath},
        pageCount: fields.pageCount,
        mappedPageCount: fields.mappedPageCount,
        pageBox: 'crop',
        ocr: {
            engine: 'tesseract',
            languages: fields.ocrLanguages,
            renderDpi: fields.renderDpi,
        },
    };
}

async function parseManifestStream(
    manifestPath: string,
    onPage?: (mapping: IOcrIndexV3ManifestStreamMapping) => Promise<void> | void,
): Promise<IOcrIndexV3ManifestStreamMetadata | null> {
    let file: FileHandle;
    try {
        file = await open(manifestPath, READ_ONLY_NOFOLLOW_FLAGS);
    } catch (error) {
        if (isErrnoCode(error, 'ELOOP')) {
            throw new OcrIndexV3ManifestStreamError('symbolic links are not allowed for the v3 manifest');
        }
        throw error;
    }
    const reader = new JsonStreamReader(file);
    const fields = emptyRootFields();
    try {
        await reader.skipWhitespace();
        if (await reader.peek() !== '{') {
            return null;
        }
        await reader.next();
        await reader.skipWhitespace();
        if (await reader.peek() === '}') {
            await reader.next();
            return null;
        }
        for (;;) {
            const key = await reader.readString();
            await reader.skipWhitespace();
            await reader.expect(':');
            if (key === 'version') {
                fields.version = await reader.readNumber();
            } else if (key === 'documentRevision') {
                const documentRevision = await readRevision(reader);
                if (documentRevision === undefined) {
                    delete fields.documentRevision;
                } else {
                    fields.documentRevision = documentRevision;
                }
            } else if (key === 'createdAt') {
                await reader.skipWhitespace();
                fields.createdAt = await reader.readNumber();
            } else if (key === 'source') {
                const sourcePdfPath = await readSource(reader);
                if (sourcePdfPath === undefined) {
                    delete fields.sourcePdfPath;
                } else {
                    fields.sourcePdfPath = sourcePdfPath;
                }
            } else if (key === 'pageCount') {
                fields.pageCount = await reader.readNumber();
            } else if (key === 'pageBox') {
                await reader.skipWhitespace();
                if (await reader.peek() === '"') {
                    fields.pageBox = await reader.readString();
                } else {
                    await reader.skipValue();
                    delete fields.pageBox;
                }
            } else if (key === 'ocr') {
                const ocr = await readOcr(reader);
                if (ocr.ocrEngine === undefined) {
                    delete fields.ocrEngine;
                } else {
                    fields.ocrEngine = ocr.ocrEngine;
                }
                if (ocr.ocrLanguages === undefined) {
                    delete fields.ocrLanguages;
                } else {
                    fields.ocrLanguages = ocr.ocrLanguages;
                }
                if (ocr.renderDpi === undefined) {
                    delete fields.renderDpi;
                } else {
                    fields.renderDpi = ocr.renderDpi;
                }
            } else if (key === 'pages') {
                fields.pagesSeen = true;
                await readPages(reader, fields, onPage);
            } else {
                await reader.skipValue();
            }
            await reader.skipWhitespace();
            const delimiter = await reader.next();
            if (delimiter === '}') {
                break;
            }
            if (delimiter !== ',') {
                fail('invalid v3 manifest object delimiter');
            }
        }
        await reader.skipWhitespace();
        if (await reader.peek() !== null) {
            fail('trailing data after v3 manifest');
        }
        return validateFields(fields);
    } finally {
        await file.close();
    }
}

export async function readOcrIndexV3ManifestMetadata(
    manifestPath: string,
): Promise<IOcrIndexV3ManifestStreamMetadata | null> {
    try {
        return await parseManifestStream(manifestPath);
    } catch (error) {
        if (error instanceof OcrIndexV3ManifestStreamError) {
            return null;
        }
        throw error;
    }
}

export async function streamOcrIndexV3ManifestMappings(
    manifestPath: string,
    onPage: (mapping: IOcrIndexV3ManifestStreamMapping) => Promise<void> | void,
): Promise<IOcrIndexV3ManifestStreamMetadata | null> {
    return parseManifestStream(manifestPath, onPage);
}

interface IQueueItem {mapping?: IOcrIndexV3ManifestStreamMapping;}

/**
 * Streams legacy page mappings with a bounded queue. The queue is deliberately
 * small so a slow page-artifact consumer cannot turn a v3 manifest into a
 * second in-memory catalog.
 */
export async function* iterateOcrIndexV3ManifestMappings(
    manifestPath: string,
): AsyncGenerator<IOcrIndexV3ManifestStreamMapping, IOcrIndexV3ManifestStreamMetadata | null> {
    const queue: IQueueItem[] = [];
    const waiters: Array<() => void> = [];
    const capacity = 256;
    let producerMetadata: IOcrIndexV3ManifestStreamMetadata | null = null;
    let producerError: unknown;
    let producerFinished = false as boolean;
    const enqueue = async (item: IQueueItem): Promise<void> => {
        while (queue.length >= capacity) {
            await new Promise<void>(resolve => waiters.push(resolve));
        }
        queue.push(item);
        waiters.shift()?.();
    };
    const producer = streamOcrIndexV3ManifestMappings(manifestPath, mapping => enqueue({mapping}))
        .then(metadata => {
            producerMetadata = metadata;
        })
        .catch(error => {
            producerError = error;
        })
        .finally(() => {
            producerFinished = true;
            waiters.splice(0).forEach(resolve => resolve());
        });
    try {
        while (!producerFinished || queue.length > 0) {
            if (queue.length === 0) {
                await new Promise<void>(resolve => waiters.push(resolve));
                continue;
            }
            const item = queue.shift()!;
            waiters.shift()?.();
            if (item.mapping !== undefined) {
                yield item.mapping;
            }
        }
        await producer;
        if (producerError !== undefined) {
            if (producerError instanceof Error) {
                throw producerError;
            }
            throw new OcrIndexV3ManifestStreamError(getErrorMessage(producerError));
        }
        return producerMetadata;
    } finally {
        await producer.catch(() => {});
    }
}
