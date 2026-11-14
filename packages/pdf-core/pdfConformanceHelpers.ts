import type {
    IPdfConformanceProfile,
    TPdfConformanceProfileBase,
    TPdfaLevel,
} from '@contracts/pdfConformance';

const PDFA_PART_PATTERN = /<pdfaid:part>\s*([^<\s]+)\s*<\/pdfaid:part>/iu;
const PDFA_CONFORMANCE_PATTERN = /<pdfaid:conformance>\s*([^<\s]+)\s*<\/pdfaid:conformance>/iu;
const PDF_ENCRYPT_PATTERN = /\/Encrypt\b/u;
export const PDF_ENCRYPT_SCAN_REGION_BYTES = 32 * 1024;
const pdfBinaryDecoder = new TextDecoder('latin1');

type TPdfStructuralConformanceFacts = Pick<
    TPdfConformanceProfileBase,
    'isSigned' | 'isEncrypted' | 'isTagged' | 'hasAcroForm' | 'hasXfa'
>;
type TPdfConformanceMarkerEvidence = Pick<TPdfConformanceProfileBase, 'isEncrypted' | 'pdfaLevel'>;

const NO_PDF_CONFORMANCE_MARKER_EVIDENCE: TPdfConformanceMarkerEvidence = {
    isEncrypted: false,
    pdfaLevel: null,
};

export function detectPdfaLevelFromPdfText(text: string): TPdfaLevel | null {
    const partMatch = text.match(PDFA_PART_PATTERN);
    if (!partMatch?.[1]) {
        return null;
    }

    const conformanceMatch = text.match(PDFA_CONFORMANCE_PATTERN);
    const conformance = conformanceMatch?.[1]?.trim().toUpperCase() ?? '';
    return `PDF/A-${partMatch[1].trim()}${conformance}`;
}

export function hasPdfEncryptMarkersInPdfText(text: string) {
    return PDF_ENCRYPT_PATTERN.test(text);
}

export function containsPdfEncryptMarker(bytes: Uint8Array) {
    return hasPdfEncryptMarkersInPdfText(pdfBinaryDecoder.decode(bytes));
}

export function createDefaultPdfConformanceProfile(): IPdfConformanceProfile {
    return {
        isSigned: false,
        isEncrypted: false,
        isTagged: false,
        pdfaLevel: null,
        hasAcroForm: false,
        hasXfa: false,
        canIncrementalSave: true,
        saveRestrictions: [],
    };
}

/**
 * The conformance policy for a document whose structure pdf-page-ops read.
 * The structure decides signing, tagging, forms and XFA: a document is signed
 * when a signature field holds a signature value, never for an empty field.
 * Byte markers can only add encryption the structure did not show, and only
 * they carry the PDF/A claim; a caller that wants the structural answer alone
 * omits them.
 */
export function createPdfConformanceProfile(
    structuralFacts: TPdfStructuralConformanceFacts,
    markerEvidence: TPdfConformanceMarkerEvidence = NO_PDF_CONFORMANCE_MARKER_EVIDENCE,
): IPdfConformanceProfile {
    const isEncrypted = structuralFacts.isEncrypted || markerEvidence.isEncrypted;
    const profileBase = {
        isSigned: structuralFacts.isSigned,
        isEncrypted,
        isTagged: structuralFacts.isTagged,
        pdfaLevel: markerEvidence.pdfaLevel,
        hasAcroForm: structuralFacts.hasAcroForm,
        hasXfa: structuralFacts.hasXfa,
        canIncrementalSave: !(isEncrypted || structuralFacts.hasXfa),
    };

    return {
        ...profileBase,
        saveRestrictions: buildPdfSaveRestrictions(profileBase),
    };
}

export function buildPdfSaveRestrictions(profile: TPdfConformanceProfileBase) {
    const restrictions: string[] = [];

    if (profile.isSigned) {
        restrictions.push('signed_original_requires_save_as');
    }
    if (profile.isEncrypted) {
        restrictions.push('encrypted_document_requires_preservation');
    }
    if (profile.hasXfa) {
        restrictions.push('xfa_forms_are_not_supported_for_rewrite');
    }
    if (profile.isTagged) {
        restrictions.push('tagged_pdf_requires_structure_preservation');
    }
    if (profile.pdfaLevel) {
        restrictions.push(`pdfa_preservation_required:${profile.pdfaLevel}`);
    }
    if (!profile.canIncrementalSave) {
        restrictions.push('incremental_save_not_supported');
    }

    return restrictions;
}

export const PDF_LOSSLESS_OPTIMIZE_MIN_BYTES = 64 * 1024 * 1024;
export const PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
export const PDF_CONFORMANCE_MARKER_SCAN_OVERLAP_BYTES = 4 * 1024;

export function getPdfLosslessOptimizationSkipReason(profile: IPdfConformanceProfile): string | null {
    if (profile.isSigned) return 'signed PDF';
    if (profile.isEncrypted) return 'encrypted PDF';
    if (profile.pdfaLevel) return `${profile.pdfaLevel} PDF`;
    if (profile.hasXfa) return 'XFA PDF';
    return null;
}

/** Bounded text windows, including markers crossing a window boundary. */
export function scanPdfMarkerEvidence(data: Uint8Array): TPdfConformanceMarkerEvidence {
    let isEncrypted = false;
    let pdfaLevel: TPdfaLevel | null = null;
    for (let offset = 0; offset < data.byteLength;) {
        const end = Math.min(data.byteLength, offset + PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES);
        const text = pdfBinaryDecoder.decode(data.subarray(offset, end));
        isEncrypted ||= hasPdfEncryptMarkersInPdfText(text);
        pdfaLevel ??= detectPdfaLevelFromPdfText(text);
        if (end === data.byteLength) break;
        offset = Math.max(offset + 1, end - PDF_CONFORMANCE_MARKER_SCAN_OVERLAP_BYTES);
    }
    return {
        isEncrypted,
        pdfaLevel,
    };
}
