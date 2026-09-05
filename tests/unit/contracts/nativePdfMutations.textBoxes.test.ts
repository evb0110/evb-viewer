/* eslint-disable custom/file-naming -- The issue contract fixes this focused test filename. */
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeMutationSet,
    splitPdfNativeMutationSetIntoBoundedChunks,
} from '@contracts/nativePdfMutations';
import {requirePageIndex} from '@contracts/pageNumbers';
import type {IPdfNativeTextBoxMutation} from '@contracts/electronApiDocuments';

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
    createdAt: 1_780_000_000_000,
    modifiedAt: 1_780_000_060_000,
};

describe('native PDF text-box mutation contracts', () => {
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

    it('rejects duplicate aliases before splitting and preserves the legacy family when used alone', () => {
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
        expect(chunks[0]?.freeTextEditors).toBeUndefined();
    });
});
