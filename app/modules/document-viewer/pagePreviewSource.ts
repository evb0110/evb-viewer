import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    IResolvedSearchMatchOptions,
} from '@contracts/search';
import type {IPdfNativePageSizes} from '@contracts/electronApiDocuments';

export interface IDocumentPreviewPageState {
    failedRenderPx: number;
    objectUrl: string | null;
    renderedPx: number;
    status: 'idle' | 'loading' | 'loaded' | 'error';
    token: number;
}

export interface IPreviewPageSize {
    width: number;
    height: number;
    dpi?: number | undefined;
}

export type TPreviewPageSizes = readonly IPreviewPageSize[] | IPdfNativePageSizes;

export interface IPagePreviewSourceInfo {
    pageCount: number;
    pageNumber: number;
    pageSize: IPreviewPageSize;
}

export interface IPagePreviewRenderedObjectUrl {
    objectUrl: string;
    renderedPx: number;
    rasterWidthCeilingPx?: number;
    /**
     * Signals that the source has reclaimed and revoked this object URL.
     * Consumers must drop visual ownership without revoking it a second time.
     */
    onInvalidated?: (listener: () => void) => () => void;
    promotePriority?: (priority: number) => void;
}

export interface IPagePreviewOutlineItem {
    title: string;
    pageNumber: number | null;
    children: IPagePreviewOutlineItem[];
}

export interface IPagePreviewSource {
    readonly fullResolutionDecodeBeforeScale?: boolean;
    cancelPagePreview?(pageNumber: number, requestId?: string): void;
    getPageSizes(): Promise<TPreviewPageSizes>;
    getPageSize?(pageNumber: number): Promise<IPreviewPageSize>;
    getPageSourceInfo?(pageNumber: number): Promise<IPagePreviewSourceInfo>;
    getPageText?(pageNumber: number): Promise<string>;
    searchText?(request: {
        matchOptions: IResolvedSearchMatchOptions;
        onProgress?: ((progress: IPdfSearchProgress) => void) | undefined;
        pageCount: number;
        query: string;
        requestId: string;
        signal: AbortSignal;
    }): Promise<IPdfSearchResponse>;
    getOutline?(): Promise<IPagePreviewOutlineItem[]>;
    renderPageObjectUrl(
        pageNumber: number,
        options?: unknown,
    ): Promise<IPagePreviewRenderedObjectUrl>;
    revokeObjectURL(url: string): void;
    terminate(): void;
}

export class PagePreviewSourceDeadlineError extends Error {
    readonly retryable = true;

    constructor(message: string) {
        super(message);
        this.name = 'PagePreviewSourceDeadlineError';
    }
}

export async function getPagePreviewSizesWithDeadline(
    source: Pick<IPagePreviewSource, 'getPageSizes'>,
    deadlineMs: number,
) {
    const deadlineState: { timer: ReturnType<typeof setTimeout> | null } = {timer: null};
    const deadline = new Promise<never>((_resolve, reject) => {
        deadlineState.timer = setTimeout(() => {
            reject(new PagePreviewSourceDeadlineError(
                'Timed out while reading PDF page sizes. Retry opening the document.',
            ));
        }, deadlineMs);
    });
    try {
        return await Promise.race([
            source.getPageSizes(),
            deadline,
        ]);
    } finally {
        const deadlineTimer = deadlineState.timer;
        if (deadlineTimer !== null) {
            clearTimeout(deadlineTimer);
        }
    }
}
