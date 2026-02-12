import type { PDFPageProxy } from 'pdfjs-dist';

interface ICanvasRenderResult {
    canvas: HTMLCanvasElement;
    viewport: ReturnType<PDFPageProxy['getViewport']>;
    scaleX: number;
    scaleY: number;
    rawDims: {
        pageWidth: number;
        pageHeight: number 
    };
    userUnit: number;
    totalScaleFactor: number;
}

export const usePdfCanvasRenderer = (deps: {outputScale: number;}) => {
    const { outputScale } = deps;

    function cleanupCanvas(canvas: HTMLCanvasElement) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
    }

    async function renderCanvas(
        pdfPage: PDFPageProxy,
        scale: number,
    ): Promise<ICanvasRenderResult | null> {
        const viewport = pdfPage.getViewport({ scale });
        const userUnit = viewport.userUnit ?? 1;
        const totalScaleFactor = scale * userUnit;
        const rawDims = viewport.rawDims as {
            pageWidth: number;
            pageHeight: number 
        };

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) {
            return null;
        }

        const cssWidth = viewport.width;
        const cssHeight = viewport.height;
        const pixelWidth = Math.max(1, Math.round(cssWidth * outputScale));
        const pixelHeight = Math.max(1, Math.round(cssHeight * outputScale));

        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        canvas.style.display = 'block';
        canvas.style.margin = '0';

        const sx = pixelWidth / cssWidth;
        const sy = pixelHeight / cssHeight;

        const transform = sx !== 1 || sy !== 1
            ? [
                sx,
                0,
                0,
                sy,
                0,
                0,
            ]
            : undefined;

        const renderContext = {
            canvasContext: context,
            canvas,
            transform,
            viewport,
        };

        await pdfPage.render(renderContext).promise;

        return {
            canvas,
            viewport,
            scaleX: sx,
            scaleY: sy,
            rawDims,
            userUnit,
            totalScaleFactor,
        };
    }

    function applyContainerDimensions(
        container: HTMLElement,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        scale: number,
        userUnit: number,
        totalScaleFactor: number,
    ) {
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;
        container.style.setProperty('--scale-factor', String(scale));
        container.style.setProperty('--user-unit', String(userUnit));
        container.style.setProperty('--total-scale-factor', String(totalScaleFactor));
    }

    function mountCanvas(
        canvasHost: HTMLElement,
        canvas: HTMLCanvasElement,
        container: HTMLElement,
        renderedContainerClass: string,
    ) {
        canvasHost.innerHTML = '';
        canvasHost.appendChild(canvas);
        container.classList.add(renderedContainerClass);

        const skeleton = container.querySelector<HTMLElement>('.pdf-page-skeleton');
        if (skeleton) {
            skeleton.style.display = 'none';
        }
    }

    return {
        cleanupCanvas,
        renderCanvas,
        applyContainerDimensions,
        mountCanvas,
    };
};

export type TCanvasRenderResult = ICanvasRenderResult;
