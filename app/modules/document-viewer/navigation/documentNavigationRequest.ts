import type {IAnnotationMarkerRect} from '@app/types/annotations';
import type {
    IPdfSearchUtf16Range,
    ISearchMatchOptions,
} from '@contracts/search';

export interface IDocumentTextAnchorNavigationOptions {
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

export type TDocumentNavigationTarget =
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
    } & IDocumentTextAnchorNavigationOptions)
    | {
        kind: 'named-dest';
        destination: string | unknown[]
    };

export interface IDocumentNavigationRequest {
    searchNavigationId?: number | undefined;
    target: TDocumentNavigationTarget;
    alignment: 'page-top' | 'rect-center' | 'keep-visible';
    readiness: 'metrics' | 'page-canvas' | 'text-layer' | 'annotation-editor';
    postArrival?: 'search-highlight' | 'annotation-pulse' | 'flash';
    source: 'toolbar' | 'wheel' | 'search' | 'bookmark' | 'annotation' | 'thumbnail' | 'activation' | 'restore';
    supersession: 'latest-wins';
}

export type TDocumentNavigationOutcome =
    | {
        readonly kind: 'arrived';
        readonly page: number
    }
    | {
        readonly kind: 'superseded';
        readonly by: 'command' | 'user-input'
    }
    | { readonly kind: 'document-ended' }
    | {
        readonly kind: 'failed';
        readonly reason: string
    };

/** One accepted semantic request. Geometry and painting never replace it. */
export interface IDocumentNavigationTicket {
    readonly generation: number;
    readonly documentRevision: string;
    readonly id: string;
    readonly request: IDocumentNavigationRequest;
    /** Retired synchronously by a newer command, physical input, or close. */
    readonly signal: AbortSignal;
    readonly finished: Promise<TDocumentNavigationOutcome>;
}

/** Reports describe execution of an existing ticket; none creates a command. */
export type TDocumentNavigationReport =
    | {
        readonly kind: 'resolved';
        readonly page: number
    }
    | {
        readonly kind: 'placed';
        readonly page: number;
        readonly left: number;
        readonly top: number;
        readonly geometryRevision: number;
        readonly interactionEpoch: number;
    }
    | {
        readonly kind: 'arrived';
        readonly page: number
    }
    | {
        readonly kind: 'failed';
        readonly reason: string
    }
    | {
        readonly kind: 'abandoned';
        readonly by: 'command' | 'user-input'
    };

export function createPageNavigationRequest(
    page: number,
    source: IDocumentNavigationRequest['source'],
): IDocumentNavigationRequest {
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
