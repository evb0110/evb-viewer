import type { PageViewport } from 'pdfjs-dist';
import type { IOcrWord } from '@app/types/pdf';
import { getElectronAPI } from '@app/utils/electron';

export interface IWordBoxOverlay {
    x: number;
    y: number;
    width: number;
    height: number;
    isCurrent: boolean;
}

/**
 * OCR Index v2 page data schema (matches electron/ocr/ocr-worker.ts)
 */
interface IOcrIndexV2Page {
    pageNumber: number;
    rotation: 0 | 90 | 180 | 270;
    render: {
        dpi: number;
        imagePx: {
            w: number;
            h: number 
        };
    };
    text: string;
    words: IOcrWord[];
}

/**
 * Check if OCR debug mode is enabled via localStorage flag.
 * When enabled, renders OCR word boxes from the OCR index for alignment validation.
 */
function isOcrDebugEnabled(): boolean {
    if (typeof localStorage === 'undefined') {
        return false;
    }
    return localStorage.getItem('pdfOcrDebugBoxes') === '1';
}

/**
 * Transform word box coordinates from image space to rendered screen space
 *
 * Word boxes come from OCR (Tesseract) output, which extracts coordinates
 * from a rendered image of the PDF. Both the image and rendered page have
 * top-left origin with Y increasing downward, so only scaling is needed.
 *
 * Transformation:
 * Scale from image coordinates to rendered page dimensions based on DPI/zoom
 */
function transformWordBox(
    word: IOcrWord,
    imageDimensionWidth: number | undefined,
    imageDimensionHeight: number | undefined,
    renderedPageWidth: number,
    renderedPageHeight: number,
): IWordBoxOverlay {
    // If we don't have image dimensions, we can't transform properly
    // Return zero-sized box as fallback
    if (!imageDimensionWidth || !imageDimensionHeight) {
        console.warn('[transformWordBox] Missing dimensions:', {
            imageDimensionWidth,
            imageDimensionHeight,
            renderedPageWidth,
            renderedPageHeight,
            word: word.text,
        });
        return {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            isCurrent: false,
        };
    }

    // Calculate scale factors from image space to rendered space
    const scaleX = renderedPageWidth / imageDimensionWidth;
    const scaleY = renderedPageHeight / imageDimensionHeight;

    // CRITICAL FIX: Use UNIFORM scaling to prevent distortion
    // If scales are asymmetric (e.g., scaleX=1.606, scaleY=1.021), the canvas is likely
    // rendered at a different aspect ratio than the PDF. Use the smaller scale (Y) for both
    // to keep text proportions correct and avoid overflow.
    // This maintains text aspect ratio even if the canvas has unusual proportions.
    const scale = Math.min(scaleX, scaleY);
    if (Math.abs(scaleX - scaleY) > 0.05) {
        console.warn('[transformWordBox] ASYMMETRIC SCALES DETECTED - using uniform scaling', {
            scaleX: scaleX.toFixed(3),
            scaleY: scaleY.toFixed(3),
            usingUniformScale: scale.toFixed(3),
        });
    }

    // Transform coordinates (no flipping needed - both are top-left origin)
    const x = word.x * scale;
    const y = word.y * scale;
    const width = word.width * scale;
    const height = word.height * scale;

    // Log problematic boxes (very large or off-screen)
    if (y > renderedPageHeight || width > renderedPageWidth || height > renderedPageHeight) {
        console.error('[transformWordBox] BOX OUT OF BOUNDS:', {
            word: word.text,
            wordCoords: {
                x: word.x,
                y: word.y,
                w: word.width,
                h: word.height, 
            },
            imageDim: {
                w: imageDimensionWidth,
                h: imageDimensionHeight, 
            },
            renderedDim: {
                w: renderedPageWidth,
                h: renderedPageHeight, 
            },
            scales: {
                scaleX,
                scaleY,
                uniformScale: scale, 
            },
            transformed: {
                x,
                y,
                width,
                height, 
            },
            isOffScreen: y > renderedPageHeight,
            relativePos: {
                yPercent: ((y / renderedPageHeight) * 100).toFixed(1),
                widthPercent: ((width / renderedPageWidth) * 100).toFixed(1),
                heightPercent: ((height / renderedPageHeight) * 100).toFixed(1),
            },
        });
    }

    return {
        x,
        y,
        width,
        height,
        isCurrent: false,
    };
}

export const usePdfWordBoxes = () => {
    /**
     * Create word box overlays for a page
     * Returns HTML elements for each word box that should be rendered
     */
    function createWordBoxOverlays(
        words: IOcrWord[],
        pdfPageWidth: number | undefined,
        pdfPageHeight: number | undefined,
        renderedPageWidth: number,
        renderedPageHeight: number,
        currentMatchWords?: Set<string>,
    ): HTMLElement[] {
        if (!words || words.length === 0) {
            return [];
        }

        const boxes: HTMLElement[] = [];

        for (const word of words) {
            const box = transformWordBox(
                word,
                pdfPageWidth,
                pdfPageHeight,
                renderedPageWidth,
                renderedPageHeight,
            );

            if (box.width === 0 || box.height === 0) {
                continue; // Skip empty boxes
            }

            const boxDiv = document.createElement('div');
            boxDiv.className = 'pdf-word-box';
            boxDiv.setAttribute('data-word', word.text);
            boxDiv.style.cssText = `
                position: absolute;
                left: ${box.x}px;
                top: ${box.y}px;
                width: ${box.width}px;
                height: ${box.height}px;
                border: 1px solid rgba(0, 100, 255, 0.4);
                background: rgba(0, 100, 255, 0.1);
                pointer-events: none;
                box-sizing: border-box;
            `;

            if (currentMatchWords?.has(word.text)) {
                boxDiv.classList.add('pdf-word-box--current');
                boxDiv.style.backgroundColor = 'rgba(0, 150, 255, 0.25)';
                boxDiv.style.borderColor = 'rgba(0, 150, 255, 0.8)';
            }

            boxes.push(boxDiv);
        }

        return boxes;
    }

    /**
     * Clear all word box overlays from a container
     */
    function clearWordBoxes(container: HTMLElement) {
        const boxes = container.querySelectorAll('.pdf-word-box');
        boxes.forEach(box => box.remove());
    }

    /**
     * Render word boxes for matched words on a page
     * Should be called for each page that has matches
     */
    function renderPageWordBoxes(
        pageContainer: HTMLElement,
        words: IOcrWord[],
        pdfPageWidth: number | undefined,
        pdfPageHeight: number | undefined,
        currentMatchWords?: Set<string>,
    ): void {
        // Find the page canvas to get rendered dimensions
        const canvas = pageContainer.querySelector<HTMLCanvasElement>('canvas');
        if (!canvas) {
            return; // Canvas not rendered yet
        }

        const renderedPageWidth = canvas.offsetWidth;
        const renderedPageHeight = canvas.offsetHeight;

        // DEBUG: Log coordinate transformation details only when we detect a mismatch
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

        // Clear existing boxes
        clearWordBoxes(pageContainer);

        // Create and append new boxes
        const boxes = createWordBoxOverlays(
            words,
            pdfPageWidth,
            pdfPageHeight,
            renderedPageWidth,
            renderedPageHeight,
            currentMatchWords,
        );

        // Create a container for word boxes (positioned absolutely over the page)
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

    /**
     * Clear OCR debug boxes from a container
     */
    function clearOcrDebugBoxes(container: HTMLElement) {
        const boxes = container.querySelectorAll('.pdf-ocr-debug-box');
        boxes.forEach(box => box.remove());
    }

    /**
     * Load OCR page data from the OCR index v2 directory.
     * Returns null if no OCR index exists or page is not OCR'd.
     */
    async function loadOcrPageData(
        workingCopyPath: string,
        pageNumber: number,
    ): Promise<IOcrIndexV2Page | null> {
        try {
            const api = getElectronAPI();
            const pageFile = `page-${String(pageNumber).padStart(4, '0')}.json`;
            const pagePath = `${workingCopyPath}.ocr/${pageFile}`;

            // Check if OCR index exists
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

    /**
     * Transform OCR word coordinates from pixel space to viewport screen coordinates.
     *
     * The OCR index stores word boxes in pixel coordinates (from the rasterized image).
     * We need to convert these to screen coordinates matching the current viewport.
     *
     * Transformation steps:
     * 1. Scale from OCR image pixels to PDF user space
     * 2. Use viewport.convertToViewportRectangle to get screen coordinates
     */
    function transformOcrWordToViewport(
        word: IOcrWord,
        ocrPageData: IOcrIndexV2Page,
        pageWidth: number,
        pageHeight: number,
        viewport: PageViewport,
    ): {
        x: number;
        y: number;
        width: number;
        height: number 
    } | null {
        const imagePx = ocrPageData.render.imagePx;

        // Scale from OCR pixels to PDF user space
        // OCR coordinates are in raster pixel space; PDF user space is typically 72 DPI
        const sx = pageWidth / imagePx.w;
        const sy = pageHeight / imagePx.h;

        // Convert word pixel coords to PDF user space
        // Note: OCR y is top-down (image space), PDF y is bottom-up
        const pdfX = word.x * sx;
        const pdfY = pageHeight - (word.y + word.height) * sy; // Flip Y
        const pdfX2 = (word.x + word.width) * sx;
        const pdfY2 = pageHeight - word.y * sy;

        // Use PDF.js viewport to convert to screen coordinates
        // convertToViewportRectangle takes [x1, y1, x2, y2] in PDF user space
        // and returns [screenX1, screenY1, screenX2, screenY2]
        const rect = viewport.convertToViewportRectangle([
            pdfX,
            pdfY,
            pdfX2,
            pdfY2,
        ]);

        // The returned rect may have coordinates in any order depending on rotation
        // Normalize to [left, top, right, bottom]
        const [
            x1,
            y1,
            x2,
            y2,
        ] = rect;
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);

        return {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        };
    }

    /**
     * Render OCR debug boxes from the OCR index for alignment validation.
     *
     * This function:
     * 1. Loads OCR page data from the index
     * 2. Transforms word pixel coords to viewport screen coords
     * 3. Renders colored boxes (orange) to distinguish from regular word boxes (blue)
     *
     * Enable with: localStorage.setItem('pdfOcrDebugBoxes', '1')
     */
    async function renderOcrDebugBoxes(
        pageContainer: HTMLElement,
        pageNumber: number,
        workingCopyPath: string | null,
        viewport: PageViewport,
        pageWidth: number,
        pageHeight: number,
    ): Promise<void> {
        // Check if debug mode is enabled
        if (!isOcrDebugEnabled()) {
            return;
        }

        if (!workingCopyPath) {
            console.log('[OcrDebug] No working copy path, skipping debug boxes');
            return;
        }

        // Clear existing debug boxes first
        clearOcrDebugBoxes(pageContainer);

        // Load OCR page data from index
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

        // Get or create the debug layer
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

        // Track transformation issues for debugging
        let transformErrors = 0;

        // Render each word box
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

        // Log summary
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
