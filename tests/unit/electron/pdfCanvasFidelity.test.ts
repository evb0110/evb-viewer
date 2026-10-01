import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DOMMatrix,
    ImageData,
    Path2D,
    createCanvas,
} from '@napi-rs/canvas';
import {
    PDFDocument,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import {isRecord} from '@contracts/runtimeGuards';
import { renderPdfCanvasFidelityMetrics } from '@tests/helpers/renderPdfCanvasFidelityMetrics';

const fixtures = [
    {
        file: 'generated-text.pdf',
        expected: {
            dark: 0.00418,
            ink: 0.01147,
            luminance: {
                max: 253.922,
                min: 253.822,
            },
            textItems: 6,
        },
    },
    {
        file: 'freetext-lifecycle-test.pdf',
        expected: {
            dark: 0.00448,
            // PDF.js 6.3.311's forked text rendering changes the anti-aliased
            // edge coverage for this fixture. Keep the measured value pinned.
            ink: 0.00769,
            luminance: {
                max: 253.945,
                min: 253.818,
            },
            textItems: 3,
        },
    },
    {
        file: 'test-scanned.pdf',
        expected: {
            dark: 0.01040,
            ink: 0.01284,
            luminance: {
                max: 252.259,
                min: 252.159,
            },
            textItems: 0,
        },
    },
] as const;

describe('PDF canvas fidelity corpus', () => {
    for (const fixture of fixtures) {
        it(`renders ${fixture.file} at its matched physical scale`, async () => {
            const metrics = await renderPdfCanvasFidelityMetrics(resolve(
                process.cwd(),
                'tests/fixtures/electron',
                fixture.file,
            ));

            expect(metrics.width).toBe(612);
            expect(metrics.height).toBe(792);
            expect(metrics.textItemCount).toBe(fixture.expected.textItems);
            expect(metrics.inkPixelRatio).toBeCloseTo(fixture.expected.ink, 3);
            expect(metrics.darkPixelRatio).toBeCloseTo(fixture.expected.dark, 3);
            expect(metrics.meanLuminance).toBeGreaterThanOrEqual(fixture.expected.luminance.min);
            expect(metrics.meanLuminance).toBeLessThanOrEqual(fixture.expected.luminance.max);
        });
    }
});

const SQUARES = {
    // Drawn by the EVB editor layer, so the renderer must leave it out.
    editable: [
        60,
        600,
        260,
        700,
    ],
    // A foreign appearance the renderer keeps.
    foreign: [
        320,
        600,
        520,
        700,
    ],
} as const;

async function createTwoSquarePdf() {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([
        612,
        792,
    ]);
    const annotations = Object.values(SQUARES).map(([
        x1,
        y1,
        x2,
        y2,
    ]) => {
        const appearance = pdf.context.register(pdf.context.stream(
            `0 0 1 rg 0 0 ${x2 - x1} ${y2 - y1} re f`,
            {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [
                    0,
                    0,
                    x2 - x1,
                    y2 - y1,
                ],
            },
        ));
        return pdf.context.register(pdf.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Square'),
            F: PDFNumber.of(4),
            Rect: [
                x1,
                y1,
                x2,
                y2,
            ],
            AP: pdf.context.obj({N: appearance}),
        }));
    });
    page.node.set(PDFName.of('Annots'), pdf.context.obj(annotations));
    return pdf.save();
}

function isPdfjsCanvas(value: unknown): value is HTMLCanvasElement {
    return isRecord(value) && typeof value.getContext === 'function';
}

function isPdfjsCanvasRenderingContext(value: unknown): value is CanvasRenderingContext2D {
    return isRecord(value) && typeof value.getImageData === 'function';
}

// Mean blue-over-red excess inside a PDF rectangle: zero on white paper,
// about 255 where a blue square was painted.
function blueInk(
    context: CanvasRenderingContext2D,
    viewport: {convertToViewportPoint(x: number, y: number): number[]},
    [
        x1,
        y1,
        x2,
        y2]: readonly number[
    ],
) {
    const [
        left = 0,
        top = 0,
    ] = viewport.convertToViewportPoint(x1!, y2!);
    const [
        right = 0,
        bottom = 0,
    ] = viewport.convertToViewportPoint(x2!, y1!);
    const {data} = context.getImageData(left + 10, top + 10, right - left - 20, bottom - top - 20);
    let excess = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
        excess += data[offset + 2]! - data[offset]!;
    }
    return excess / (data.length / 4);
}

describe('PDF canvas annotation suppression', () => {
    it('leaves the listed annotation out of the canvas and keeps the others', async () => {
        Object.assign(globalThis, {
            DOMMatrix,
            ImageData,
            Path2D,
        });
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task = pdfjs.getDocument({
            data: await createTwoSquarePdf(),
            disableWorker: true,
            useWorkerFetch: false,
        } as Parameters<typeof pdfjs.getDocument>[0]);
        try {
            const document = await task.promise;
            const page = await document.getPage(1);
            const annotations = await page.getAnnotations();
            const editableId = annotations.find(annotation => annotation.rect[0] === SQUARES.editable[0])?.id;
            expect(editableId).toEqual(expect.any(String));
            const viewport = page.getViewport({scale: 1});

            async function render(hiddenAnnotationIds?: Set<string>) {
                const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                const context = canvas.getContext('2d');
                if (!isPdfjsCanvas(canvas) || !isPdfjsCanvasRenderingContext(context)) {
                    throw new Error('The canvas fixture does not provide PDF.js rendering APIs');
                }
                await page.render({
                    canvas,
                    canvasContext: context,
                    viewport,
                    annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
                    ...(hiddenAnnotationIds ? {hiddenAnnotationIds} : {}),
                }).promise;
                return {
                    editable: blueInk(context, viewport, SQUARES.editable),
                    foreign: blueInk(context, viewport, SQUARES.foreign),
                };
            }

            const everything = await render();
            const suppressed = await render(new Set([editableId!]));

            expect(everything.editable).toBeGreaterThan(200);
            expect(everything.foreign).toBeGreaterThan(200);
            expect(suppressed.editable).toBe(0);
            expect(suppressed.foreign).toBe(everything.foreign);
        } finally {
            await task.destroy();
        }
    });
});
