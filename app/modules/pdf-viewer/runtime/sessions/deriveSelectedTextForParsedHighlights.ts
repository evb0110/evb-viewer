import {resolvePdfAnnotationPreviewTextFromMarkerRects} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/resolvePdfAnnotationPreviewText';
import type {IPdfTextPreviewItem} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/pdfAnnotationPreviewTextTypes';
import {pdfAnnotationRefKey} from '@app/modules/pdf-viewer/runtime/sessions/mapPdfAnnotationParseEntity';
import type {
    IPdfDocumentTransition,
    TPdfDocumentSession,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {BrowserLogger} from '@app/utils/browserLogger';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';

type TParsedHighlight = Extract<IPdfAnnotationParseResult['entities'][number], {kind: 'highlight'}>;
type TParsedHighlightPage = [number, TParsedHighlight[]];

const PARSED_HIGHLIGHT_TEXT_CONCURRENCY = 4;

export async function deriveSelectedTextForParsedHighlights({
    documentSession,
    result,
    transition,
    signal,
}: {
    documentSession: TPdfDocumentSession;
    result: IPdfAnnotationParseResult;
    transition: Pick<IPdfDocumentTransition, 'isCurrent'>;
    signal?: AbortSignal;
}) {
    const highlightsByPage = new Map<number, TParsedHighlight[]>();
    result.entities.forEach((entry) => {
        if (entry.kind !== 'highlight') {
            return;
        }
        const pageEntries = highlightsByPage.get(entry.pageIndex) ?? [];
        pageEntries.push(entry);
        highlightsByPage.set(entry.pageIndex, pageEntries);
    });
    const selectedTextByPdfRef = new Map<string, string | null>();
    const pageEntries = Array.from(highlightsByPage.entries());
    const concurrency = Math.min(PARSED_HIGHLIGHT_TEXT_CONCURRENCY, pageEntries.length);
    let nextPageIndex = 0;
    let stale = false;

    const resolvePage = async (pageEntry: TParsedHighlightPage) => {
        const pageIndex = pageEntry[0];
        const entries = pageEntry[1];
        if (stale || signal?.aborted || !transition.isCurrent()) {
            stale = true;
            return false;
        }
        let lease: Awaited<ReturnType<TPdfDocumentSession['leasePage']>> | null = null;
        try {
            lease = await documentSession.leasePage(pageIndex + 1, 'transient-background');
            if (signal?.aborted || !transition.isCurrent()) {
                stale = true;
                return false;
            }
            const pageViewport = lease.page.getViewport({scale: 1});
            const textContent = await lease.page.getTextContent({
                includeMarkedContent: true,
                disableNormalization: true,
            });
            if (signal?.aborted || !transition.isCurrent()) {
                stale = true;
                return false;
            }
            const textItems = textContent.items as IPdfTextPreviewItem[];
            entries.forEach((entry) => {
                selectedTextByPdfRef.set(
                    pdfAnnotationRefKey(entry.objectNumber, entry.generationNumber),
                    resolvePdfAnnotationPreviewTextFromMarkerRects(
                        entry.subtype,
                        entry.quadPoints,
                        textItems,
                        {
                            transform: [...pageViewport.transform],
                            width: pageViewport.width,
                            height: pageViewport.height,
                            scale: pageViewport.scale,
                        },
                    ),
                );
            });
            return true;
        } catch (error) {
            if (signal?.aborted || !transition.isCurrent()) {
                stale = true;
                return false;
            }
            BrowserLogger.debug(
                'annotations',
                `Failed to derive selected text for parsed highlights on page ${pageIndex + 1}`,
                error,
            );
            entries.forEach((entry) => {
                selectedTextByPdfRef.set(
                    pdfAnnotationRefKey(entry.objectNumber, entry.generationNumber),
                    null,
                );
            });
            return true;
        } finally {
            lease?.release();
        }
    };

    const workers = Array.from(
        {length: concurrency},
        async () => {
            while (!stale) {
                const pageEntry = pageEntries[nextPageIndex];
                nextPageIndex += 1;
                if (!pageEntry || !await resolvePage(pageEntry)) {
                    return;
                }
            }
        },
    );
    await Promise.all(workers);
    return stale || !transition.isCurrent() ? null : selectedTextByPdfRef;
}
