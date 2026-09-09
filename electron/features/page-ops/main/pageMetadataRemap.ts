import {randomUUID} from 'node:crypto';
import {
    mkdtemp,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {
    IPageOpsMetadataSnapshot,
    IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import type {IPdfNativeMutationSet} from '@contracts/electronApiDocuments';
import {splitPdfNativeMutationSetIntoBoundedChunks} from '@pdf-core/nativePdfMutationPolicy';
import {mapPageNumberThroughPageIdentityDelta} from '@contracts/electronApiPageOps';
import {
    pageIndexToPageNumber,
    pageNumberToPageIndex,
} from '@contracts/pageNumbers';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/main/nativePageOpsPath';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';

const PAGE_METADATA_REMAP_TIMEOUT_MS = 2 * 60 * 1000;

function remapBookmarkItems(
    items: readonly IPdfBookmarkEntry[],
    delta: IPageIdentityDelta,
): IPdfBookmarkEntry[] {
    return items.flatMap(item => {
        const children = remapBookmarkItems(item.items, delta);
        if (item.pageIndex === null) {
            return [{
                ...item,
                items: children,
            }];
        }
        const mappedPageNumber = mapPageNumberThroughPageIdentityDelta(
            delta,
            pageIndexToPageNumber(item.pageIndex),
        );
        if (mappedPageNumber === null) {
            return children;
        }
        return [{
            ...item,
            pageIndex: pageNumberToPageIndex(mappedPageNumber),
            namedDest: null,
            items: children,
        }];
    });
}

function remapKnownPageLabels(
    pageLabels: readonly string[],
    delta: IPageIdentityDelta,
    nextPageCount: number | undefined,
) {
    if (pageLabels.length !== delta.previousPageCount || nextPageCount === undefined) {
        return undefined;
    }
    const remapped = Array<string | undefined>(nextPageCount);
    if (delta.pages !== undefined) {
        delta.pages.forEach((page, index) => {
            remapped[index] = 'fromPageNumber' in page
                ? pageLabels[page.fromPageNumber - 1]
                : undefined;
        });
    } else {
        for (const range of delta.ranges ?? []) {
            if (range.kind !== 'retain' && range.kind !== 'move') continue;
            for (let offset = 0; offset < range.count; offset += 1) {
                remapped[range.toPageNumber - 1 + offset] = pageLabels[range.fromPageNumber - 1 + offset];
            }
        }
    }
    return remapped.map((label, index) => label ?? String(index + 1));
}

function remapCompactPageLabelRanges(
    pageLabelRanges: readonly IPdfPageLabelRange[],
    delta: IPageIdentityDelta,
    nextPageCount: number | undefined,
) {
    if (pageLabelRanges.length === 0 || nextPageCount === undefined) {
        return undefined;
    }
    const normalizedPageLabelRanges = pageLabelRanges[0]!.startPage > 1
        ? [
            {
                startPage: 1,
                style: 'D' as const,
                prefix: '',
                startNumber: 1,
            },
            ...pageLabelRanges,
        ]
        : pageLabelRanges;
    const sourceRanges = normalizedPageLabelRanges.map((range, index) => ({
        ...range,
        endPage: normalizedPageLabelRanges[index + 1]
            ? normalizedPageLabelRanges[index + 1]!.startPage - 1
            : delta.previousPageCount,
    }));
    const remapped: IPdfPageLabelRange[] = [];
    let lastRangeCount = 0;
    const append = (range: IPdfPageLabelRange, count: number) => {
        if (count <= 0) {
            return;
        }
        const previous = remapped.at(-1);
        if (
            previous
            && previous.startPage + lastRangeCount === range.startPage
            && previous.style === range.style
            && previous.prefix === range.prefix
            && previous.startNumber + lastRangeCount === range.startNumber
        ) {
            lastRangeCount += count;
            return;
        }
        remapped.push(range);
        lastRangeCount = count;
    };
    const appendMappedRange = (sourceStartPage: number, destinationStartPage: number, count: number) => {
        const sourceEndPage = sourceStartPage + count - 1;
        for (const sourceRange of sourceRanges) {
            const overlapStart = Math.max(sourceStartPage, sourceRange.startPage);
            const overlapEnd = Math.min(sourceEndPage, sourceRange.endPage);
            if (overlapStart > overlapEnd) continue;
            append({
                startPage: destinationStartPage + overlapStart - sourceStartPage,
                style: sourceRange.style,
                prefix: sourceRange.prefix,
                startNumber: sourceRange.startNumber + overlapStart - sourceRange.startPage,
            }, overlapEnd - overlapStart + 1);
        }
    };
    if (delta.pages !== undefined) {
        delta.pages.forEach((page, index) => {
            if ('fromPageNumber' in page) {
                appendMappedRange(page.fromPageNumber, index + 1, 1);
            } else {
                append({
                    startPage: index + 1,
                    style: 'D',
                    prefix: '',
                    startNumber: 1,
                }, 1);
            }
        });
    } else {
        for (const range of delta.ranges ?? []) {
            if (range.kind === 'insert') {
                append({
                    startPage: range.toPageNumber,
                    style: 'D',
                    prefix: '',
                    startNumber: 1,
                }, range.count);
            } else if (range.kind === 'touch') {
                appendMappedRange(range.toPageNumber, range.toPageNumber, range.count);
            } else if (range.kind === 'retain' || range.kind === 'move') {
                appendMappedRange(range.fromPageNumber, range.toPageNumber, range.count);
            }
        }
    }
    return remapped.length > 0 && remapped[0]!.startPage === 1 ? remapped : undefined;
}

export function remapPageMetadata(
    metadata: IPageOpsMetadataSnapshot,
    delta: IPageIdentityDelta,
) {
    const nextPageCount = delta.nextPageCount ?? delta.pages?.length;
    const compactRanges = metadata.pageLabels === undefined || metadata.pageLabels === null
        ? metadata.pageLabelRanges === undefined
            ? undefined
            : remapCompactPageLabelRanges(metadata.pageLabelRanges, delta, nextPageCount)
        : undefined;
    const labels = metadata.pageLabels !== undefined && metadata.pageLabels !== null
        ? remapKnownPageLabels(metadata.pageLabels, delta, nextPageCount)
        : undefined;
    const result: {
        pageLabels?: {
            totalPages: number;
            ranges: IPdfPageLabelRange[];
        };
        bookmarks?: {
            totalPages: number;
            untitledLabel: string;
            items: IPdfBookmarkEntry[];
        };
    } = {};
    if (compactRanges !== undefined) {
        result.pageLabels = {
            totalPages: nextPageCount ?? 0,
            ranges: compactRanges,
        };
    }
    if (labels !== undefined) {
        result.pageLabels = {
            totalPages: nextPageCount ?? 0,
            ranges: labels.map((label, index) => ({
                startPage: index + 1,
                style: null,
                prefix: label,
                startNumber: 1,
            })),
        };
    }
    if (metadata.bookmarks !== undefined) {
        result.bookmarks = {
            totalPages: nextPageCount ?? 0,
            untitledLabel: metadata.untitledBookmarkLabel,
            items: remapBookmarkItems(metadata.bookmarks, delta),
        };
    }
    return result satisfies Pick<IPdfNativeMutationSet, 'pageLabels' | 'bookmarks'>;
}

function createNativeModifiedAt() {
    const date = new Date();
    const pad = (value: number, length = 2) => String(value).padStart(length, '0');
    return `D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export async function applyPageMetadataRemap(input: {
    workingCopyPath: string;
    delta: IPageIdentityDelta;
    metadataSnapshot?: IPageOpsMetadataSnapshot;
    signal: AbortSignal;
    cancelGroup: string;
}) {
    if (!input.metadataSnapshot) {
        return;
    }
    if (isNativePageOpsDisabled()) {
        throw new Error('Cannot safely remap PDF page metadata while native page operations are disabled');
    }
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Cannot safely remap PDF page metadata because the native page tool is unavailable');
    }
    const tempDir = await mkdtemp(join(tmpdir(), `page-metadata-${randomUUID()}-`));
    const mutationsPath = join(tempDir, 'mutations.json');
    try {
        const workingCopyStat = await stat(input.workingCopyPath, {bigint: true});
        if (!workingCopyStat.isFile() || workingCopyStat.nlink !== 1n) {
            throw new Error('Page metadata remap requires an exclusively owned working-copy inode');
        }
        const mutations = remapPageMetadata(input.metadataSnapshot, input.delta);
        if (Object.keys(mutations).length === 0) {
            return;
        }
        const mutationChunks = splitPdfNativeMutationSetIntoBoundedChunks(
            mutations,
        );
        for (const [
            chunkIndex,
            mutationChunk,
        ] of mutationChunks.entries()) {
            const chunkMutationsPath = chunkIndex === 0
                ? mutationsPath
                : join(tempDir, `mutations-${chunkIndex}.json`);
            await writeFile(
                chunkMutationsPath,
                JSON.stringify(mutationChunk),
                'utf8',
            );
            await runNativeToolCommand(binaryPath, [
                'save-mutations',
                '--input',
                input.workingCopyPath,
                '--output',
                input.workingCopyPath,
                '--mutations-file',
                chunkMutationsPath,
                '--qpdf',
                getPdfNativeToolPaths().qpdf,
                '--modified-at',
                createNativeModifiedAt(),
                '--append',
                '--append-in-place',
            ], {
                timeoutMs: PAGE_METADATA_REMAP_TIMEOUT_MS,
                commandLabel: 'evb-pdf-page-ops(page-metadata-remap)',
                signal: input.signal,
                cancelGroup: input.cancelGroup,
            });
        }
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    }
}
