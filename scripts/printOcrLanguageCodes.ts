import {
    BUNDLED_OCR_LANGUAGE_CODES,
    OCR_LANGUAGE_MODEL_SHA256,
    OCR_MODEL_CODES,
} from '@contracts/ocrLanguages';

const separator = process.argv.includes('--space') ? ' ' : '\n';
const codes = (process.argv.includes('--bundled')
    ? [...BUNDLED_OCR_LANGUAGE_CODES]
    : [...OCR_MODEL_CODES])
    .sort();

if (codes.length === 0) {
    throw new Error('No OCR language codes are registered.');
}

process.stdout.write(process.argv.includes('--sha256')
    ? codes.map((code) => {
        const sha256 = OCR_LANGUAGE_MODEL_SHA256[code];
        return `${code} ${sha256}`;
    }).join('\n')
    : codes.join(separator));
