import type { PageViewport } from 'pdfjs-dist';
import type { IOcrWord } from '@app/types/pdf';
import { getElectronAPI } from '@app/utils/electron';
import {
    isOcrDebugEnabled,
    transformWordBox,
    transformOcrWordToViewport,
    createWordBoxOverlays,
    type IOcrIndexV2Page,
} from '@app/composables/pdfWordBoxGeometry';

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
                console.warn('[WordBoxes] COORDINATE SPACE MISMATCH', {
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

        boxes.forEach(box => boxContainer!.appendChild(box));
    }

    function clearOcrDebugBoxes(container: HTMLElement) {
        const boxes = container.querySelectorAll('.pdf-ocr-debug-box');
        boxes.forEach(box => box.remove());
    }

    async function loadOcrPageData(
        workingCopyPath: string,
        pageNumber: number,
    ): Promise<IOcrIndexV2Page | null> {
        try {
            const api = getElectronAPI();
            const pageFile = `page-${String(pageNumber).padStart(4, '0')}.json`;
            const pagePath = `${workingCopyPath}.ocr/${pageFile}`;

            const exists = await api.fileExists(pagePath);
            if (!exists) {
                return null;
            }

            const content = await api.readTextFile(pagePath);
            return JSON.parse(content) as IOcrIndexV2Page;
        } catch (error) {
            console.warn('[OcrDebug] Failed to load OCR page data:', error);
            return null;
        }
    }

    async function renderOcrDebugBoxes(
        pageContainer: HTMLElement,
        pageNumber: number,
        workingCopyPath: string | null,
        viewport: PageViewport,
        pageWidth: number,
        pageHeight: number,
    ) {
        if (!isOcrDebugEnabled()) {
            return;
        }

        if (!workingCopyPath) {
            console.log('[OcrDebug] No working copy path, skipping debug boxes');
            return;
        }

        clearOcrDebugBoxes(pageContainer);

        const ocrPageData = await loadOcrPageData(workingCopyPath, pageNumber);

        if (!ocrPageData) {
            console.log(`[OcrDebug] No OCR index found for page ${pageNumber}`);
            return;
        }

        const words = ocrPageData.words;
        if (!words || words.length === 0) {
            console.log(`[OcrDebug] OCR index found but no words for page ${pageNumber}`);
            return;
        }

        console.log(`[OcrDebug] Rendering ${words.length} OCR debug boxes for page ${pageNumber}`, {
            imagePx: ocrPageData.render.imagePx,
            dpi: ocrPageData.render.dpi,
            rotation: ocrPageData.rotation,
            pageWidth,
            pageHeight,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
        });

        let debugLayer = pageContainer.querySelector<HTMLElement>('.pdf-ocr-debug-layer');
        if (!debugLayer) {
            debugLayer = document.createElement('div');
            debugLayer.className = 'pdf-ocr-debug-layer';
            debugLayer.style.cssText = `
                position: absolute;
                inset: 0;
                pointer-events: none;
                z-index: 10;
            `;
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
                border: 1px solid rgba(255, 140, 0, 0.7);
                background: rgba(255, 140, 0, 0.15);
                pointer-events: none;
                box-sizing: border-box;
            `;

            debugLayer.appendChild(boxDiv);
        }

        const renderedCount = words.length - transformErrors;
        console.log(`[OcrDebug] Page ${pageNumber}: rendered ${renderedCount}/${words.length} boxes`, {
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
