import type {
    IPdfConformanceProfile,
    TPdfConformanceProfileBase,
    TPdfaLevel,
} from '@contracts/pdfConformance';

const PDFA_PART_PATTERN = /<pdfaid:part>\s*([^<\s]+)\s*<\/pdfaid:part>/iu;
const PDFA_CONFORMANCE_PATTERN = /<pdfaid:conformance>\s*([^<\s]+)\s*<\/pdfaid:conformance>/iu;
const PDF_SIGNATURE_PATTERN = /\/(?:ByteRange|FT\s*\/Sig|Type\s*\/Sig)\b/u;
const PDF_ENCRYPT_PATTERN = /\/Encrypt\b/u;
export const PDF_ENCRYPT_SCAN_REGION_BYTES = 32 * 1024;
const pdfBinaryDecoder = new TextDecoder('latin1');

type TPdfConformanceFallbackOverrides = Partial<Omit<TPdfConformanceProfileBase, 'canIncrementalSave'>>;

export function detectPdfaLevelFromPdfText(text: string): TPdfaLevel | null {
    const partMatch = text.match(PDFA_PART_PATTERN);
    if (!partMatch?.[1]) {
        return null;
    }

    const conformanceMatch = text.match(PDFA_CONFORMANCE_PATTERN);
    const conformance = conformanceMatch?.[1]?.trim().toUpperCase() ?? '';
    return `PDF/A-${partMatch[1].trim()}${conformance}`;
}

export function hasPdfSignatureMarkersInPdfText(text: string) {
    return PDF_SIGNATURE_PATTERN.test(text);
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

export function createConservativePdfConformanceFallbackProfile(
    overrides: TPdfConformanceFallbackOverrides = {},
): IPdfConformanceProfile {
    const profileBase = {
        ...createDefaultPdfConformanceProfile(),
        ...overrides,
        canIncrementalSave: false,
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
