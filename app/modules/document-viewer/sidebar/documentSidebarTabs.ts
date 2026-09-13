export type TDocumentSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

export interface IDocumentSidebarCapabilities {
    annotations: boolean;
    bookmarks: boolean;
    pages: boolean;
    search: boolean;
}

export const DOCUMENT_SIDEBAR_TAB_ORDER = [
    'annotations',
    'thumbnails',
    'bookmarks',
    'search',
] as const satisfies readonly TDocumentSidebarTab[];

export function resolveDocumentSidebarTabs(
    capabilities: IDocumentSidebarCapabilities,
): TDocumentSidebarTab[] {
    return DOCUMENT_SIDEBAR_TAB_ORDER.filter((tab) => ({
        annotations: capabilities.annotations,
        thumbnails: capabilities.pages,
        bookmarks: capabilities.bookmarks,
        search: capabilities.search,
    })[tab]);
}

export function reconcileDocumentSidebarTab(
    current: TDocumentSidebarTab,
    available: readonly TDocumentSidebarTab[],
) {
    return available.includes(current)
        ? current
        : available.includes('thumbnails') ? 'thumbnails' : available[0] ?? null;
}
