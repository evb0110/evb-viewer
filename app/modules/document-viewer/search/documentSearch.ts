import type {
    IResolvedSearchMatchOptions,
    IPdfSearchExcerpt,
} from '@contracts/search';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import type { IOcrWord } from '@contracts/shared';
import type { Ref } from 'vue';

export interface IDocumentSearchMatch {
    pageIndex: number;
    pageMatchIndex?: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt?: IPdfSearchExcerpt;
    words?: readonly IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
    rotation?: TOcrIndexRotation;
}

export interface IDocumentSearchProgress {
    processed: number;
    total: number;
}

export interface IDocumentSearchResponse {
    results: IDocumentSearchMatch[];
    truncated: boolean;
}

export interface IDocumentSearchRequest {
    query: string;
    matchOptions: IResolvedSearchMatchOptions;
    signal: AbortSignal;
    onProgress?: ((progress: IDocumentSearchProgress) => void) | undefined;
}

/** Format-specific search execution behind a format-independent workspace session. */
export interface IDocumentSearchBackend {
    readonly minQueryLength: number;
    search(request: IDocumentSearchRequest): Promise<IDocumentSearchResponse>;
}

export type TDocumentSearchDirection = 'next' | 'previous';

/**
 * The reactive contract consumed by shared document-search presentation.
 * PDF search can adapt its richer match/highlight state to this interface.
 */
export interface IDocumentSearchSession {
    readonly query: Readonly<Ref<string>>;
    readonly submittedQuery: Readonly<Ref<string>>;
    readonly options: Readonly<Ref<IResolvedSearchMatchOptions>>;
    readonly results: Readonly<Ref<IDocumentSearchMatch[]>>;
    readonly currentResultIndex: Readonly<Ref<number>>;
    readonly currentResultNavigationId: Readonly<Ref<number>>;
    readonly isSearching: Readonly<Ref<boolean>>;
    readonly error: Readonly<Ref<string | null>>;
    readonly progress: Readonly<Ref<IDocumentSearchProgress | undefined>>;
    readonly isTruncated: Readonly<Ref<boolean>>;
    readonly minQueryLength: Readonly<Ref<number>>;
    setQuery(query: string): void;
    setOptions(options: IResolvedSearchMatchOptions): void;
    run(): Promise<boolean>;
    clear(): void;
    cancel(): void;
    select(index: number): boolean;
    navigate(direction: TDocumentSearchDirection): boolean;
}
