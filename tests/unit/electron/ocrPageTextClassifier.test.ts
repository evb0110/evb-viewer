import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodePdfOcrTextVisibilityReport,
    type IPdfOcrPageTextVisibility,
} from '@contracts/pdfOcrTextVisibility';
import {
    classifyOcrPageText,
    shouldOcrClassifiedPage,
} from '@electron/features/ocr/pipeline/pageTextClassifier';

function visibility(overrides: Partial<IPdfOcrPageTextVisibility> = {}): IPdfOcrPageTextVisibility {
    return {
        pageNumber: 1,
        evbOcrLayer: false,
        paintedText: false,
        hiddenText: false,
        uncertain: null,
        unsupported: null,
        ...overrides,
    };
}

const visible = visibility({paintedText: true});
const hidden = visibility({hiddenText: true});
const evbLayer = visibility({evbOcrLayer: true});

describe('OCR page text classification and supersession', () => {
    it('decodes the native text-visibility report both languages read', async () => {
        const fixture: unknown = JSON.parse(await readFile(
            resolve(process.cwd(), 'native/protocol-fixtures/pdf-page-ops-ocr-text-visibility.json'),
            'utf8',
        ));
        expect(decodePdfOcrTextVisibilityReport(fixture).pages.map(page => page.pageNumber)).toEqual([
            1,
            3,
        ]);
        expect(() => decodePdfOcrTextVisibilityReport({
            ...(fixture as object),
            schemaVersion: 2,
        })).toThrow();
        expect(() => decodePdfOcrTextVisibilityReport({
            ...(fixture as object),
            pages: [{
                ...visibility(),
                extra: true,
            }],
        })).toThrow();
    });

    it('distinguishes native, foreign hidden OCR, current EVB generation, and missing text', () => {
        expect(classifyOcrPageText({
            extractedText: '',
            visibility: visible,
        })).toBe('no-text');
        expect(classifyOcrPageText({
            extractedText: 'Native',
            visibility: visible,
        })).toBe('native-text');
        expect(classifyOcrPageText({
            extractedText: 'Foreign OCR',
            visibility: hidden,
        })).toBe('foreign-hidden-ocr');
        expect(classifyOcrPageText({
            extractedText: 'EVB OCR',
            visibility: evbLayer,
        })).toBe('evb-current-generation');
    });

    it('keeps native text under every policy and repairs hidden OCR with no visible text', () => {
        const classifications = [
            'native-text',
            'foreign-hidden-ocr',
            'evb-current-generation',
            'no-text',
        ] as const;

        expect(classifications.filter(value => shouldOcrClassifiedPage(value, 'missing-only')))
            .toEqual([
                'foreign-hidden-ocr',
                'no-text',
            ]);
        expect(classifications.filter(value => shouldOcrClassifiedPage(value, 'replace-evb')))
            .toEqual([
                'foreign-hidden-ocr',
                'evb-current-generation',
                'no-text',
            ]);
        expect(classifications.filter(value => shouldOcrClassifiedPage(value, 'replace-all')))
            .toEqual([
                'foreign-hidden-ocr',
                'evb-current-generation',
                'no-text',
            ]);
    });

    it('treats hidden text as a replaceable layer only when nothing else on the page is text', () => {
        expect(classifyOcrPageText({
            extractedText: 'Visible Hidden metadata',
            visibility: visibility({
                paintedText: true,
                hiddenText: true,
            }),
        })).toBe('native-text');
        expect(classifyOcrPageText({
            extractedText: 'Form layer',
            visibility: visibility({
                hiddenText: true,
                uncertain: 'hidden text inside a Form XObject is not removed by OCR replacement',
            }),
        })).toBe('native-text');
        // Text the inspection could not attribute stays the document's own.
        expect(classifyOcrPageText({extractedText: 'Unknown origin'})).toBe('native-text');
    });

    it('does not treat unusable current-generation OCR as complete', () => {
        const garbage = classifyOcrPageText({
            extractedText: 'и,\nАаоЗта НЫ)\nРГ. М\nА\nЧ\nК\nи\nУАТАИ,',
            visibility: evbLayer,
            languages: ['rus'],
        });
        const latinGarbage = classifyOcrPageText({
            extractedText: 'sAtFL4w',
            visibility: evbLayer,
            languages: ['rus'],
        });

        expect(garbage).toBe('foreign-hidden-ocr');
        expect(latinGarbage).toBe('foreign-hidden-ocr');
        expect(shouldOcrClassifiedPage(garbage, 'missing-only')).toBe(true);
        expect(shouldOcrClassifiedPage(latinGarbage, 'missing-only')).toBe(true);
    });

    it('keeps known non-Latin scripts and does not guess Latin for unknown models', () => {
        for (const languages of [
            ['chi_sim'],
            ['unknown-model'],
        ]) {
            expect(classifyOcrPageText({
                extractedText: '这是中文文本 内容测试',
                visibility: evbLayer,
                languages,
            })).toBe('evb-current-generation');
        }
    });

    it('recognizes extended Latin characters through Script_Extensions', () => {
        expect(classifyOcrPageText({
            extractedText: 'Žluťoučký kůň',
            visibility: evbLayer,
            languages: ['ces'],
        })).toBe('evb-current-generation');
    });

    it('accepts a valid isolated word without weakening the garbage guard', () => {
        expect(classifyOcrPageText({
            extractedText: 'ГРАММАТИЧЕСКИЙ',
            visibility: evbLayer,
            languages: ['rus'],
        })).toBe('evb-current-generation');
        expect(classifyOcrPageText({
            extractedText: 'sAtFL4w',
            visibility: evbLayer,
            languages: ['unknown-model'],
        })).toBe('foreign-hidden-ocr');
    });

    it('accepts numeric-only pages and short headings with a page number', () => {
        expect(classifyOcrPageText({
            extractedText: '2026',
            visibility: evbLayer,
            languages: ['rus'],
        })).toBe('evb-current-generation');
        expect(classifyOcrPageText({
            extractedText: '1',
            visibility: evbLayer,
            languages: ['rus'],
        })).toBe('evb-current-generation');
        expect(classifyOcrPageText({
            extractedText: 'Глава 1',
            visibility: evbLayer,
            languages: ['rus'],
        })).toBe('evb-current-generation');
    });
});
