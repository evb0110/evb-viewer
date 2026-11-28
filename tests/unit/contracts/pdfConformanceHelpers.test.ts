import {resolveQpdfValidationTimeoutMs, shouldKeepPdfOptimizationCandidate} from '@pdf-core/qpdfCommands';
import {
    getPdfLosslessOptimizationSkipReason,
    scanPdfMarkerEvidence,
    PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES,
    createPdfConformanceProfile,
} from '@pdf-core/pdfConformanceHelpers';
import {describe, expect, it} from 'vitest';
import {
    buildPdfSaveRestrictions,
    createDefaultPdfConformanceProfile,
    detectPdfaLevelFromPdfText,
    hasPdfEncryptMarkersInPdfText,
} from '@pdf-core';

describe('PDF conformance contract helpers', () => {
    it('scales the shared full-check timeout and clamps unknown or huge sizes', () => {
        expect(
            [undefined, NaN, Infinity, -1, 64 * 1024 ** 2, 256 * 1024 ** 2, 1024 ** 3, 2n ** 64n].map(resolveQpdfValidationTimeoutMs),
        ).toEqual([30000, 30000, 30000, 30000, 30000, 42000, 90000, 600000]);
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
        ]).toEqual([true, false, false, false, false]);
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
        bytes.set(new TextEncoder().encode('/Encrypt 4 0 R'), PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES - 4);
        expect(scanPdfMarkerEvidence(bytes).isEncrypted).toBe(true);
    });

    it('handles /Encrypted boundary splits, split PDF/A tags, and PDF/A-4 without conformance', () => {
        const enc = new TextEncoder();
        // `/Encrypted` split right after `/Encrypt` at the chunk edge must not false-positive.
        const encryptedWord = new Uint8Array(PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES + 64);
        encryptedWord.fill(0x20);
        encryptedWord.set(enc.encode('/Encrypted'), PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES - '/Encrypt'.length);
        expect(scanPdfMarkerEvidence(encryptedWord)).toEqual({
            isEncrypted: false,
            pdfaLevel: null,
        });

        // `<pdfaid:part>` in chunk 0 and `<pdfaid:conformance>` in chunk 1 combine cleanly.
        const splitPdfa = new Uint8Array(PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES + 256);
        splitPdfa.fill(0x20);
        splitPdfa.set(enc.encode('<pdfaid:part>2</pdfaid:part>'), 100);
        splitPdfa.set(enc.encode('<pdfaid:conformance>b</pdfaid:conformance>'), PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES + 64);
        expect(scanPdfMarkerEvidence(splitPdfa)).toEqual({
            isEncrypted: false,
            pdfaLevel: 'PDF/A-2B',
        });

        // PDF/A-4 omits `<pdfaid:conformance>`.
        expect(scanPdfMarkerEvidence(enc.encode('<pdfaid:part>4</pdfaid:part>'))).toEqual({
            isEncrypted: false,
            pdfaLevel: 'PDF/A-4',
        });

        // Long whitespace (>9,000 spaces) straddling the 4 MiB boundary still matches.
        const longWs = new Uint8Array(PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES + 16_384);
        longWs.fill(0x20);
        longWs.set(
            enc.encode(`<pdfaid:part>${' '.repeat(9_500)}2</pdfaid:part><pdfaid:conformance>b</pdfaid:conformance>`),
            PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES - 7_000,
        );
        expect(scanPdfMarkerEvidence(longWs)).toEqual({
            isEncrypted: false,
            pdfaLevel: 'PDF/A-2B',
        });

        // Oversized (>256 byte) malformed token is ignored cleanly; Windows-1252 0x9A matches Š.
        expect(scanPdfMarkerEvidence(enc.encode(`<pdfaid:part>${'X'.repeat(65_536)}</pdfaid:part>`))).toEqual({
            isEncrypted: false,
            pdfaLevel: null,
        });
        const win1252 = new Uint8Array([
            ...enc.encode('<pdfaid:part>2</pdfaid:part><pdfaid:conformance>'),
            0x9a,
            ...enc.encode('</pdfaid:conformance>'),
        ]);
        expect(scanPdfMarkerEvidence(win1252)).toEqual({
            isEncrypted: false,
            pdfaLevel: 'PDF/A-2\u0160',
        });
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

    it('lets markers widen structural encryption facts and carry PDF/A, never signing', () => {
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
        expect(
            createPdfConformanceProfile(structuralFacts, {
                isEncrypted: true,
                pdfaLevel: 'PDF/A-2B',
            }),
        ).toEqual({
            ...structuralFacts,
            isEncrypted: true,
            pdfaLevel: 'PDF/A-2B',
            canIncrementalSave: false,
            saveRestrictions: [
                'encrypted_document_requires_preservation',
                'tagged_pdf_requires_structure_preservation',
                'pdfa_preservation_required:PDF/A-2B',
                'incremental_save_not_supported',
            ],
        });
    });

    it('reads an empty signature field as unsigned for Save and Optimize alike', () => {
        const emptySignatureField = new TextEncoder().encode('<< /FT /Sig /T (Signature1) >> << /Type /Sig >>');
        const profile = createPdfConformanceProfile(
            {
                isSigned: false,
                isEncrypted: false,
                isTagged: false,
                hasAcroForm: true,
                hasXfa: false,
            },
            scanPdfMarkerEvidence(emptySignatureField),
        );

        expect(profile.isSigned).toBe(false);
        expect(profile.saveRestrictions).toEqual([]);
        expect(getPdfLosslessOptimizationSkipReason(profile)).toBeNull();
    });

    it('detects PDF/A and encryption markers', () => {
        const pdfaText = `
            <pdfaid:part>2</pdfaid:part>
            <pdfaid:conformance>b</pdfaid:conformance>
            /ByteRange [0 10 20 30]
            /Encrypt 42 0 R
        `;

        expect(detectPdfaLevelFromPdfText(pdfaText)).toBe('PDF/A-2B');
        expect(hasPdfEncryptMarkersInPdfText(pdfaText)).toBe(true);
    });
});
