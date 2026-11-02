import {
    resolveQpdfValidationTimeoutMs, shouldKeepPdfOptimizationCandidate,
} from '@pdf-core/qpdfCommands';
import {
    getPdfLosslessOptimizationSkipReason, scanPdfMarkerEvidence, PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES, createPdfConformanceProfile,
} from '@pdf-core/pdfConformanceHelpers';
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

describe('PDF conformance contract helpers', () => {
    it('scales the shared full-check timeout and clamps unknown or huge sizes', () => {
        expect([
            undefined,
            NaN,
            Infinity,
            -1,
            64 * 1024 ** 2,
            256 * 1024 ** 2,
            1024 ** 3,
            2n ** 64n,
        ].map(resolveQpdfValidationTimeoutMs))
            .toEqual([
                30000,
                30000,
                30000,
                30000,
                30000,
                42000,
                90000,
                600000,
            ]);
    });

    it('keeps only a nonempty, valid and strictly smaller optimization candidate', () => {
        const valid = {
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        };
        const invalid = {
            ...valid,
            isValid: false,
            errors: ['damaged'],
        };
        expect([
            shouldKeepPdfOptimizationCandidate(100, 99, valid),
            shouldKeepPdfOptimizationCandidate(100, 100, valid),
            shouldKeepPdfOptimizationCandidate(100, 101, valid),
            shouldKeepPdfOptimizationCandidate(100, 0, valid),
            shouldKeepPdfOptimizationCandidate(100, 99, invalid),
        ]).toEqual([
            true,
            false,
            false,
            false,
            false,
        ]);
    });

    it('keeps ordered exclusions and permits tagged PDFs and ordinary forms', () => {
        const profile = {
            ...createDefaultPdfConformanceProfile(),
            isTagged: true,
            hasAcroForm: true,
        };
        expect(getPdfLosslessOptimizationSkipReason(profile)).toBeNull();
        profile.hasXfa = true;
        expect(getPdfLosslessOptimizationSkipReason(profile)).toBe('XFA PDF');
        profile.pdfaLevel = 'PDF/A-2B';
        expect(getPdfLosslessOptimizationSkipReason(profile)).toBe('PDF/A-2B PDF');
        profile.isEncrypted = true;
        expect(getPdfLosslessOptimizationSkipReason(profile)).toBe('encrypted PDF');
        profile.isSigned = true;
        expect(getPdfLosslessOptimizationSkipReason(profile)).toBe('signed PDF');
    });

    it('finds markers across bounded scan windows', () => {
        const bytes = new Uint8Array(PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES + 100);
        bytes.set(new TextEncoder().encode('/ByteRange [0 1]'), PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES - 4);
        expect(scanPdfMarkerEvidence(bytes).isSigned).toBe(true);
    });

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
