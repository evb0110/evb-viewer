import type {IOcrWord} from '@contracts/shared';
import type {TOcrIndexRotation} from '@contracts/ocrIndex';
import {BrowserLogger} from '@app/utils/browserLogger';

export function transformWordBox(
    word: IOcrWord,
    imageDimensionWidth: number | undefined,
    imageDimensionHeight: number | undefined,
    renderedPageWidth: number,
    renderedPageHeight: number,
    rotation: TOcrIndexRotation = 0,
) {
    if (rotation !== 0) {
        BrowserLogger.warn('word-box', 'Unsupported rotated OCR word-box transform', {
            rotation,
            word: word.text,
        });
        throw new Error(
            `transformWordBox cannot map OCR boxes for rotated pages (${rotation} degrees); use transformOcrWordToViewport instead`,
        );
    }

    if (!imageDimensionWidth || !imageDimensionHeight) {
        BrowserLogger.warn('word-box', 'Missing dimensions', {
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

    if (Math.abs(scaleX - scaleY) > 0.05) {
        BrowserLogger.debug('word-box', 'Asymmetric OCR word-box scales detected', {
            scaleX: scaleX.toFixed(3),
            scaleY: scaleY.toFixed(3),
        });
    }

    const x = word.x * scaleX;
    const y = word.y * scaleY;
    const width = word.width * scaleX;
    const height = word.height * scaleY;

    if (y > renderedPageHeight || width > renderedPageWidth || height > renderedPageHeight) {
        BrowserLogger.warn('word-box', 'Box out of bounds', {
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
