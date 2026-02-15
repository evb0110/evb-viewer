import type {
    PDFArray,
    PDFDict,
    PDFRef,
} from 'pdf-lib';
import {
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFString,
} from 'pdf-lib';
import type { Ref } from 'vue';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browser-logger';

const BOOKMARK_SERIALIZATION_LOG_SECTION = 'pdf-bookmarks';

function normalizeBookmarkColor(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(normalized)
        ? normalized
        : null;
}

export function normalizeBookmarkEntries(
    entries: IPdfBookmarkEntry[],
    totalPages: number,
    untitledLabel: string,
): IPdfBookmarkEntry[] {
    if (totalPages <= 0) {
        return [];
    }

    const maxPageIndex = totalPages - 1;

    function normalizeItem(item: IPdfBookmarkEntry): IPdfBookmarkEntry {
        const title = item.title.trim();
        const pageIndex = typeof item.pageIndex === 'number'
            ? Math.max(0, Math.min(maxPageIndex, Math.trunc(item.pageIndex)))
            : null;
        const namedDest = typeof item.namedDest === 'string' && item.namedDest.trim().length > 0
            ? item.namedDest
            : null;
        const bold = item.bold === true;
        const italic = item.italic === true;
        const color = normalizeBookmarkColor(item.color);

        return {
            title: title.length > 0 ? title : untitledLabel,
            pageIndex,
            namedDest,
            bold,
            italic,
            color,
            items: item.items.map(normalizeItem),
        };
    }

    return entries.map(normalizeItem);
}

export async function rewriteBookmarks(
    data: Uint8Array,
    deps: {
        bookmarksDirty: Ref<boolean>;
        bookmarkItems: Ref<IPdfBookmarkEntry[]>;
        totalPages: Ref<number>;
        untitledLabel: string;
    },
): Promise<Uint8Array> {
    if (!deps.bookmarksDirty.value) {
        return data;
    }

    const normalizedBookmarks = normalizeBookmarkEntries(
        deps.bookmarkItems.value,
        deps.totalPages.value,
        deps.untitledLabel,
    );

    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch (error) {
        BrowserLogger.warn(BOOKMARK_SERIALIZATION_LOG_SECTION, 'Failed to load PDF for bookmark rewrite', error);
        return data;
    }

    const outlinesName = PDFName.of('Outlines');
    if (normalizedBookmarks.length === 0) {
        doc.catalog.delete(outlinesName);
        return new Uint8Array(await doc.save());
    }

    interface IOutlineNodeBuild {
        ref: PDFRef;
        dict: PDFDict;
        item: IPdfBookmarkEntry;
        visibleCount: number;
    }

    const parentName = PDFName.of('Parent');
    const prevName = PDFName.of('Prev');
    const nextName = PDFName.of('Next');
    const firstName = PDFName.of('First');
    const lastName = PDFName.of('Last');
    const countName = PDFName.of('Count');
    const titleName = PDFName.of('Title');
    const destName = PDFName.of('Dest');
    const typeName = PDFName.of('Type');
    const flagsName = PDFName.of('F');
    const colorName = PDFName.of('C');

    const pdfNull = doc.context.obj(null);

    function setNodeDestination(dict: PDFDict, item: IPdfBookmarkEntry) {
        if (typeof item.pageIndex === 'number') {
            const pageRef = doc.getPage(item.pageIndex).ref;
            const destArray = doc.context.obj([
                pageRef,
                PDFName.of('XYZ'),
                pdfNull,
                pdfNull,
                pdfNull,
            ]) as PDFArray;
            dict.set(destName, destArray);
            return;
        }

        if (item.namedDest) {
            dict.set(destName, PDFString.of(item.namedDest));
        }
    }

    function setNodeStyle(dict: PDFDict, item: IPdfBookmarkEntry) {
        const flags = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
        if (flags > 0) {
            dict.set(flagsName, PDFNumber.of(flags));
        }

        if (!item.color) {
            return;
        }

        const value = item.color.replace('#', '');
        const red = Number.parseInt(value.slice(0, 2), 16) / 255;
        const green = Number.parseInt(value.slice(2, 4), 16) / 255;
        const blue = Number.parseInt(value.slice(4, 6), 16) / 255;

        dict.set(colorName, doc.context.obj([
            red,
            green,
            blue,
        ]));
    }

    function buildOutlineLevel(
        items: IPdfBookmarkEntry[],
        parentRef: PDFRef,
    ): {
        first: PDFRef | null;
        last: PDFRef | null;
        visibleCount: number;
    } {
        if (items.length === 0) {
            return {
                first: null,
                last: null,
                visibleCount: 0,
            };
        }

        const nodes: IOutlineNodeBuild[] = items.map((item) => {
            const dict = doc.context.obj({}) as PDFDict;
            dict.set(titleName, PDFHexString.fromText(item.title));
            setNodeDestination(dict, item);
            setNodeStyle(dict, item);

            const ref = doc.context.register(dict);
            return {
                ref,
                dict,
                item,
                visibleCount: 1,
            };
        });

        for (const [
            index,
            node,
        ] of nodes.entries()) {
            node.dict.set(parentName, parentRef);
            if (index > 0) {
                const previous = nodes[index - 1];
                if (previous) {
                    node.dict.set(prevName, previous.ref);
                }
            }
            if (index + 1 < nodes.length) {
                const next = nodes[index + 1];
                if (next) {
                    node.dict.set(nextName, next.ref);
                }
            }
        }

        for (const node of nodes) {
            const childResult = buildOutlineLevel(node.item.items, node.ref);
            if (childResult.first && childResult.last) {
                node.dict.set(firstName, childResult.first);
                node.dict.set(lastName, childResult.last);
                if (childResult.visibleCount > 0) {
                    node.dict.set(countName, PDFNumber.of(childResult.visibleCount));
                }
                node.visibleCount += childResult.visibleCount;
            }
        }

        const first = nodes[0]?.ref ?? null;
        const last = nodes[nodes.length - 1]?.ref ?? null;
        const visibleCount = nodes.reduce((total, node) => total + node.visibleCount, 0);

        return {
            first,
            last,
            visibleCount,
        };
    }

    const outlinesDict = doc.context.obj({}) as PDFDict;
    outlinesDict.set(typeName, PDFName.of('Outlines'));
    const outlinesRef = doc.context.register(outlinesDict);

    const tree = buildOutlineLevel(normalizedBookmarks, outlinesRef);
    if (!tree.first || !tree.last) {
        doc.catalog.delete(outlinesName);
        return new Uint8Array(await doc.save());
    }

    outlinesDict.set(firstName, tree.first);
    outlinesDict.set(lastName, tree.last);
    outlinesDict.set(countName, PDFNumber.of(tree.visibleCount));
    doc.catalog.set(outlinesName, outlinesRef);
    return new Uint8Array(await doc.save());
}
