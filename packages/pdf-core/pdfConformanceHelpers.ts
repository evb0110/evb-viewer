import type {IPdfConformanceProfile, TPdfConformanceProfileBase, TPdfaLevel} from '@contracts/pdfConformance';

const PDFA_PART_PATTERN = /<pdfaid:part>\s*([^<\s]{1,256})\s*<\/pdfaid:part>/iu;
const PDFA_CONFORMANCE_PATTERN = /<pdfaid:conformance>\s*([^<\s]{1,256})\s*<\/pdfaid:conformance>/iu;
const PDF_ENCRYPT_PATTERN = /\/Encrypt\b/u;
export const PDF_ENCRYPT_SCAN_REGION_BYTES = 32 * 1024;
const pdfBinaryDecoder = new TextDecoder('latin1');

type TPdfStructuralConformanceFacts = Pick<TPdfConformanceProfileBase, 'isSigned' | 'isEncrypted' | 'isTagged' | 'hasAcroForm' | 'hasXfa'>;
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
    if (profile.isSigned) {
        return 'signed PDF';
    }
    if (profile.isEncrypted) {
        return 'encrypted PDF';
    }
    if (profile.pdfaLevel) {
        return `${profile.pdfaLevel} PDF`;
    }
    if (profile.hasXfa) {
        return 'XFA PDF';
    }
    return null;
}

const MAX_PDFA_MARKER_TOKEN_BYTES = 256;
const PDFA_PART_OPEN_BYTES = new TextEncoder().encode('<pdfaid:part>');
const PDFA_PART_CLOSE_BYTES = new TextEncoder().encode('</pdfaid:part>');
const PDFA_CONFORMANCE_OPEN_BYTES = new TextEncoder().encode('<pdfaid:conformance>');
const PDFA_CONFORMANCE_CLOSE_BYTES = new TextEncoder().encode('</pdfaid:conformance>');
const MIN_ENCRYPT_MARKER_BYTES = 8; // "/Encrypt"
const MIN_PDFA_PART_TAG_BYTES = PDFA_PART_OPEN_BYTES.byteLength + 1 + PDFA_PART_CLOSE_BYTES.byteLength;

function isLatin1JsWhitespaceByte(byte: number): boolean {
    return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d) || byte === 0xa0;
}

function isLatin1JsWordByte(byte: number): boolean {
    return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f;
}

function asciiBytesEqualIgnoreCase(a: number, b: number): boolean {
    if (a === b) {
        return true;
    }
    const lowerA = a >= 0x41 && a <= 0x5a ? a | 0x20 : a;
    const lowerB = b >= 0x41 && b <= 0x5a ? b | 0x20 : b;
    return lowerA === lowerB;
}

function matchXmlTagAtOffset(
    data: Uint8Array,
    start: number,
    openBytes: Uint8Array,
    closeBytes: Uint8Array,
    uppercase: boolean,
): string | null {
    const len = data.byteLength;
    const openLen = openBytes.byteLength;
    if (start + openLen >= len) {
        return null;
    }
    for (let j = 8; j < openLen; j += 1) {
        if (!asciiBytesEqualIgnoreCase(data[start + j]!, openBytes[j]!)) {
            return null;
        }
    }
    let pos = start + openLen;
    while (pos < len && isLatin1JsWhitespaceByte(data[pos]!)) {
        pos += 1;
    }
    const tokenStart = pos;
    while (pos < len && data[pos]! !== 0x3c && !isLatin1JsWhitespaceByte(data[pos]!)) {
        pos += 1;
        if (pos - tokenStart > MAX_PDFA_MARKER_TOKEN_BYTES) {
            return null;
        }
    }
    const tokenEnd = pos;
    if (tokenEnd === tokenStart) {
        return null;
    }
    while (pos < len && isLatin1JsWhitespaceByte(data[pos]!)) {
        pos += 1;
    }
    const closeLen = closeBytes.byteLength;
    if (pos + closeLen > len) {
        return null;
    }
    for (let j = 0; j < closeLen; j += 1) {
        if (!asciiBytesEqualIgnoreCase(data[pos + j]!, closeBytes[j]!)) {
            return null;
        }
    }
    const decoded = pdfBinaryDecoder.decode(data.subarray(tokenStart, tokenEnd));
    return uppercase ? decoded.toUpperCase() : decoded;
}

/**
 * Scans raw PDF bytes for `/Encrypt\b` and XMP PDF/A tags without allocating
 * latin1 chunk strings or breaking across internal chunk boundaries, even with
 * arbitrary whitespace inside `<pdfaid:*>` elements.
 */
export function scanPdfMarkerEvidence(data: Uint8Array): TPdfConformanceMarkerEvidence {
    const len = data.byteLength;
    let isEncrypted = false;
    let pdfaPart: string | null = null;
    let pdfaConformance: string | null = null;

    // Anchor on rare bytes ('y' = 0x79 inside "/Encrypt", ':' = 0x3a inside
    // "<pdfaid:") so PDFs dense with '/' names or '<...>' hex-encoded text
    // operands fly through native TypedArray.prototype.indexOf without stalling.
    if (len >= MIN_ENCRYPT_MARKER_BYTES) {
        const maxEncryptYPos = len - 3;
        for (let yPos = data.indexOf(0x79, 5); yPos !== -1 && yPos <= maxEncryptYPos; yPos = data.indexOf(0x79, yPos + 1)) {
            if (
                data[yPos - 5] === 0x2f &&
                data[yPos - 4] === 0x45 &&
                data[yPos - 3] === 0x6e &&
                data[yPos - 2] === 0x63 &&
                data[yPos - 1] === 0x72 &&
                data[yPos + 1] === 0x70 &&
                data[yPos + 2] === 0x74
            ) {
                const after = yPos + 3;
                if (after === len || !isLatin1JsWordByte(data[after]!)) {
                    isEncrypted = true;
                    break;
                }
            }
        }
    }

    if (len >= MIN_PDFA_PART_TAG_BYTES) {
        for (let colonPos = data.indexOf(0x3a, 7); colonPos !== -1; colonPos = data.indexOf(0x3a, colonPos + 1)) {
            if (
                data[colonPos - 7] !== 0x3c ||
                (data[colonPos - 6]! | 0x20) !== 0x70 ||
                (data[colonPos - 5]! | 0x20) !== 0x64 ||
                (data[colonPos - 4]! | 0x20) !== 0x66 ||
                (data[colonPos - 3]! | 0x20) !== 0x61 ||
                (data[colonPos - 2]! | 0x20) !== 0x69 ||
                (data[colonPos - 1]! | 0x20) !== 0x64
            ) {
                continue;
            }
            const start = colonPos - 7;
            if (pdfaPart === null) {
                pdfaPart = matchXmlTagAtOffset(data, start, PDFA_PART_OPEN_BYTES, PDFA_PART_CLOSE_BYTES, false);
            }
            if (pdfaConformance === null) {
                pdfaConformance = matchXmlTagAtOffset(data, start, PDFA_CONFORMANCE_OPEN_BYTES, PDFA_CONFORMANCE_CLOSE_BYTES, true);
            }
            if (pdfaPart !== null && pdfaConformance !== null) {
                break;
            }
        }
    }

    return {
        isEncrypted,
        pdfaLevel: pdfaPart === null ? null : `PDF/A-${pdfaPart}${pdfaConformance ?? ''}`,
    };
}
