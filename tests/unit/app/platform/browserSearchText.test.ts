import type * as PdfCore from '@pdf-core';
import {
    findPdfSearchMatches, normalizeSearchText,
} from '@pdf-core';
import type {
    IPdfTextContent,
    IPdfTextItem,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    extractBrowserSearchPageData,
    extractBrowserSearchPageText,
} from '@app/platform/browser-api/extractBrowserSearchPageText';

const mocks = vi.hoisted(() => ({
    extractPdfjsWordBoxesFromOperatorList: vi.fn(),
    getPdfjsPageViewBox: vi.fn(),
}));

vi.mock('@pdf-core', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...(actual as object),
        extractPdfjsWordBoxesFromOperatorList: mocks.extractPdfjsWordBoxesFromOperatorList,
        getPdfjsPageViewBox: mocks.getPdfjsPageViewBox,
    };
});

describe('extractBrowserSearchPageText', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.extractPdfjsWordBoxesFromOperatorList.mockReturnValue([]);
        mocks.getPdfjsPageViewBox.mockReturnValue({
            pageHeight: 200,
            pageWidth: 100,
        });
    });

    it('keeps PDF.js text item offsets compatible with rendered text layers', async () => {
        const makeTextItem = (str: string, hasEOL: boolean): IPdfTextItem => ({
            str,
            hasEOL,
            dir: 'ltr',
            transform: [],
            width: 0,
            height: 0,
            fontName: 'f1',
        });
        const textContent: IPdfTextContent = {
            items: [
                makeTextItem('alpha', true),
                makeTextItem('beta  gamma', false),
            ],
            styles: {},
            lang: null,
        };
        const cleanup = vi.fn(() => true);
        const page = {
            getTextContent: vi.fn(async () => textContent),
            cleanup,
        };

        await expect(extractBrowserSearchPageText(page)).resolves.toBe('alpha\nbeta  gamma');
        expect(page.getTextContent).toHaveBeenCalledWith({
            includeMarkedContent: true,
            disableNormalization: true,
        });
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('uses canonical joining and hyphenation while preserving source Unicode offsets', async () => {
        const makeTextItem = (str: string, hasEOL = false): IPdfTextItem => ({
            str,
            hasEOL,
            dir: 'ltr',
            transform: [],
            width: 0,
            height: 0,
            fontName: 'f1',
        });
        const page = {getTextContent: vi.fn(async (): Promise<IPdfTextContent> => ({
            items: [
                makeTextItem('Cafe\u0301'),
                makeTextItem('ex-', true),
                makeTextItem('\uFB01le'),
            ],
            styles: {},
            lang: null,
        }))};

        await expect(extractBrowserSearchPageText(page)).resolves.toBe('Cafe\u0301 ex\uFB01le');
    });

    it('collapses exact repeated hidden text streams before browser search indexes the page', async () => {
        const repeatedText = 'СЛОВАРЬ\nАРАБСКОЙ ХРЕСТОМАТИИ И КОРАНУ. СОСТАВИЛЪ ПРОФ. В. ГИРГАСЪ.\n';
        const makeTextItem = (str: string): IPdfTextItem => ({
            str,
            hasEOL: false,
            dir: 'ltr',
            transform: [],
            width: 0,
            height: 0,
            fontName: 'f1',
        });
        const textContent: IPdfTextContent = {
            items: [
                makeTextItem(repeatedText),
                makeTextItem(repeatedText),
                makeTextItem(repeatedText),
            ],
            styles: {},
            lang: null,
        };
        const page = { getTextContent: vi.fn(async () => textContent) };

        await expect(extractBrowserSearchPageText(page)).resolves.toBe(repeatedText);
    });

    it.each([
        [
            'שלום',
            'םולש',
        ],
        [
            'السلام',
            'مالسلا',
        ],
        [
            'ܫܠܡܐ',
            'ܐܡܠܫ',
        ],
        [
            'שָׁל֑וֹם',
            'םֹו֑לָׁש',
        ],
        [
            'السَّلَام',
            'ماَلَّسلا',
        ],
        [
            'ܫܠܵܡܵܐ',
            'ܐܵܡܵܠܫ',
        ],
        [
            'abc עולם 123',
            'abc םלוע 123',
        ],
        [
            'עולם123עולם',
            'םלוע123םלוע',
        ],
    ])('indexes logical %s with rendered-text offsets', async (logical, painted) => {
        const page = {
            view: [
                0,
                0,
                612,
                792,
            ],
            getOperatorList: async () => ({
                fnArray: [
                    1,
                    2,
                    3,
                    4,
                    5,
                ],
                argsArray: [
                    [],
                    [
                        'f1',
                        24,
                    ],
                    [
                        1,
                        0,
                        0,
                        1,
                        72,
                        700,
                    ],
                    [[...painted].map(unicode => ({
                        unicode,
                        width: 600,
                    }))],
                    [],
                ],
            }),
            getTextContent: async (): Promise<IPdfTextContent> => ({
                items: [{
                    str: logical,
                    dir: 'rtl',
                    transform: [
                        24,
                        0,
                        0,
                        24,
                        72,
                        700,
                    ],
                    width: 200,
                    height: 24,
                    fontName: 'f1',
                    hasEOL: false,
                }],
                styles: {},
                lang: null,
            }),
        };
        const data = await extractBrowserSearchPageData(page, {
            beginText: 1,
            setFont: 2,
            setTextMatrix: 3,
            showText: 4,
            endText: 5,
        });
        expect(data.text).toBe(logical);
        // Reuse the logical text layer's ranges rather than visual-order boxes.
        expect(data.words).toBeUndefined();
    });

    it('keeps accents, vowel points and cantillation in search normalization', () => {
        for (const [
            pointed,
            unpointed,
        ] of [
                [
                    'Cafe\u0301',
                    'Cafe',
                ],
                [
                    'שָׁל֑וֹם',
                    'שלום',
                ],
                [
                    'السَّلَام',
                    'السلام',
                ],
                [
                    'ܫܠܵܡܵܐ',
                    'ܫܠܡܐ',
                ],
            ]) {
            expect(normalizeSearchText(pointed!)).toBe(pointed!.normalize('NFC'));
            expect(findPdfSearchMatches(pointed!, unpointed!)).toEqual([]);
            expect(findPdfSearchMatches(pointed!, pointed!)).toHaveLength(1);
        }
        expect(normalizeSearchText('oﬃce')).toBe('office');
    });

    it('does not start text-content fallback when cancellation arrives after operator-list extraction', async () => {
        const page = {
            cleanup: vi.fn(),
            getOperatorList: vi.fn(async () => ({
                argsArray: [],
                fnArray: [],
            })),
            getTextContent: vi.fn(async () => ({
                items: [],
                styles: {},
                lang: null,
            })),
        };
        const shouldContinue = vi.fn(() => false);

        await expect(extractBrowserSearchPageData(page, {}, {shouldContinue}))
            .rejects
            .toThrow('ERR_BROWSER_SEARCH_CANCELED');

        expect(page.getOperatorList).toHaveBeenCalledOnce();
        expect(page.getTextContent).not.toHaveBeenCalled();
        expect(page.cleanup).toHaveBeenCalledOnce();
    });

    it('rejects direct text extraction when cancellation arrives after getTextContent resolves', async () => {
        const page = {
            cleanup: vi.fn(),
            getTextContent: vi.fn(async () => ({
                items: [],
                styles: {},
                lang: null,
            })),
        };
        const shouldContinue = vi.fn(() => false);

        await expect(extractBrowserSearchPageText(page, {shouldContinue}))
            .rejects
            .toThrow('ERR_BROWSER_SEARCH_CANCELED');

        expect(page.getTextContent).toHaveBeenCalledOnce();
        expect(page.cleanup).toHaveBeenCalledOnce();
    });
});

// Real PDF.js operator lists for one-line PDFs, read by the real geometry helper.
describe('word boxes from real PDF operators', () => {
    function onePagePdf(stream: string, form?: string, cropBox = '[0 0 300 200]') {
        const objects = [
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /CropBox ${cropBox} /Resources << /Font << /F1 4 0 R >> /XObject << /Fm1 6 0 R >> >> /Contents 5 0 R >>`,
            '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
            `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
            // A Form drawing its text twice as large, 50 points to the right.
            `<< /Type /XObject /Subtype /Form /BBox [0 0 150 100] /Matrix [2 0 0 2 50 0] /Resources << /Font << /F1 4 0 R >> >> /Length ${String((form ?? '').length)} >>\nstream\n${form ?? ''}\nendstream`,
        ];
        let text = '%PDF-1.4\n';
        const offsets: number[] = [];
        objects.forEach((object, index) => {
            offsets.push(text.length);
            text += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
        });
        const xref = text.length;
        text += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
        for (const offset of offsets) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
        text += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
        return new TextEncoder().encode(text);
    }

    async function wordBoxes(stream: string, form?: string) {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const geometry = await vi.importActual<typeof PdfCore>('@pdf-core');
        const task = pdfjs.getDocument({
            data: onePagePdf(stream, form),
            useSystemFonts: true,
        });
        try {
            const page = await (await task.promise).getPage(1);
            const operators = await page.getOperatorList();
            return geometry.extractPdfjsWordBoxesFromOperatorList(operators, geometry.getPdfjsPageViewBox(page), pdfjs.OPS);
        } finally {
            await task.destroy();
        }
    }

    it('keeps a word together when TJ moves back over a letter, as for an overstruck accent', async () => {
        const words = await wordBoxes('BT /F1 10 Tf 1 0 0 1 10 170 Tm [(cafe) 556 (\\047s) -600 (menu)] TJ ET');

        expect(words.map(word => word.text)).toEqual([
            'cafe’s',
            'menu',
        ]);
    });

    it('splits words a wide TJ gap separates and keeps kerned letters together', async () => {
        const words = await wordBoxes('BT /F1 10 Tf 1 0 0 1 10 170 Tm [(he) -40 (llo) -600 (world)] TJ ET');

        expect(words.map(word => word.text)).toEqual([
            'hello',
            'world',
        ]);
    });

    it('restores the font size a graphics-state restore brings back', async () => {
        const words = await wordBoxes('BT /F1 10 Tf 1 0 0 1 10 170 Tm (A) Tj ET\nq\nBT /F1 20 Tf 1 0 0 1 10 130 Tm (B) Tj ET\nQ\nBT 1 0 0 1 10 90 Tm (C) Tj ET');
        const a = words.find(word => word.text === 'A')!;
        const c = words.find(word => word.text === 'C')!;

        expect(c.height).toBeCloseTo(a.height, 5);
    });

    it('places text a Form draws under the Form\'s matrix', async () => {
        const words = await wordBoxes(
            'q /Fm1 Do Q BT /F1 10 Tf 1 0 0 1 10 170 Tm (outside) Tj ET',
            'BT /F1 10 Tf 1 0 0 1 10 20 Tm (inside) Tj ET',
        );
        const inside = words.find(word => word.text === 'inside')!;
        const outside = words.find(word => word.text === 'outside')!;

        expect(inside.height).toBeCloseTo(outside.height * 2, 5);
        expect(inside.x).toBeGreaterThan(outside.x);
    });

    it('leaves out the words a CropBox hides', async () => {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task = pdfjs.getDocument({
            data: onePagePdf('BT /F1 10 Tf 1 0 0 1 10 170 Tm (visible) Tj 1 0 0 1 200 170 Tm (hidden) Tj ET', '', '[0 0 150 200]'),
            useSystemFonts: true,
        });
        try {
            const page = await (await task.promise).getPage(1);
            const pageData = await extractBrowserSearchPageData(page, pdfjs.OPS);

            expect(pageData.text).toContain('visible');
            expect(pageData.text).not.toContain('hidden');
        } finally {
            await task.destroy();
        }
    });
});



describe('fallback search CropBox intersections', () => {
    const style = {
        fontFamily: 'sans-serif',
        vertical: false,
        ascent: 0.8,
        descent: -0.2,
    };
    const item = (str: string, transform: number[], width = 50, height = 10, hasEOL = false): IPdfTextItem => ({
        str,
        transform,
        width,
        height,
        hasEOL,
        dir: 'ltr',
        fontName: 'f1',
    });
    function extract(items: IPdfTextItem[], fontStyle = style) {
        return extractBrowserSearchPageData({
            view: [
                0,
                0,
                100,
                100,
            ],
            getTextContent: async () => ({
                items,
                styles: {f1: fontStyle},
                lang: null,
            }),
        }, {});
    }
    it.each([
        {
            name: 'horizontal',
            transform: [
                10,
                0,
                0,
                10,
                -5,
                50,
            ],
            vertical: false,
            width: 50,
            height: 10,
        },
        {
            name: 'rotated',
            transform: [
                0,
                10,
                -10,
                0,
                50,
                -5,
            ],
            vertical: false,
            width: 50,
            height: 10,
        },
        {
            name: 'reflected',
            transform: [
                -10,
                0,
                0,
                10,
                105,
                50,
            ],
            vertical: false,
            width: 50,
            height: 10,
        },
        {
            name: 'vertical',
            transform: [
                10,
                0,
                0,
                10,
                50,
                105,
            ],
            vertical: true,
            width: 10,
            height: 50,
        },
        {
            name: 'rotated vertical',
            transform: [
                0,
                10,
                -10,
                0,
                -5,
                50,
            ],
            vertical: true,
            width: 10,
            height: 50,
        },
        {
            name: 'above-baseline ink',
            transform: [
                10,
                0,
                0,
                10,
                50,
                -5,
            ],
            vertical: false,
            width: 20,
            height: 10,
        },
        {
            name: 'below-baseline ink',
            transform: [
                10,
                0,
                0,
                10,
                50,
                101,
            ],
            vertical: false,
            width: 20,
            height: 10,
        },
    ])('keeps visible $name text whose baseline origin is outside', async ({
        transform, vertical, width, height,
    }) => {
        await expect(extract([item('VISIBLE', transform, width, height)], {
            ...style,
            vertical,
        }))
            .resolves.toEqual({text: 'VISIBLE'});
    });
    it('omits disjoint text and keeps its line break for the visible prefix', async () => {
        await expect(extract([
            item('alpha', [
                10,
                0,
                0,
                10,
                10,
                70,
            ], 20),
            item('hidden', [
                10,
                0,
                0,
                10,
                150,
                70,
            ], 20, 10, true),
            item('beta', [
                10,
                0,
                0,
                10,
                10,
                50,
            ], 20),
        ])).resolves.toEqual({
            text: 'alpha\nbeta',
            croppedText: true,
        });
    });
    it.each([
        [],
        [
            0,
            0,
            0,
            10,
            150,
            50,
        ],
        [
            10,
            0,
            0,
            0,
            150,
            50,
        ],
        [
            10,
            0,
            0,
            10,
            Number.NaN,
            50,
        ],
    ])('keeps text with unusable geometry (%j)', async (...transform) => {
        await expect(extract([item('UNKNOWN', transform)])).resolves.toEqual({text: 'UNKNOWN'});
    });
    it('keeps a single glyph whose rendered width need not match its advance', async () => {
        await expect(extract([item('W', [
            10,
            0,
            0,
            10,
            -2,
            50,
        ], 0.1)]))
            .resolves.toEqual({text: 'W'});
    });
    it('keeps text whose font geometry is unavailable', async () => {
        await expect(extractBrowserSearchPageData({
            view: [
                0,
                0,
                100,
                100,
            ],
            getTextContent: async () => ({
                items: [item('UNKNOWN', [
                    10,
                    0,
                    0,
                    10,
                    150,
                    50,
                ])],
                styles: {},
                lang: null,
            }),
        }, {})).resolves.toEqual({text: 'UNKNOWN'});
    });
});
