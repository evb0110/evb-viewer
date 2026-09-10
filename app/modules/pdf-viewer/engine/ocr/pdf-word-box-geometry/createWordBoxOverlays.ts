import type { IOcrWord } from '@contracts/shared';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import type { IPdfViewport } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { buildOcrWordKey } from '@contracts/ocrText';
import { transformWordBox } from '@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformWordBox';
import { transformOcrWordToViewport } from '@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformOcrWordToViewport';

export function createWordBoxOverlays(
    words: IOcrWord[],
    pdfPageWidth: number | undefined,
    pdfPageHeight: number | undefined,
    renderedPageWidth: number,
    renderedPageHeight: number,
    currentMatchWords?: Set<string>,
    rotation: TOcrIndexRotation = 0,
    viewport?: IPdfViewport,
): HTMLElement[] {
    if (words.length === 0) {
        return [];
    }

    const boxes: HTMLElement[] = [];
    const rawDims = viewport?.rawDims as {pageWidth?: unknown; pageHeight?: unknown} | undefined;
    const viewportPageWidth = typeof rawDims?.pageWidth === 'number' && rawDims.pageWidth > 0
        ? rawDims.pageWidth
        : pdfPageWidth ?? 0;
    const viewportPageHeight = typeof rawDims?.pageHeight === 'number' && rawDims.pageHeight > 0
        ? rawDims.pageHeight
        : pdfPageHeight ?? 0;

    for (const word of words) {
        const box = viewport
            ? transformOcrWordToViewport(
                word,
                {render: {imagePx: {w: pdfPageWidth ?? 0, h: pdfPageHeight ?? 0}}},
                viewportPageWidth,
                viewportPageHeight,
                viewport,
            )
            : transformWordBox(
                word,
                pdfPageWidth,
                pdfPageHeight,
                renderedPageWidth,
                renderedPageHeight,
                rotation,
            );

        if (!box || box.width === 0 || box.height === 0) {
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
            background: var(--app-pdf-search-highlight-bg);
            pointer-events: none;
            box-sizing: border-box;
        `;

        if (currentMatchWords?.has(buildOcrWordKey(word))) {
            boxDiv.classList.add('pdf-word-box--current');
            boxDiv.style.backgroundColor = 'var(--app-pdf-search-highlight-current-bg)';
        }

        boxes.push(boxDiv);
    }

    return boxes;
}
