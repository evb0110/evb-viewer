import {
    PDFArray,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
    type PDFDocument,
    type PDFObject,
} from 'pdf-lib';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

export const PDF_COMBINE_CATALOG_POLICY = Object.freeze({
    pages: 'preserve',
    outlines: 'preserve-and-remap-destinations',
    pageLabels: 'preserve-and-offset-number-tree',
    forms: 'reject',
    attachments: 'reject',
    javascript: 'reject',
    documentMetadata: 'source-specific-metadata-is-not-promoted-to-output-catalog',
    viewerPreferences: 'source-specific-preferences-are-not-promoted-to-output-catalog',
} as const);

export interface IPdfCombinePageLabelRange {
    pageIndex: number;
    style?: string;
    prefix?: string;
    start?: number;
}

function textValue(value: PDFObject | undefined) {
    return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}

function nameValue(value: PDFObject | undefined) {
    return value instanceof PDFName ? value.asString().replace(/^\//u, '') : undefined;
}

function refKey(value: PDFObject | undefined) {
    return value instanceof PDFRef ? `${value.objectNumber}:${value.generationNumber}` : null;
}

function collectNumberTreeEntries(
    document: PDFDocument,
    node: PDFDict,
    output: Array<[number, PDFDict]>,
    visited = new WeakSet<PDFDict>(),
) {
    if (visited.has(node)) {
        return;
    }
    visited.add(node);
    const nums = node.lookupMaybe(PDFName.of('Nums'), PDFArray);
    if (nums) {
        for (let index = 0; index + 1 < nums.size(); index += 2) {
            output.push([
                nums.lookup(index, PDFNumber).asNumber(),
                nums.lookup(index + 1, PDFDict),
            ]);
        }
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
        for (let index = 0; index < kids.size(); index += 1) {
            collectNumberTreeEntries(document, kids.lookup(index, PDFDict), output, visited);
        }
    }
}

function findNamedDestination(document: PDFDocument, name: string): PDFObject | undefined {
    const directDests = document.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
    const direct = directDests?.get(PDFName.of(name));
    if (direct) {
        return direct instanceof PDFRef ? document.context.lookup(direct) : direct;
    }
    const root = document.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('Dests'), PDFDict);
    const visited = new WeakSet<PDFDict>();
    const visit = (node: PDFDict): PDFObject | undefined => {
        if (visited.has(node)) {
            return undefined;
        }
        visited.add(node);
        const entries = node.lookupMaybe(PDFName.of('Names'), PDFArray);
        if (entries) {
            for (let index = 0; index + 1 < entries.size(); index += 2) {
                if (textValue(entries.lookup(index)) === name) {
                    return entries.lookup(index + 1);
                }
            }
        }
        const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
        if (kids) {
            for (let index = 0; index < kids.size(); index += 1) {
                const found = visit(kids.lookup(index, PDFDict));
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    };
    return root ? visit(root) : undefined;
}

function destinationPageIndex(document: PDFDocument, value: PDFObject | undefined, pageRefs: Map<string, number>): number | null {
    let destination = value;
    const named = textValue(destination) ?? nameValue(destination);
    if (named) destination = findNamedDestination(document, named);
    if (destination instanceof PDFDict) destination = destination.get(PDFName.of('D'));
    if (destination instanceof PDFRef) destination = document.context.lookup(destination);
    if (!(destination instanceof PDFArray) || destination.size() === 0) {
        return null;
    }
    return pageRefs.get(refKey(destination.get(0)) ?? '') ?? null;
}

function readOutlineItems(
    document: PDFDocument,
    first: PDFObject | undefined,
    pageRefs: Map<string, number>,
    visited = new WeakSet<PDFDict>(),
): IPdfBookmarkEntry[] {
    const output: IPdfBookmarkEntry[] = [];
    let current = first;
    while (current) {
        const dict = current instanceof PDFRef ? document.context.lookup(current, PDFDict) : current;
        if (!(dict instanceof PDFDict) || visited.has(dict)) break;
        visited.add(dict);
        const flags = dict.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0;
        output.push({
            title: textValue(dict.get(PDFName.of('Title'))) ?? 'Untitled',
            pageIndex: destinationPageIndex(
                document,
                dict.get(PDFName.of('Dest')) ?? dict.lookupMaybe(PDFName.of('A'), PDFDict)?.get(PDFName.of('D')),
                pageRefs,
            ),
            namedDest: null,
            bold: (flags & 2) !== 0,
            italic: (flags & 1) !== 0,
            color: null,
            items: readOutlineItems(document, dict.get(PDFName.of('First')), pageRefs, visited),
        });
        current = dict.get(PDFName.of('Next'));
    }
    return output;
}

export function inspectPdfCombineCatalog(document: PDFDocument) {
    const names = document.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    if (document.catalog.has(PDFName.of('AcroForm'))) throw new Error('PDF combine does not support source forms');
    if (document.catalog.has(PDFName.of('AF')) || names?.has(PDFName.of('EmbeddedFiles'))) throw new Error('PDF combine does not support source attachments');
    if (names?.has(PDFName.of('JavaScript'))) throw new Error('PDF combine does not support source JavaScript');
    const pageRefs = new Map(document.getPages().map((page, index) => [
        refKey(page.ref)!,
        index,
    ]));
    const outlinesRoot = document.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    const bookmarks = outlinesRoot ? readOutlineItems(document, outlinesRoot.get(PDFName.of('First')), pageRefs) : [];
    const entries: Array<[number, PDFDict]> = [];
    const labels = document.catalog.lookupMaybe(PDFName.of('PageLabels'), PDFDict);
    if (labels) collectNumberTreeEntries(document, labels, entries);
    const pageLabels = entries.sort((left, right) => left[0] - right[0]).map(([
        pageIndex,
        dict,
    ]) => ({
        pageIndex,
        ...(nameValue(dict.get(PDFName.of('S'))) ? {style: nameValue(dict.get(PDFName.of('S')))!} : {}),
        ...(textValue(dict.get(PDFName.of('P'))) !== undefined ? {prefix: textValue(dict.get(PDFName.of('P')))!} : {}),
        ...(dict.lookupMaybe(PDFName.of('St'), PDFNumber) ? {start: dict.lookup(PDFName.of('St'), PDFNumber).asNumber()} : {}),
    }));
    return {
        bookmarks,
        pageLabels,
    };
}

export function applyCombinedPdfPageLabels(document: PDFDocument, ranges: readonly IPdfCombinePageLabelRange[]) {
    if (ranges.length === 0) {
        return;
    }
    const nums: PDFObject[] = [];
    for (const range of [...ranges].sort((left, right) => left.pageIndex - right.pageIndex)) {
        const dict = document.context.obj({});
        if (range.style) dict.set(PDFName.of('S'), PDFName.of(range.style));
        if (range.prefix !== undefined) dict.set(PDFName.of('P'), PDFString.of(range.prefix));
        if (range.start !== undefined) dict.set(PDFName.of('St'), PDFNumber.of(range.start));
        nums.push(PDFNumber.of(range.pageIndex), dict);
    }
    document.catalog.set(PDFName.of('PageLabels'), document.context.obj({Nums: document.context.obj(nums)}));
}

export function offsetPdfCombineBookmarks(
    bookmarks: readonly IPdfBookmarkEntry[],
    pageOffset: number,
): IPdfBookmarkEntry[] {
    return bookmarks.map(bookmark => ({
        ...bookmark,
        pageIndex: bookmark.pageIndex === null ? null : bookmark.pageIndex + pageOffset,
        namedDest: null,
        items: offsetPdfCombineBookmarks(bookmark.items, pageOffset),
    }));
}
