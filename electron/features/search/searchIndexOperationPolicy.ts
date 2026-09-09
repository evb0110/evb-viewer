import {createReadStream} from 'node:fs';
import {
    open,
    rm,
    stat,
} from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import {
    COMPACT_SEARCH_INDEX_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_MAGIC,
    getCompactSearchIndexPath,
} from '@contracts/searchIndexSidecar';
import {
    classifyXlargeSearchPath,
    type IXlargeSearchPathClassification,
} from '@electron/features/search/xlargeSearchClassification';

const LEGACY_SEARCH_INDEX_SUFFIX = '.index.json';
const SCALAR_SCAN_CHUNK_BYTES = 64 * 1024;

export interface ISearchIndexOperationClassification extends IXlargeSearchPathClassification {
    hasCompactIndex: boolean;
    hasLegacyIndex: boolean;
}

interface IArtifactStat {
    exists: boolean;
    sizeBytes?: number;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= 0;
}

async function statArtifact(path: string): Promise<IArtifactStat> {
    try {
        const value = await stat(path);
        return {
            exists: true,
            ...(isFiniteNonNegativeNumber(value.size) ? {sizeBytes: value.size} : {}),
        };
    } catch {
        return {exists: false};
    }
}

async function readCompactPageCount(path: string, sizeBytes: number | undefined) {
    if (sizeBytes !== undefined && sizeBytes < COMPACT_SEARCH_INDEX_HEADER_SIZE) {
        return undefined;
    }

    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        file = await open(path, 'r');
        const header = Buffer.alloc(COMPACT_SEARCH_INDEX_HEADER_SIZE);
        const {bytesRead} = await file.read(header, 0, header.byteLength, 0);
        if (bytesRead !== header.byteLength) {
            return undefined;
        }
        const magic = header.toString('ascii', 0, 8);
        if (
            magic !== COMPACT_SEARCH_INDEX_MAGIC
            && magic !== COMPACT_SEARCH_INDEX_STREAMING_MAGIC
        ) {
            return undefined;
        }
        if (header.readUInt32LE(12) !== COMPACT_SEARCH_INDEX_HEADER_SIZE) {
            return undefined;
        }
        const pageCount = header.readUInt32LE(16);
        return pageCount > 0 ? pageCount : undefined;
    } catch {
        return undefined;
    } finally {
        await file?.close().catch(() => undefined);
    }
}

/**
 * Reads only the top-level pageCount scalar from the legacy JSON sidecar.
 * The stream never retains the sidecar or its pages in memory.
 */
async function readLegacyPageCount(path: string, sizeBytes: number | undefined) {
    if (sizeBytes === undefined) {
        return undefined;
    }

    const stream = createReadStream(path, {highWaterMark: SCALAR_SCAN_CHUNK_BYTES});
    const decoder = new StringDecoder('utf8');
    let depth = 0;
    let inString = false;
    let escaped = false;
    let stringValue = '';
    let topLevelString: string | undefined;
    let readingPageCount = false as boolean;
    let numberValue = '';

    const scan = (chunk: string) => {
        for (const character of chunk) {
            if (readingPageCount) {
                if (character === ',' || character === '}' || character === ']') {
                    const pageCount = Number(numberValue.trim());
                    readingPageCount = false;
                    numberValue = '';
                    return Number.isSafeInteger(pageCount) && pageCount > 0
                        ? pageCount
                        : undefined;
                }
                if (numberValue.length < 128) {
                    numberValue += character;
                }
                continue;
            }

            if (inString) {
                if (escaped) {
                    escaped = false;
                    if (depth === 1 && stringValue.length < 64) {
                        stringValue += character;
                    }
                    continue;
                }
                if (character === '\\') {
                    escaped = true;
                    continue;
                }
                if (character === '"') {
                    inString = false;
                    if (depth === 1) {
                        topLevelString = stringValue;
                    }
                    stringValue = '';
                    continue;
                }
                if (depth === 1 && stringValue.length < 64) {
                    stringValue += character;
                }
                continue;
            }

            if (character === '"') {
                inString = true;
                stringValue = '';
                continue;
            }
            if (character === '{' || character === '[') {
                depth += 1;
                topLevelString = undefined;
                continue;
            }
            if (character === '}' || character === ']') {
                depth = Math.max(0, depth - 1);
                topLevelString = undefined;
                continue;
            }
            if (depth !== 1) {
                continue;
            }
            if (character === ':') {
                if (topLevelString === 'pageCount') {
                    readingPageCount = true;
                    numberValue = '';
                }
                topLevelString = undefined;
                continue;
            }
            if (!/\s/u.test(character) && character !== ',') {
                topLevelString = undefined;
            }
        }
        return undefined;
    };

    try {
        for await (const rawChunk of stream) {
            const pageCount = scan(decoder.write(rawChunk as Buffer));
            if (pageCount !== undefined) {
                stream.destroy();
                return pageCount;
            }
        }
        const pageCount = scan(decoder.end());
        if (pageCount !== undefined) {
            return pageCount;
        }
        if (readingPageCount && numberValue.length > 0) {
            const finalPageCount = Number(numberValue);
            return Number.isSafeInteger(finalPageCount) && finalPageCount > 0
                ? finalPageCount
                : undefined;
        }
    } catch {
        return undefined;
    }
    return undefined;
}

async function readArtifactPageCount(
    legacyPath: string,
    legacyStat: IArtifactStat,
    compactPath: string,
    compactStat: IArtifactStat,
) {
    const compactPageCount = compactStat.exists
        ? await readCompactPageCount(compactPath, compactStat.sizeBytes)
        : undefined;
    if (
        compactPageCount !== undefined
        && classifyXlargeSearchPath({pageCount: compactPageCount}).isXlarge
    ) {
        return compactPageCount;
    }
    const legacyPageCount = legacyStat.exists
        ? await readLegacyPageCount(legacyPath, legacyStat.sizeBytes)
        : undefined;
    const pageCounts = [
        compactPageCount,
        legacyPageCount,
    ]
        .filter((count): count is number => (
            typeof count === 'number'
            && Number.isSafeInteger(count)
            && count > 0
        ));
    return pageCounts.length > 0 ? Math.max(...pageCounts) : undefined;
}

/** Classifies a save/page operation without loading either search index. */
export async function classifySearchIndexOperation(
    pdfPath: string,
    knownPageCount?: number,
): Promise<ISearchIndexOperationClassification> {
    const legacyPath = `${pdfPath}${LEGACY_SEARCH_INDEX_SUFFIX}`;
    const compactPath = getCompactSearchIndexPath(pdfPath);
    const [
        sourceStat,
        legacyStat,
        compactStat,
    ] = await Promise.all([
        statArtifact(pdfPath),
        statArtifact(legacyPath),
        statArtifact(compactPath),
    ]);
    const artifactSizes = [
        sourceStat.sizeBytes,
        legacyStat.sizeBytes,
        compactStat.sizeBytes,
    ].filter((size): size is number => size !== undefined);
    const pathSizeBytes = artifactSizes.length > 0
        ? Math.max(...artifactSizes)
        : undefined;
    const sizeClassification = classifyXlargeSearchPath(
        pathSizeBytes === undefined ? {} : {pathSizeBytes},
    );
    const sidecarPageCount = knownPageCount === undefined
        && !sizeClassification.isXlarge
        ? await readArtifactPageCount(legacyPath, legacyStat, compactPath, compactStat)
        : undefined;
    const pageCounts = [
        knownPageCount,
        sidecarPageCount,
    ]
        .filter((count): count is number => (
            typeof count === 'number'
            && Number.isSafeInteger(count)
            && count > 0
        ));
    const pageCount = pageCounts.length > 0 ? Math.max(...pageCounts) : undefined;
    return {
        ...classifyXlargeSearchPath({
            ...(pageCount === undefined ? {} : {pageCount}),
            ...(pathSizeBytes === undefined ? {} : {pathSizeBytes}),
        }),
        hasCompactIndex: compactStat.exists,
        hasLegacyIndex: legacyStat.exists,
    };
}

/** Removes stale eager and compact indexes after an xlarge revision change. */
export async function invalidateSearchIndexSidecars(pdfPath: string) {
    const paths = [
        `${pdfPath}${LEGACY_SEARCH_INDEX_SUFFIX}`,
        getCompactSearchIndexPath(pdfPath),
    ];
    const stats = await Promise.all(paths.map(path => statArtifact(path)));
    await Promise.all(paths.map(path => rm(path, {force: true})));
    return stats.some(artifact => artifact.exists);
}
