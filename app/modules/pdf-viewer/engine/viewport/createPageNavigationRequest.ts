import type {IAnnotationMarkerRect} from '@app/types/annotations';
import type {
    IPdfSearchUtf16Range,
    ISearchMatchOptions,
} from '@contracts/search';

export interface IPdfTextAnchorNavigationOptions {
    text: string;
    prefix?: string;
    suffix?: string;
    searchRange?: IPdfSearchUtf16Range;
    pageMatchIndex?: number;
    matchIndex?: number;
    searchQuery?: string;
    searchOptions?: ISearchMatchOptions;
    /** Native count carried only for document-ordered results, authorizing equal-count ordinal identity. */
    expectedPageMatchCount?: number;
}

export type TPdfNavigationTarget =
    | {
        kind: 'page';
        page: number
    }
    | {
        kind: 'rect';
        page: number;
        rect: IAnnotationMarkerRect
    }
    | ({
        kind: 'text-anchor';
        page: number;
    } & IPdfTextAnchorNavigationOptions)
    | {
        kind: 'named-dest';
        destination: string | unknown[]
    };

export interface IPdfNavigationRequest {
    searchNavigationId?: number | undefined;
    target: TPdfNavigationTarget;
    alignment: 'page-top' | 'rect-center' | 'keep-visible';
    readiness: 'metrics' | 'page-canvas' | 'text-layer' | 'annotation-editor';
    postArrival?: 'search-highlight' | 'annotation-pulse' | 'flash';
    source: 'toolbar' | 'wheel' | 'search' | 'bookmark' | 'annotation' | 'thumbnail' | 'activation' | 'restore';
    supersession: 'latest-wins';
}

export function createPageNavigationRequest(
    page: number,
    source: IPdfNavigationRequest['source'],
): IPdfNavigationRequest {
    return {
        target: {
            kind: 'page',
            page,
        },
        alignment: 'page-top',
        readiness: 'page-canvas',
        source,
        supersession: 'latest-wins',
    };
}
