import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IBookmarkItem,
    IBookmarkLocation,
} from '@app/types/pdf-outline';

interface IRefProxy {
    num: number;
    gen: number;
}

export interface IOutlineItemRaw {
    title: string;
    dest: string | unknown[] | null;
    bold?: boolean;
    italic?: boolean;
    color?: ArrayLike<number> | null;
    items?: IOutlineItemRaw[];
}

function isRefProxy(value: unknown): value is IRefProxy {
    return (
        typeof value === 'object'
        && value !== null
        && 'num' in value
        && 'gen' in value
        && typeof (value as IRefProxy).num === 'number'
        && typeof (value as IRefProxy).gen === 'number'
    );
}

export { isRefProxy };

export function convertOutlineColorToHex(color: ArrayLike<number> | null | undefined): string | null {
    if (!color || typeof color.length !== 'number' || color.length < 3) {
        return null;
    }

    const parts = [
        color[0],
        color[1],
        color[2],
    ];

    const rgb = parts.map((value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return 0;
        }
        return Math.max(0, Math.min(255, Math.round(numeric)));
    });

    return `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

export async function resolvePageIndex(
    pdfDocument: PDFDocumentProxy,
    dest: IOutlineItemRaw['dest'],
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
): Promise<number | null> {
    if (!dest) {
        return null;
    }

    let destinationArray: unknown[] | null = null;

    if (typeof dest === 'string') {
        if (destinationCache.has(dest)) {
            destinationArray = destinationCache.get(dest) ?? null;
        } else {
            try {
                destinationArray = await pdfDocument.getDestination(dest);
            } catch {
                destinationArray = null;
            }
            destinationCache.set(dest, destinationArray);
        }
    } else if (Array.isArray(dest)) {
        destinationArray = dest;
    }

    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    const pageRef = destinationArray[0];

    if (typeof pageRef === 'number' && Number.isFinite(pageRef)) {
        const maybeIndex = Math.trunc(pageRef);
        if (maybeIndex >= 0 && maybeIndex < pdfDocument.numPages) {
            return maybeIndex;
        }
        if (maybeIndex > 0 && maybeIndex <= pdfDocument.numPages) {
            return maybeIndex - 1;
        }
        return null;
    }

    if (!isRefProxy(pageRef)) {
        return null;
    }

    const refKey = `${pageRef.num}:${pageRef.gen}`;
    if (refIndexCache.has(refKey)) {
        return refIndexCache.get(refKey) ?? null;
    }

    try {
        const pageIndex = await pdfDocument.getPageIndex(pageRef);
        refIndexCache.set(refKey, pageIndex);
        return pageIndex;
    } catch {
        refIndexCache.set(refKey, null);
        return null;
    }
}

export async function buildResolvedOutline(
    items: IOutlineItemRaw[],
    pdfDocument: PDFDocumentProxy,
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
    createId: () => string,
): Promise<IBookmarkItem[]> {
    return Promise.all(
        items.map(async (item) => {
            const pageIndex = await resolvePageIndex(
                pdfDocument,
                item.dest,
                destinationCache,
                refIndexCache,
            );
            const children = item.items?.length
                ? await buildResolvedOutline(
                    item.items,
                    pdfDocument,
                    destinationCache,
                    refIndexCache,
                    createId,
                )
                : [];

            return {
                title: item.title,
                dest: item.dest,
                id: createId(),
                pageIndex,
                bold: item.bold === true,
                italic: item.italic === true,
                color: convertOutlineColorToHex(item.color),
                items: children,
            };
        }),
    );
}

export async function resolveBookmarkDestinationPage(
    pdfDocument: PDFDocumentProxy,
    dest: string | unknown[] | null,
): Promise<number | null> {
    if (!dest) {
        return null;
    }

    let destinationArray: unknown[] | null = null;

    if (typeof dest === 'string') {
        try {
            destinationArray = await pdfDocument.getDestination(dest);
        } catch {
            return null;
        }
    } else if (Array.isArray(dest)) {
        destinationArray = dest;
    }

    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    const pageRef = destinationArray[0];

    if (typeof pageRef === 'number' && Number.isFinite(pageRef)) {
        const maybeIndex = Math.trunc(pageRef);
        if (maybeIndex >= 0 && maybeIndex < pdfDocument.numPages) {
            return maybeIndex + 1;
        }
        if (maybeIndex > 0 && maybeIndex <= pdfDocument.numPages) {
            return maybeIndex;
        }
        return null;
    }

    if (!isRefProxy(pageRef)) {
        return null;
    }

    try {
        const pageIndex = await pdfDocument.getPageIndex(pageRef);
        return pageIndex + 1;
    } catch {
        return null;
    }
}

export function findBookmarkLocation(
    items: IBookmarkItem[],
    id: string,
    parent: IBookmarkItem | null = null,
): IBookmarkLocation | null {
    for (const [
        index,
        item,
    ] of items.entries()) {
        if (item.id === id) {
            return {
                parent,
                list: items,
                index,
                item,
            };
        }

        const child = findBookmarkLocation(item.items, id, item);
        if (child) {
            return child;
        }
    }

    return null;
}

export function findBookmarkById(items: IBookmarkItem[], id: string): IBookmarkItem | null {
    for (const item of items) {
        if (item.id === id) {
            return item;
        }
        const child = findBookmarkById(item.items, id);
        if (child) {
            return child;
        }
    }

    return null;
}

export function collectBookmarkIds(item: IBookmarkItem, ids: Set<string>) {
    ids.add(item.id);
    for (const child of item.items) {
        collectBookmarkIds(child, ids);
    }
}

export function normalizeBookmarkColor(color: string | null | undefined): string | null {
    if (typeof color !== 'string') {
        return null;
    }

    const value = color.trim().toLowerCase();
    const shortHexMatch = /^#([0-9a-f]{3})$/.exec(value);
    if (shortHexMatch) {
        const triple = shortHexMatch[1];
        if (!triple) {
            return null;
        }
        const [
            r,
            g,
            b,
        ] = triple.split('');
        return `#${r}${r}${g}${g}${b}${b}`;
    }

    return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}
