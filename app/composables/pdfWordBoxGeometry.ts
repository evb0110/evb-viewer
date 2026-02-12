import type { PageViewport } from 'pdfjs-dist';
import type { IOcrWord } from '@app/types/pdf';
import { STORAGE_KEYS } from '@app/constants/storage-keys';

export interface IWordBoxOverlay {
    x: number;
    y: number;
    width: number;
    height: number;
    isCurrent: boolean;
}

interface IOcrIndexV2Page {
    pageNumber: number;
    rotation: 0 | 90 | 180 | 270;
    render: {
        dpi: number;
        imagePx: {
            w: number;
            h: number;
        };
    };
    text: string;
    words: IOcrWord[];
}

export type { IOcrIndexV2Page };

export function isOcrDebugEnabled(): boolean {
    if (typeof localStorage === 'undefined') {
        return false;
    }
    return localStorage.getItem(STORAGE_KEYS.OCR_DEBUG_BOXES) === '1';
}

export function transformWordBox(
    word: IOcrWord,
    imageDimensionWidth: number | undefined,
    imageDimensionHeight: number | undefined,
    renderedPageWidth: number,
    renderedPageHeight: number,
): IWordBoxOverlay {
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

    const scaleX = renderedPageWidth / imageDimensionWidth;
    const scaleY = renderedPageHeight / imageDimensionHeight;

    const scale = Math.min(scaleX, scaleY);
    if (Math.abs(scaleX - scaleY) > 0.05) {
        console.warn('[transformWordBox] ASYMMETRIC SCALES DETECTED - using uniform scaling', {
            scaleX: scaleX.toFixed(3),
            scaleY: scaleY.toFixed(3),
            usingUniformScale: scale.toFixed(3),
        });
    }

    const x = word.x * scale;
    const y = word.y * scale;
    const width = word.width * scale;
    const height = word.height * scale;

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

export function transformOcrWordToViewport(
    word: IOcrWord,
    ocrPageData: IOcrIndexV2Page,
    pageWidth: number,
    pageHeight: number,
    viewport: PageViewport,
): {
    x: number;
    y: number;
    width: number;
    height: number;
} | null {
    const imagePx = ocrPageData.render.imagePx;

    const sx = pageWidth / imagePx.w;
    const sy = pageHeight / imagePx.h;

    const pdfX = word.x * sx;
    const pdfY = pageHeight - (word.y + word.height) * sy;
    const pdfX2 = (word.x + word.width) * sx;
    const pdfY2 = pageHeight - word.y * sy;

    const rect = viewport.convertToViewportRectangle([
        pdfX,
        pdfY,
        pdfX2,
        pdfY2,
    ]);

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

export function createWordBoxOverlays(
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
            continue;
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
