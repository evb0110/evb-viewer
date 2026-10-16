/* eslint-disable custom/file-naming -- The issue contract fixes this focused test filename. */
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeMutationSet,
} from '@contracts/nativePdfMutations';
import {splitPdfNativeMutationSetIntoBoundedChunks} from '@pdf-core/nativePdfMutationPolicy';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';
import type {IPdfNativeTextBoxMutation} from '@contracts/electronApiDocuments';
import coverage from '@contracts/annotationFontCoverage.json';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const textBox: IPdfNativeTextBoxMutation = {
    pageIndex: requirePageIndex(0),
    stableKey: 'text-box-1',
    text: 'A text box',
    rect: [
        10,
        20,
        100,
        60,
    ],
    rotation: 0,
    fontSize: 16,
    color: [
        17,
        24,
        39,
    ],
    author: 'Ada Lovelace',
    createdAt: requireEpochMs(1_780_000_000_000),
    modifiedAt: requireEpochMs(1_780_000_060_000),
};

describe('native PDF text-box mutation contracts', () => {
    it('binds generated coverage to the shipped font programs', () => {
        for (const font of coverage.fonts) {
            const bytes = readFileSync(new URL(`../../../public/fonts/annotation/${font.file}`, import.meta.url));
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(font.sha256);
        }
    });
    it('normalizes canonical and legacy keys to textBoxes without emitting the alias', () => {
        const canonical = normalizePdfNativeMutationSet({textBoxes: [textBox]}, 'mutations');
        expect(canonical.textBoxes).toEqual([textBox]);
        expect(canonical.freeTextEditors).toBeUndefined();
        expect(Object.keys(canonical)).toContain('textBoxes');
        expect(Object.keys(canonical)).not.toContain('freeTextEditors');

        const legacy = normalizePdfNativeMutationSet({freeTextEditors: [textBox]}, 'mutations');
        expect(legacy.textBoxes).toEqual([textBox]);
        expect(legacy.freeTextEditors).toBeUndefined();
    });

    it.each([
        'Привет мир',
        'Cafe\u0301 naïve Ελληνικά',
        'שָׁלוֹם',
        'العَرَبِيَّة',
        'ܫܠܵܡܵܐ',
        'בְּרֵאשִׁ֖ית',
        'بَسْمِ لَا بــِسْمِ',
        'Latin שלום العربية 123\nSecond line\tПривет',
    ])('preserves portable Unicode text unchanged: %s', (text) => {
        const normalized = normalizePdfNativeMutationSet({textBoxes: [{
            ...textBox,
            text,
        }]}, 'mutations');
        expect(normalized.textBoxes?.[0]?.text).toBe(text);
    });

    it.each([
        [
            '中文',
            'U+4E2D',
        ],
        [
            '\ud800',
            'U+D800',
        ],
        [
            'text\u0000',
            'U+0000',
        ],
    ])('rejects unavailable glyphs and malformed Unicode before save: %s', (text, codepoint) => {
        expect(() => normalizePdfNativeMutationSet({textBoxes: [{
            ...textBox,
            text,
        }]}, 'mutations'))
            .toThrow(codepoint);
    });

    it('applies the native UTF-8 byte limit to multibyte text', () => {
        const accepted = 'Я'.repeat(PDF_NATIVE_MUTATION_LIMITS.textBoxTextBytes / 2);
        expect(normalizePdfNativeMutationSet({textBoxes: [{
            ...textBox,
            text: accepted,
        }]}, 'mutations')
            .textBoxes?.[0]?.text).toBe(accepted);
        expect(() => normalizePdfNativeMutationSet({textBoxes: [{
            ...textBox,
            text: `${accepted}Я`,
        }]}, 'mutations'))
            .toThrow('64 KiB UTF-8');
    });

    it.each([
        'א'.repeat(256),
        'ع'.repeat(256),
        `${'界'.repeat(170)}ab`,
    ])(
        'budgets Unicode text-box identities at 512 UTF-8 bytes',
        (stableKey) => {
            expect(new TextEncoder().encode(stableKey)).toHaveLength(512);
            expect(normalizePdfNativeMutationSet({textBoxes: [{
                ...textBox,
                stableKey,
            }]}, 'mutations')
                .textBoxes?.[0]?.stableKey).toBe(stableKey);
            expect(() => normalizePdfNativeMutationSet({textBoxes: [{
                ...textBox,
                stableKey: `${stableKey}a`,
            }]}, 'mutations'))
                .toThrow('512 UTF-8 bytes');
        },
    );

    it('bounds annotation identities by UTF-8 bytes at the shared identity limit', () => {
        const annotationId = 'Я'.repeat(1_024);
        expect(normalizePdfNativeMutationSet({textBoxes: [{
            ...textBox,
            annotationId,
        }]}, 'mutations').textBoxes?.[0]?.annotationId).toBe(annotationId);
        expect(() => normalizePdfNativeMutationSet({textBoxes: [{
            ...textBox,
            annotationId: `${annotationId}x`,
        }]}, 'mutations')).toThrow('2048 UTF-8 bytes');
    });

    it('rejects a payload that supplies both text-box keys', () => {
        expect(() => normalizePdfNativeMutationSet({
            textBoxes: [textBox],
            freeTextEditors: [textBox],
        }, 'mutations')).toThrow('only one of textBoxes or freeTextEditors');
    });

    it('keeps author and creation/modification metadata optional and typed', () => {
        const normalized = normalizePdfNativeMutationSet({textBoxes: [{
            ...textBox,
            author: null,
            createdAt: null,
            modifiedAt: null,
        }]}, 'mutations');
        expect(normalized.textBoxes?.[0]).toMatchObject({
            author: null,
            createdAt: null,
            modifiedAt: null,
        });

        expect(() => normalizePdfNativeMutationSet({textBoxes: [{
            ...textBox,
            author: 42,
        }]}, 'mutations')).toThrow('author must be a string or null');
        expect(() => normalizePdfNativeMutationSet({textBoxes: [{
            ...textBox,
            modifiedAt: -1,
        }]}, 'mutations')).toThrow('modifiedAt must be a finite positive timestamp or null');
    });

    it('uses the canonical continuation family for bounded text-box chunks', () => {
        const normalized = normalizePdfNativeMutationSet({textBoxes: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.textBoxes + 1}, (_, index) => ({
            ...textBox,
            stableKey: `text-box-${index}`,
        }))}, 'mutations');
        const chunks = splitPdfNativeMutationSetIntoBoundedChunks(normalized);

        expect(chunks).toHaveLength(2);
        expect(chunks[0]?.textBoxes).toHaveLength(PDF_NATIVE_MUTATION_LIMITS.textBoxes);
        expect(chunks[1]?.textBoxes).toHaveLength(1);
        expect(chunks[1]?.continuation).toEqual({
            family: 'textBoxes',
            chunkIndex: 1,
            chunkCount: 2,
        });
        expect(chunks.every(chunk => chunk.freeTextEditors === undefined)).toBe(true);
    });

    it('rejects duplicate aliases before splitting and accepts legacy text boxes', () => {
        expect(() => splitPdfNativeMutationSetIntoBoundedChunks({
            textBoxes: [textBox],
            freeTextEditors: [{
                ...textBox,
                stableKey: 'legacy-text-box',
            }],
        })).toThrow('only one of textBoxes or freeTextEditors');

        const chunks = splitPdfNativeMutationSetIntoBoundedChunks({freeTextEditors: [textBox]});
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.textBoxes).toEqual([textBox]);
        expect(normalizePdfNativeMutationSet(chunks[0], 'mutations').textBoxes).toEqual([textBox]);
    });
});

it('keeps exact source primitives and separates appearance batch limits from Save admission', async () => {
    const {
        normalizePdfNativeTextBoxAppearanceRequest, PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS,
    } = await import('@contracts/nativePdfMutations');
    const source = {
        version: 1,
        settlementRect: [
            10,
            20,
            100,
            60,
        ],
        rawRD: [
            60,
            0,
            60,
            0,
        ],
        borderWidth: 1.5,
        borderColor: [
            0.1,
            0.2,
            0.3,
            0.4,
        ],
        background: [0.8],
        staleFill: false,
    };
    const request = {
        page: {
            view: [
                0,
                0,
                200,
                100,
            ],
            rotation: 0,
            userUnit: 2,
        },
        textBoxes: [{
            textBox,
            source,
        }],
    };
    expect(normalizePdfNativeTextBoxAppearanceRequest(request).textBoxes[0]?.source).toEqual(source);
    expect(() => normalizePdfNativeTextBoxAppearanceRequest({
        ...request,
        textBoxes: [{
            textBox,
            source: {
                ...source,
                rawRD: [
                    -1,
                    0,
                    0,
                    0,
                ],
            },
        }],
    })).toThrow(TypeError);
    const large = 'W'.repeat(PDF_NATIVE_MUTATION_LIMITS.textBoxTextBytes);
    const boxes = Array.from({length: PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS.totalTextBytes / large.length + 1}, (_, index) => ({
        ...textBox,
        stableKey: `large-${index}`,
        text: large,
    }));
    expect(normalizePdfNativeMutationSet({textBoxes: boxes}, 'mutations').textBoxes).toHaveLength(boxes.length);
    expect(() => normalizePdfNativeTextBoxAppearanceRequest({
        ...request,
        textBoxes: boxes.map(textBox => ({textBox})),
    })).toThrow('1 MiB');
});

it('retains explicit original paint provenance transport without changing text', () => {
    const source = '/managed/original.pdf';
    const mutations = normalizePdfNativeMutationSet({
        originalAppearanceSource: source,
        textBoxes: [{
            ...textBox,
            originalAppearance: {sourceAnnotationId: '17R0'},
        }],
    }, 'mutations');
    expect(mutations.originalAppearanceSource).toBe(source);
    expect(mutations.textBoxes?.[0]?.originalAppearance).toEqual({sourceAnnotationId: '17R0'});
    expect(() => normalizePdfNativeMutationSet({textBoxes: [{
        ...textBox,
        originalAppearance: {
            sourceAnnotationId: '17R0',
            recoveryData: '00',
        },
    }]}, 'mutations')).toThrow('one bounded recovery graph');
    expect(() => normalizePdfNativeMutationSet({textBoxes: [{
        ...textBox,
        originalAppearance: {sourceAnnotationId: 'not-a-ref'},
    }]}, 'mutations')).toThrow('retained source annotation');
});

it('carries the immutable source only on chunks that restore original source graphs', () => {
    const textBoxes = Array.from({length: PDF_NATIVE_MUTATION_LIMITS.textBoxes + 1}, (_, index) => ({
        ...textBox,
        stableKey: `source-box-${index}`,
        ...(index === PDF_NATIVE_MUTATION_LIMITS.textBoxes ? {originalAppearance: {sourceAnnotationId: '17R'}} : {}),
    }));
    const source = '/managed/original.pdf';
    const mutations = normalizePdfNativeMutationSet({
        originalAppearanceSource: source,
        textBoxes,
    }, 'mutations');
    const chunks = splitPdfNativeMutationSetIntoBoundedChunks(mutations);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.originalAppearanceSource).toBeUndefined();
    expect(chunks[1]?.originalAppearanceSource).toBe(source);
    expect(chunks[1]?.textBoxes?.[0]?.originalAppearance).toEqual({sourceAnnotationId: '17R'});
    expect(() => splitPdfNativeMutationSetIntoBoundedChunks({textBoxes: [mutations.textBoxes!.at(-1)!]})).toThrow('immutable document source');
});
