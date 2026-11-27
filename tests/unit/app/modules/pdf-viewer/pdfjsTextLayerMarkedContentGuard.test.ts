// @vitest-environment happy-dom

import {afterEach, describe, expect, it, vi} from 'vitest';
import {createPdfjsTextLayer} from '@app/services/pdfjs/pdfViewerFacade';

/**
 * A scanned or otherwise malformed PDF can stream more `endMarkedContent`
 * operators than it opened. Stock pdf.js walks `parentNode` for each one, so an
 * unbalanced run climbs out of the text layer, past the document, and lands on
 * `null`; the next `beginMarkedContent` then throws inside the reader pump,
 * where the throw surfaced only as an unhandled rejection and left the page's
 * text layer promise pending forever. The EVB fork stops the climb at the
 * layer's own root and routes any remaining pump error into the render
 * promise. This pins the behavior in both generated builds.
 */
const FONT_NAME = 'g_d0_f1';

const TEXT_CONTENT_STYLES = {
    [FONT_NAME]: {
        ascent: 0.8,
        descent: -0.2,
        fontFamily: 'sans-serif',
        vertical: false,
    },
};

const VIEWPORT = {
    rawDims: {
        pageHeight: 100,
        pageWidth: 100,
        pageX: 0,
        pageY: 0,
    },
    rotation: 0,
    scale: 1,
};

function markedContentItem(type: string) {
    return {
        str: undefined,
        type,
    };
}

function textItem(str: string) {
    return {
        dir: 'ltr',
        fontName: FONT_NAME,
        hasEOL: false,
        height: 10,
        str,
        transform: [10, 0, 0, 10, 0, 0],
        width: 10,
    };
}

/**
 * pdf.js measures glyphs on a real 2D context to lay text out. happy-dom has no
 * canvas, so the layout numbers come from this stub; the assertions below are
 * about DOM structure, not geometry.
 */
function stubCanvasMeasurement() {
    const canvas = document.createElement('canvas');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () =>
            ({
                canvas,
                font: '',
                measureText: (text: string) => ({
                    fontBoundingBoxAscent: 8,
                    fontBoundingBoxDescent: 2,
                    width: text.length * 5,
                }),
            }) as never,
    );
}

describe('pdfjs text layer marked content guard', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('keeps rendering into its own container when marked content is unbalanced', async () => {
        stubCanvasMeasurement();
        const container = document.createElement('div');
        document.body.append(container);

        const textLayer = createPdfjsTextLayer({
            container,
            textContentSource: {
                items: [
                    markedContentItem('beginMarkedContent'),
                    markedContentItem('endMarkedContent'),
                    markedContentItem('endMarkedContent'),
                    markedContentItem('endMarkedContent'),
                    markedContentItem('beginMarkedContent'),
                    textItem('page text'),
                ],
                styles: TEXT_CONTENT_STYLES,
            },
            viewport: VIEWPORT,
        } as never);

        await expect(textLayer.render()).resolves.toBeUndefined();
        expect(container.textContent).toContain('page text');
        expect(document.body.textContent).toBe(container.textContent);
    });

    it('rejects the render promise instead of leaving it pending when the stream fails', async () => {
        stubCanvasMeasurement();
        const container = document.createElement('div');
        document.body.append(container);

        const textLayer = createPdfjsTextLayer({
            container,
            textContentSource: {
                items: [{str: 'unreadable'}],
                styles: {},
            },
            viewport: VIEWPORT,
        } as never);

        await expect(textLayer.render()).rejects.toBeInstanceOf(Error);
    });
});
