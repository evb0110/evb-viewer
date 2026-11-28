import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
    clearPdfValidationRevisionCacheForTests,
    validatePdfRevision,
    type IPdfValidationSourceRevision,
} from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';

function createRevision(overrides: Partial<IPdfValidationSourceRevision> = {}): IPdfValidationSourceRevision {
    return {
        documentInstance: 'electron-working-copy:/tmp/wc-1.pdf:drt1:doc-1:r1',
        backingIdentity: '/documents/dictionary.pdf:170496793:1724000000000',
        byteRevision: '1:drt1:doc-1:r1',
        ...overrides,
    };
}

const validResult = {
    isValid: true,
    tool: 'qpdf' as const,
    errors: [],
    warnings: [],
};

describe('PDF validation revision cache', () => {
    beforeEach(() => clearPdfValidationRevisionCacheForTests());

    it('hits unchanged instance/backing/byteRevision identity and misses on same-path replacement or byte change', async () => {
        const validate = vi.fn(async () => validResult);
        const revision = createRevision();

        await expect(validatePdfRevision(revision, validate)).resolves.toMatchObject({cacheResult: 'miss'});
        await expect(validatePdfRevision(revision, validate)).resolves.toMatchObject({cacheResult: 'hit'});
        // Same path, same size, same mtime (identical backingIdentity), but different admitted document instance.
        await expect(
            validatePdfRevision(createRevision({documentInstance: 'electron-working-copy:/tmp/wc-2.pdf:drt1:doc-2:r1'}), validate),
        ).resolves.toMatchObject({cacheResult: 'miss'});
        // Same document instance & backing, but newer byteRevision.
        await expect(validatePdfRevision(createRevision({byteRevision: '2:drt1:doc-1:r2'}), validate)).resolves.toMatchObject({
            cacheResult: 'miss',
        });
        // Different backing mtime/size.
        await expect(
            validatePdfRevision(createRevision({backingIdentity: '/documents/dictionary.pdf:170496793:1724000000001'}), validate),
        ).resolves.toMatchObject({cacheResult: 'miss'});
        // Distinct nonblank strings that differ only by whitespace must NOT collide.
        await expect(validatePdfRevision(createRevision({byteRevision: `${revision.byteRevision} `}), validate)).resolves.toMatchObject({
            cacheResult: 'miss',
        });

        expect(validate).toHaveBeenCalledTimes(5);
    });

    it('coalesces concurrent validation only when documentInstance, backingIdentity, byteRevision, and purpose all match', async () => {
        const gate1 = Promise.withResolvers<typeof validResult>();
        const gate2 = Promise.withResolvers<typeof validResult>();
        const gate3 = Promise.withResolvers<typeof validResult>();
        const validate1 = vi.fn(() => gate1.promise);
        const validate2 = vi.fn(() => gate2.promise);
        const validate3 = vi.fn(() => gate3.promise);
        const revision = createRevision();

        const first = validatePdfRevision(revision, validate1, 'opening');
        const coalesced = validatePdfRevision(revision, validate1, 'opening');
        // Concurrent same-path replacement with a different admitted instance must NOT coalesce.
        const differentInstance = validatePdfRevision(
            createRevision({documentInstance: 'electron-working-copy:/tmp/wc-2.pdf:drt1:doc-2:r1'}),
            validate2,
            'opening',
        );
        // Concurrent different purpose for the exact same revision must NOT coalesce.
        const differentPurpose = validatePdfRevision(revision, validate3, 'save');

        gate1.resolve(validResult);
        gate2.resolve(validResult);
        gate3.resolve(validResult);

        await expect(first).resolves.toMatchObject({cacheResult: 'miss'});
        await expect(coalesced).resolves.toMatchObject({cacheResult: 'coalesced'});
        await expect(differentInstance).resolves.toMatchObject({cacheResult: 'miss'});
        await expect(differentPurpose).resolves.toMatchObject({cacheResult: 'miss'});
        expect(validate1).toHaveBeenCalledOnce();
        expect(validate2).toHaveBeenCalledOnce();
        expect(validate3).toHaveBeenCalledOnce();
    });

    it('does not reuse opening validation as save or full validation', async () => {
        const validateOpening = vi.fn(async () => validResult);
        const validateSave = vi.fn(async () => validResult);
        const validateFull = vi.fn(async () => validResult);
        const revision = createRevision();

        await expect(validatePdfRevision(revision, validateOpening, 'opening')).resolves.toMatchObject({cacheResult: 'miss'});
        await expect(validatePdfRevision(revision, validateOpening, 'opening')).resolves.toMatchObject({cacheResult: 'hit'});
        await expect(validatePdfRevision(revision, validateSave, 'save')).resolves.toMatchObject({cacheResult: 'miss'});
        await expect(validatePdfRevision(revision, validateFull, 'full')).resolves.toMatchObject({cacheResult: 'miss'});

        expect(validateOpening).toHaveBeenCalledOnce();
        expect(validateSave).toHaveBeenCalledOnce();
        expect(validateFull).toHaveBeenCalledOnce();
    });

    it('bypasses both successful and in-flight caches when any key component is unavailable', async () => {
        const incompleteRevisions: Array<IPdfValidationSourceRevision | null> = [
            null,
            createRevision({documentInstance: '   '}),
            createRevision({backingIdentity: ''}),
            createRevision({byteRevision: ''}),
            createRevision({byteRevision: -1}),
            createRevision({byteRevision: Number.NaN}),
            createRevision({documentInstance: 'bad\u0000key'}),
        ];

        for (const incomplete of incompleteRevisions) {
            const gateA = Promise.withResolvers<typeof validResult>();
            const gateB = Promise.withResolvers<typeof validResult>();
            const validateA = vi.fn(() => gateA.promise);
            const validateB = vi.fn(() => gateB.promise);

            const first = validatePdfRevision(incomplete, validateA, 'opening');
            const second = validatePdfRevision(incomplete, validateB, 'opening');
            gateA.resolve(validResult);
            gateB.resolve(validResult);

            await expect(first).resolves.toMatchObject({cacheResult: 'miss'});
            await expect(second).resolves.toMatchObject({cacheResult: 'miss'});
            expect(validateA).toHaveBeenCalledOnce();
            expect(validateB).toHaveBeenCalledOnce();

            // Subsequent call also misses (nothing cached).
            const validateC = vi.fn(async () => validResult);
            await expect(validatePdfRevision(incomplete, validateC, 'opening')).resolves.toMatchObject({cacheResult: 'miss'});
            expect(validateC).toHaveBeenCalledOnce();
        }
    });

    it('does not cache a failed validation', async () => {
        const invalidResult = {
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['damaged xref table'],
            warnings: [],
        };
        const validate = vi.fn(async () => invalidResult);
        const revision = createRevision({
            documentInstance: 'electron-working-copy:/tmp/corrupt.pdf:drt1:corrupt:r1',
            backingIdentity: '/documents/corrupt.pdf:1024:1724000000000',
            byteRevision: '1:drt1:corrupt:r1',
        });

        await expect(validatePdfRevision(revision, validate)).resolves.toMatchObject({cacheResult: 'miss'});
        await expect(validatePdfRevision(revision, validate)).resolves.toMatchObject({cacheResult: 'miss'});
        expect(validate).toHaveBeenCalledTimes(2);
    });
});
