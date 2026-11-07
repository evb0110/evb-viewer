import {sha256Utf8Hex} from '@evb/scan-cleanup/core/sha256Utf8Hex';

export const SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES = 255;
const OUTPUT_NAME_HASH_HEX_LENGTH = 12;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function utf8Prefix(value: string, maxBytes: number) {
    let bytes = 0;
    let prefix = '';
    for (const character of value) {
        const characterBytes = utf8Bytes(character);
        if (bytes + characterBytes > maxBytes) {
            break;
        }
        prefix += character;
        bytes += characterBytes;
    }
    return prefix;
}

/**
 * The cleaned document's file name for a source named `sourceName` (without
 * its extension), within one file-name leaf. A name too long for the leaf is
 * truncated and kept distinct by a short hash of the whole source name.
 */
export function formatScanCleanupOutputName(sourceName: string, partial: boolean) {
    const name = sourceName.trim() || 'document';
    const suffix = ` — cleaned${partial ? ' selection' : ''}.pdf`;
    const fullName = `${name}${suffix}`;
    if (utf8Bytes(fullName) <= SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES) {
        return fullName;
    }
    const disambiguator = `…-${sha256Utf8Hex(name).slice(0, OUTPUT_NAME_HASH_HEX_LENGTH)}`;
    const prefixBytes = SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES - utf8Bytes(`${disambiguator}${suffix}`);
    return `${utf8Prefix(name, prefixBytes).trimEnd()}${disambiguator}${suffix}`;
}
