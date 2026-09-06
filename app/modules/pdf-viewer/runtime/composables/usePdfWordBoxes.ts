import type {IPdfViewport} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IOcrWord } from '@contracts/shared';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import type { IDocumentTextCatalogPage } from '@contracts/documentTextCatalog';
import { createWordBoxOverlays } from '@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/createWordBoxOverlays';
import { isOcrDebugEnabled } from '@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/isOcrDebugEnabled';
import { loadSharedDocumentOcrPage } from '@app/modules/pdf-viewer/engine/document-text-catalog/sharedDocumentTextCatalogCache';
import { transformOcrWordToViewport } from '@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformOcrWordToViewport';
import { transformWordBox } from '@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformWordBox';
import { BrowserLogger } from '@app/utils/browserLogger';

export const usePdfWordBoxes = () => {
    function clearWordBoxes(container: HTMLElement) {
        const boxes = container.querySelectorAll('.pdf-word-box');
        boxes.forEach(box => box.remove());
    }

    function renderPageWordBoxes(
        pageContainer: HTMLElement,
        words: IOcrWord[],
        pdfPageWidth: number | undefined,
        pdfPageHeight: number | undefined,
        currentMatchWords?: Set<string>,
        rotation: TOcrIndexRotation = 0,
    ) {
        const canvas = pageContainer.querySelector<HTMLCanvasElement>('canvas');
        if (!canvas) {
            return;
        }

        const renderedPageWidth = canvas.offsetWidth;
        const renderedPageHeight = canvas.offsetHeight;

        if (words && words.length > 0 && pdfPageWidth && pdfPageHeight) {
            const scaleX = renderedPageWidth / pdfPageWidth;
            const scaleY = renderedPageHeight / pdfPageHeight;
            const diff = Math.abs(scaleX - scaleY);
            if (diff >= 0.01) {
                BrowserLogger.warn('word-boxes', 'Coordinate space mismatch', {
                    pdfPageDimensions: {
                        width: pdfPageWidth,
                        height: pdfPageHeight,
                    },
                    canvasDimensions: {
                        offsetWidth: renderedPageWidth,
                        offsetHeight: renderedPageHeight,
                    },
                    calculatedScaleFactors: {
                        scaleX: scaleX.toFixed(3),
                        scaleY: scaleY.toFixed(3),
                    },
                    diff: diff.toFixed(3),
                    firstWord: {
                        text: words[0]?.text,
                        originalY: words[0]?.y,
                        scaledY: words[0] ? words[0].y * scaleY : 0,
                    },
                });
            }
        }

        clearWordBoxes(pageContainer);

        const boxes = createWordBoxOverlays(
            words,
            pdfPageWidth,
            pdfPageHeight,
            renderedPageWidth,
            renderedPageHeight,
            currentMatchWords,
            rotation,
        );

        let boxContainer = pageContainer.querySelector<HTMLElement>('.pdf-word-boxes-layer');
        if (!boxContainer) {
            boxContainer = document.createElement('div');
            boxContainer.className = 'pdf-word-boxes-layer';
            boxContainer.style.cssText = `
                position: absolute;
                inset: 0;
                pointer-events: none;
            `;
            pageContainer.appendChild(boxContainer);
        }

        boxes.forEach(box => boxContainer.appendChild(box));
    }

    function clearOcrDebugBoxes(container: HTMLElement) {
        const boxes = container.querySelectorAll('.pdf-ocr-debug-box');
        boxes.forEach(box => box.remove());
    }

    async function loadOcrPageData(
        workingCopyPath: TDocumentRef,
        documentRevisionToken: TDocumentRevisionToken,
        pageNumber: number,
    ): Promise<IDocumentTextCatalogPage | null> {
        return loadSharedDocumentOcrPage(workingCopyPath, documentRevisionToken, pageNumber);
    }

    async function renderOcrDebugBoxes(
        pageContainer: HTMLElement,
        pageNumber: number,
        workingCopyPath: TDocumentRef | null,
        documentRevisionToken: TDocumentRevisionToken | null,
        viewport: IPdfViewport,
        pageWidth: number,
        pageHeight: number,
    ) {
        if (!isOcrDebugEnabled()) {
            return;
        }

        if (!workingCopyPath || !documentRevisionToken) {
            BrowserLogger.debug('ocr-debug', 'No working copy path, skipping debug boxes');
            return;
        }

        clearOcrDebugBoxes(pageContainer);

        const ocrPageData = await loadOcrPageData(workingCopyPath, documentRevisionToken, pageNumber);

        if (!ocrPageData?.render) {
            BrowserLogger.debug('ocr-debug', `No OCR index found for page ${pageNumber}`);
            return;
        }

        const words = ocrPageData.words;
        if (!words || words.length === 0) {
            BrowserLogger.debug('ocr-debug', `OCR index found but no words for page ${pageNumber}`);
            return;
        }

        BrowserLogger.debug('ocr-debug', `Rendering ${words.length} OCR debug boxes for page ${pageNumber}`, {
            imagePx: ocrPageData.render.imagePx,
            dpi: ocrPageData.render.dpi,
            rotation: 0,
            pageWidth,
            pageHeight,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
        });

        let debugLayer = pageContainer.querySelector<HTMLElement>('.pdf-ocr-debug-layer');
        if (!debugLayer) {
            debugLayer = document.createElement('div');
            debugLayer.className = 'pdf-ocr-debug-layer';
            pageContainer.appendChild(debugLayer);
        }

        let transformErrors = 0;

        for (const word of words) {
            const transformed = transformOcrWordToViewport(
                word,
                ocrPageData,
                pageWidth,
                pageHeight,
                viewport,
            );

            if (!transformed || transformed.width <= 0 || transformed.height <= 0) {
                transformErrors++;
                continue;
            }

            const boxDiv = document.createElement('div');
            boxDiv.className = 'pdf-ocr-debug-box';
            boxDiv.setAttribute('data-word', word.text);
            boxDiv.style.cssText = `
                position: absolute;
                left: ${transformed.x}px;
                top: ${transformed.y}px;
                width: ${transformed.width}px;
                height: ${transformed.height}px;
                pointer-events: none;
                box-sizing: border-box;
            `;

            debugLayer.appendChild(boxDiv);
        }

        const renderedCount = words.length - transformErrors;
        BrowserLogger.debug('ocr-debug', `Page ${pageNumber}: rendered ${renderedCount}/${words.length} boxes`, {
            transformErrors,
            sampleWord: words[0] ? {
                text: words[0].text,
                originalCoords: {
                    x: words[0].x,
                    y: words[0].y,
                    w: words[0].width,
                    h: words[0].height,
                },
            } : null,
        });
    }

    return {
        transformWordBox,
        createWordBoxOverlays,
        clearWordBoxes,
        renderPageWordBoxes,
        isOcrDebugEnabled,
        clearOcrDebugBoxes,
        renderOcrDebugBoxes,
    };
};
