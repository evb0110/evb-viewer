import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildPdfSaveRestrictions,
    createConservativePdfConformanceFallbackProfile,
    createDefaultPdfConformanceProfile,
    detectPdfaLevelFromPdfText,
    hasPdfEncryptMarkersInPdfText,
    hasPdfSignatureMarkersInPdfText,
} from '@pdf-core';
import { createPdfConformanceProfile } from '@pdf-core/pdfConformanceHelpers';

describe('PDF conformance contract helpers', () => {
    it('creates the default conformance profile', () => {
        expect(createDefaultPdfConformanceProfile()).toEqual({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
    });

    it('builds save restriction policy', () => {
        const restrictedProfile = {
            isSigned: true,
            isEncrypted: true,
            isTagged: true,
            pdfaLevel: 'PDF/A-2B',
            hasAcroForm: true,
            hasXfa: true,
            canIncrementalSave: false,
        };

        expect(buildPdfSaveRestrictions(restrictedProfile)).toEqual([
            'signed_original_requires_save_as',
            'encrypted_document_requires_preservation',
            'xfa_forms_are_not_supported_for_rewrite',
            'tagged_pdf_requires_structure_preservation',
            'pdfa_preservation_required:PDF/A-2B',
            'incremental_save_not_supported',
        ]);
    });

    it('creates conservative fallback profiles for failed analysis', () => {
        expect(createConservativePdfConformanceFallbackProfile({
            isSigned: true,
            isEncrypted: true,
            pdfaLevel: 'PDF/A-2B',
        })).toEqual({
            isSigned: true,
            isEncrypted: true,
            isTagged: false,
            pdfaLevel: 'PDF/A-2B',
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: false,
            saveRestrictions: [
                'signed_original_requires_save_as',
                'encrypted_document_requires_preservation',
                'pdfa_preservation_required:PDF/A-2B',
                'incremental_save_not_supported',
            ],
        });
    });

    it('lets markers widen structural signature and encryption facts and carry PDF/A', () => {
        const structuralFacts = {
            isSigned: false,
            isEncrypted: false,
            isTagged: true,
            hasAcroForm: true,
            hasXfa: false,
        };

        expect(createPdfConformanceProfile(structuralFacts)).toEqual({
            ...structuralFacts,
            pdfaLevel: null,
            canIncrementalSave: true,
            saveRestrictions: ['tagged_pdf_requires_structure_preservation'],
        });
        expect(createPdfConformanceProfile(structuralFacts, {
            isSigned: true,
            isEncrypted: true,
            pdfaLevel: 'PDF/A-2B',
        })).toEqual({
            ...structuralFacts,
            isSigned: true,
            isEncrypted: true,
            pdfaLevel: 'PDF/A-2B',
            canIncrementalSave: false,
            saveRestrictions: [
                'signed_original_requires_save_as',
                'encrypted_document_requires_preservation',
                'tagged_pdf_requires_structure_preservation',
                'pdfa_preservation_required:PDF/A-2B',
                'incremental_save_not_supported',
            ],
        });
    });

    it('detects PDF/A and signature markers', () => {
        const pdfaText = `
            <pdfaid:part>2</pdfaid:part>
            <pdfaid:conformance>b</pdfaid:conformance>
            /ByteRange [0 10 20 30]
            /Encrypt 42 0 R
        `;

        expect(detectPdfaLevelFromPdfText(pdfaText)).toBe('PDF/A-2B');
        expect(hasPdfSignatureMarkersInPdfText(pdfaText)).toBe(true);
        expect(hasPdfEncryptMarkersInPdfText(pdfaText)).toBe(true);
    });
});
