import {isRecord} from '@contracts/runtimeGuards';

export interface ISearchDocumentTextSource {
    kind: string;
    version: number;
}

export interface IPersistedSearchPageText {
    pageNumber: number;
    text: string;
}

export interface IPersistedSearchDocumentCacheRecord {
    version?: number;
    pdfPath: string;
    fileSize: number;
    contentSignature?: string;
    documentRevision?: string;
    pageCount: number;
    pages: IPersistedSearchPageText[];
    textBytes?: number;
    lastAccessedAt?: number;
    createdAt?: number;
    textSource?: ISearchDocumentTextSource;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function finiteNumberOrUndefined(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function parseSearchDocumentTextSource(value: unknown): ISearchDocumentTextSource | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (typeof value.kind !== 'string' || typeof value.version !== 'number' || !Number.isInteger(value.version)) {
        return undefined;
    }
    return {
        kind: value.kind,
        version: value.version,
    };
}

function parsePersistedPageRecords(
    value: unknown,
    pageCount: number,
): IPersistedSearchPageText[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const pages: IPersistedSearchPageText[] = [];
    const pageNumbers = new Set<number>();
    for (const item of value) {
        if (!isRecord(item)) {
            return null;
        }
        const pageNumber = item.pageNumber;
        const text = item.text;
        if (
            !isPositiveInteger(pageNumber)
            || pageNumber > pageCount
            || typeof text !== 'string'
            || pageNumbers.has(pageNumber)
        ) {
            return null;
        }
        pageNumbers.add(pageNumber);
        if (text.length > 0) {
            pages.push({
                pageNumber,
                text,
            });
        }
    }
    return pages;
}

function parseLegacyPersistedPageTexts(
    value: unknown,
    pageCount: number,
): IPersistedSearchPageText[] | null {
    if (!Array.isArray(value) || value.length > pageCount) {
        return null;
    }
    const pages: IPersistedSearchPageText[] = [];
    const legacyPageTexts = value as readonly unknown[];
    for (let index = 0; index < legacyPageTexts.length; index += 1) {
        const text = legacyPageTexts[index];
        if (text === undefined) {
            continue;
        }
        if (typeof text !== 'string') {
            return null;
        }
        if (text.length > 0) {
            pages.push({
                pageNumber: index + 1,
                text,
            });
        }
    }
    return pages;
}

export function parsePersistedSearchCacheRecord(value: unknown): IPersistedSearchDocumentCacheRecord | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        typeof value.pdfPath !== 'string'
        || typeof value.fileSize !== 'number'
        || !Number.isFinite(value.fileSize)
        || value.fileSize < 0
        || !isPositiveInteger(value.pageCount)
    ) {
        return null;
    }

    const pages = value.pages !== undefined
        ? parsePersistedPageRecords(value.pages, value.pageCount)
        : parseLegacyPersistedPageTexts(value.pageTexts, value.pageCount);
    if (!pages) {
        return null;
    }

    const textSource = parseSearchDocumentTextSource(value.textSource);
    const textBytes = finiteNumberOrUndefined(value.textBytes);
    const lastAccessedAt = finiteNumberOrUndefined(value.lastAccessedAt);
    const createdAt = finiteNumberOrUndefined(value.createdAt);
    return {
        ...(typeof value.version === 'number' ? {version: value.version} : {}),
        pdfPath: value.pdfPath,
        fileSize: value.fileSize,
        ...(typeof value.contentSignature === 'string' ? {contentSignature: value.contentSignature} : {}),
        ...(typeof value.documentRevision === 'string' ? {documentRevision: value.documentRevision} : {}),
        pageCount: value.pageCount,
        pages,
        ...(textBytes !== undefined ? {textBytes} : {}),
        ...(lastAccessedAt !== undefined ? {lastAccessedAt} : {}),
        ...(createdAt !== undefined ? {createdAt} : {}),
        ...(textSource !== undefined ? {textSource} : {}),
    };
}

export function estimatePageTextBytes(pageTexts: ReadonlyMap<number, string> | readonly IPersistedSearchPageText[]) {
    let total = 0;
    if (pageTexts instanceof Map) {
        for (const text of (pageTexts as ReadonlyMap<number, string>).values()) {
            total += text.length * 2;
        }
        return total;
    }
    for (const page of pageTexts as readonly IPersistedSearchPageText[]) {
        total += page.text.length * 2;
    }
    return total;
}

export function getPersistedRecordBytes(record: IPersistedSearchDocumentCacheRecord) {
    return typeof record.textBytes === 'number'
        ? record.textBytes
        : estimatePageTextBytes(record.pages);
}

export function createPersistedSearchCacheRecord(
    pdfPath: string,
    fileSize: number,
    contentSignature: string,
    documentRevision: string,
    pageCount: number,
    pageTexts: ReadonlyMap<number, string>,
    timestamp: number,
    version: number,
    textSource: ISearchDocumentTextSource,
): IPersistedSearchDocumentCacheRecord {
    const pages: IPersistedSearchPageText[] = [];
    for (const [
        pageNumber,
        text,
    ] of pageTexts) {
        if (text.length > 0) {
            pages.push({
                pageNumber,
                text,
            });
        }
    }
    return {
        version,
        pdfPath,
        fileSize,
        contentSignature,
        documentRevision,
        pageCount,
        pages,
        textBytes: estimatePageTextBytes(pages),
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        textSource,
    };
}
