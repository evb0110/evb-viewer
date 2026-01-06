import type { IOcrWord } from 'app/types/pdf';

export interface IWordBoxOverlay {
    x: number;
    y: number;
    width: number;
    height: number;
    isCurrent: boolean;
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
            wordCoords: { x: word.x, y: word.y, w: word.width, h: word.height },
            imageDim: { w: imageDimensionWidth, h: imageDimensionHeight },
            renderedDim: { w: renderedPageWidth, h: renderedPageHeight },
            scales: { scaleX, scaleY, uniformScale: scale },
            transformed: { x, y, width, height },
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

        // DEBUG: Log coordinate transformation details
        if (words && words.length > 0) {
            const scaleX = pdfPageWidth ? renderedPageWidth / pdfPageWidth : 0;
            const scaleY = pdfPageHeight ? renderedPageHeight / pdfPageHeight : 0;
            console.warn('[WordBoxes] CRITICAL COORDINATE SPACE MISMATCH CHECK', {
                pdfPageDimensions: { width: pdfPageWidth, height: pdfPageHeight },
                canvasDimensions: { offsetWidth: renderedPageWidth, offsetHeight: renderedPageHeight },
                calculatedScaleFactors: { scaleX: scaleX.toFixed(3), scaleY: scaleY.toFixed(3) },
                scalesMatch: (Math.abs(scaleX - scaleY) < 0.01) ? 'YES' : `NO - ASYMMETRIC! Diff: ${(scaleX - scaleY).toFixed(3)}`,
                firstWord: { text: words[0]?.text, originalY: words[0]?.y, scaledY: words[0] ? words[0].y * scaleY : 0 },
            });
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

    return {
        transformWordBox,
        createWordBoxOverlays,
        clearWordBoxes,
        renderPageWordBoxes,
    };
};
