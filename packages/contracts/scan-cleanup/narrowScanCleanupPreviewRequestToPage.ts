import type {IScanCleanupPreviewRequest} from '@contracts/scan-cleanup/electronApiScanCleanup';

/**
 * Without a matched page size a preview reads only its own page's exception
 * and detected layout, so another page's edit must neither travel with it nor
 * change its identity. A matched preview plans the whole document's canvas and
 * keeps every page.
 */
export function narrowScanCleanupPreviewRequestToPage<
    TRequest extends Pick<IScanCleanupPreviewRequest, 'pageNumber' | 'options' | 'layoutByPage'>,
>(request: TRequest): TRequest {
    if (request.options.matchPageSize) {
        return request;
    }
    const pageKey = String(request.pageNumber);
    const override = request.options.pageOverrides[pageKey];
    const layout = request.layoutByPage?.[pageKey];
    return {
        ...request,
        options: {
            ...request.options,
            pageOverrides: override === undefined ? {} : {[pageKey]: override},
        },
        ...(request.layoutByPage === undefined
            ? {}
            : {layoutByPage: layout === undefined ? {} : {[pageKey]: layout}}),
    };
}
