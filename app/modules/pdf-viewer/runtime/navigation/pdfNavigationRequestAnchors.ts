import type { IDocumentNavigationRequest } from '@app/modules/document-viewer/public';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';

export function getRequestPage(request: IDocumentNavigationRequest | undefined, fallback: number) {
    const target = request?.target;
    return target && 'page' in target ? target.page : fallback;
}

/**
 * The semantic anchor a navigation request asks for. A rect target keeps its
 * own centre; everything else lands on the top of the page, which is also the
 * anchor a fit change re-projects to because the pre-fit pixel offset stops
 * describing anything once every row's height is rewritten.
 */
export function getRequestAnchor(
    request: IDocumentNavigationRequest | undefined,
    fallbackPage: number,
): IPdfSemanticAnchor {
    const target = request?.target;
    const page = getRequestPage(request, fallbackPage);
    if (target?.kind === 'rect') {
        return {
            page,
            pageXFraction: target.rect.left + target.rect.width / 2,
            pageYFraction: target.rect.top + target.rect.height / 2,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
            affinity: 'center',
        };
    }
    return {
        page,
        pageXFraction: 0.5,
        pageYFraction: 0,
        viewportXFraction: 0.5,
        viewportYFraction: 0,
        affinity: 'start',
    };
}
