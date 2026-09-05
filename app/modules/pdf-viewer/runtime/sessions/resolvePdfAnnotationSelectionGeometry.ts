import { BrowserLogger } from '@app/utils/browserLogger';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { getTextLayerTextMapping } from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import { buildTextLineBoxesFromTextContent } from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/buildTextLineBoxesFromTextContent';
import { mergeLineBoxesOnBaseline } from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/mergeLineBoxesOnBaseline';
import {
    buildHighlightQuadsFromSelection,
    type IHighlightSelectionPage,
    type IHighlightPageGeometry,
} from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/buildHighlightQuadsFromSelection';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';

export type TSelectionGeometryResolution =
    | {
        status: 'ready';
        pages: IHighlightPageGeometry[];
    }
    | {
        status: 'failed';
        reason: 'selection-not-in-text-layer';
    }
    | {status: 'stale'};

interface ISelectionPageCandidate extends IHighlightSelectionPage {readonly textLayer: HTMLElement;}

export interface IResolvePdfAnnotationSelectionGeometryOptions {
    readonly documentSession: TPdfDocumentSession;
    readonly viewerContainer: HTMLElement | null;
    readonly range: Range;
}

function selectionPageCandidates(
    range: Range,
    viewerContainer: HTMLElement | null,
): ISelectionPageCandidate[] {
    if (!viewerContainer) {
        return [];
    }
    return Array.from(viewerContainer.querySelectorAll<HTMLElement>('.page_container[data-page]'))
        .flatMap((pageContainer): ISelectionPageCandidate[] => {
            const textLayer = pageContainer.querySelector<HTMLElement>('.text-layer, .textLayer');
            const pageNumber = Number(pageContainer.dataset.page);
            if (!textLayer || !Number.isSafeInteger(pageNumber) || pageNumber < 1) {
                return [];
            }
            try {
                if (!range.intersectsNode(textLayer)) {
                    return [];
                }
            } catch {
                return [];
            }
            return [{
                pageNumber,
                pageContainer,
                textLayer,
                lineBoxes: [],
            }];
        });
}

export async function resolvePdfAnnotationSelectionGeometry(
    options: IResolvePdfAnnotationSelectionGeometryOptions,
): Promise<TSelectionGeometryResolution> {
    const {
        documentSession,
        range,
    } = options;
    const fence = documentSession.captureFence();
    const candidates = selectionPageCandidates(range, options.viewerContainer);
    if (candidates.length === 0) {
        return {
            status: 'failed',
            reason: 'selection-not-in-text-layer',
        };
    }

    const pages: IHighlightSelectionPage[] = [];
    for (const candidate of candidates) {
        const textMapping = getTextLayerTextMapping(candidate.textLayer);
        if (!textMapping) {
            continue;
        }

        let lease: Awaited<ReturnType<TPdfDocumentSession['leasePage']>> | null = null;
        try {
            lease = await documentSession.leasePage(candidate.pageNumber);
            if (!documentSession.isCurrent(fence)) {
                return {status: 'stale'};
            }
            const textContent = await lease.page.getTextContent({
                includeMarkedContent: true,
                disableNormalization: true,
            });
            if (!documentSession.isCurrent(fence)) {
                return {status: 'stale'};
            }
            const lineBoxes = mergeLineBoxesOnBaseline(buildTextLineBoxesFromTextContent({
                textContent,
                textMapping,
                pageView: [...lease.page.view],
                pageRotation: normalizePageRotation(lease.page.rotate),
            }));
            if (lineBoxes.length === 0) {
                continue;
            }
            pages.push({
                pageNumber: candidate.pageNumber,
                pageContainer: candidate.pageContainer,
                lineBoxes,
            });
        } catch (error) {
            if (!documentSession.isCurrent(fence)) {
                return {status: 'stale'};
            }
            BrowserLogger.debug(
                'annotations',
                `Failed to resolve selected text geometry on page ${candidate.pageNumber}`,
                error,
            );
            continue;
        } finally {
            lease?.release();
        }
    }

    if (!documentSession.isCurrent(fence)) {
        return {status: 'stale'};
    }
    const geometry = buildHighlightQuadsFromSelection(range, pages);
    return geometry.length > 0
        ? {
            status: 'ready',
            pages: geometry,
        }
        : {
            status: 'failed',
            reason: 'selection-not-in-text-layer',
        };
}
