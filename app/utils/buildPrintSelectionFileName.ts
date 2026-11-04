import { normalizePrintPageNumbers } from '@app/utils/pdfPrintShared';

const DEFAULT_PDF_FILE_NAME = 'document.pdf';
const DEFAULT_PDF_STEM = 'document';
const PDF_FILE_EXTENSION_PATTERN = /\.pdf$/iu;
const WINDOWS_FORBIDDEN_FILE_NAME_CHARACTERS_PATTERN = /[<>:"/\\|?*]/gu;
const WINDOWS_RESERVED_DEVICE_STEM_PATTERN = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const TRAILING_FILE_NAME_CHARACTERS_PATTERN = /[ .]+$/u;
const MAX_EXACT_PAGE_SPEC_LENGTH = 80;
const MAX_PRINT_FILE_NAME_LENGTH = 180;
const FNV_1A_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_1A_PRIME_32 = 0x01000193;
const textEncoder = new TextEncoder();

interface IPrintSelectionSummary {
    count: number;
    first: number;
    last: number;
    fingerprint: string;
}

interface IBuildPrintSelectionFileNameOptions {
    fileName: string | null | undefined;
    pageNumbers: number[] | undefined;
    totalPages: number;
    formatPage: (page: number) => string;
    formatPages: (pages: string) => string;
    formatSelection: (selection: IPrintSelectionSummary) => string;
}

function resolveSourceFileName(fileName: string | null | undefined) {
    const trimmedFileName = fileName?.trim();
    if (!trimmedFileName) {
        return DEFAULT_PDF_FILE_NAME;
    }

    const baseName = trimmedFileName.split(/[\\/]/u).at(-1);
    return baseName?.length ? baseName : DEFAULT_PDF_FILE_NAME;
}

function sanitizeFileNameText(value: string) {
    return Array.from(value, (character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint <= 31
            ? '_'
            : character.replace(WINDOWS_FORBIDDEN_FILE_NAME_CHARACTERS_PATTERN, '_');
    }).join('');
}

function sanitizeSourceStem(sourceFileName: string) {
    const sourceStem = sourceFileName.replace(PDF_FILE_EXTENSION_PATTERN, '');
    const sanitizedStem = sanitizeFileNameText(sourceStem)
        .replace(TRAILING_FILE_NAME_CHARACTERS_PATTERN, '');

    if (!sanitizedStem || sanitizedStem === '.' || sanitizedStem === '..') {
        return DEFAULT_PDF_STEM;
    }

    if (WINDOWS_RESERVED_DEVICE_STEM_PATTERN.test(sanitizedStem)) {
        return `_${sanitizedStem}`;
    }

    return sanitizedStem;
}

function formatPageSpec(pageNumbers: number[]) {
    const ranges: string[] = [];
    let rangeStart = pageNumbers[0];
    let rangeEnd = rangeStart;

    for (let index = 1; index < pageNumbers.length; index += 1) {
        const pageNumber = pageNumbers[index];
        if (pageNumber === undefined || rangeStart === undefined || rangeEnd === undefined) {
            continue;
        }

        if (pageNumber === rangeEnd + 1) {
            rangeEnd = pageNumber;
            continue;
        }

        ranges.push(rangeStart === rangeEnd
            ? String(rangeStart)
            : `${String(rangeStart)}-${String(rangeEnd)}`);
        rangeStart = pageNumber;
        rangeEnd = pageNumber;
    }

    if (rangeStart !== undefined && rangeEnd !== undefined) {
        ranges.push(rangeStart === rangeEnd
            ? String(rangeStart)
            : `${String(rangeStart)}-${String(rangeEnd)}`);
    }

    return ranges.join('_');
}

function fingerprintPageSpec(pageSpec: string) {
    let hash = FNV_1A_OFFSET_BASIS_32;
    for (const byte of textEncoder.encode(pageSpec)) {
        hash ^= byte;
        hash = Math.imul(hash, FNV_1A_PRIME_32);
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
}

function getTextSegments(value: string) {
    return Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
        segment => segment.segment,
    );
}

function truncateTextToBudget(value: string, maxLength: number, maxBytes: number) {
    let result = '';
    let resultBytes = 0;

    for (const segment of getTextSegments(value)) {
        const segmentBytes = textEncoder.encode(segment).byteLength;
        if (result.length + segment.length > maxLength || resultBytes + segmentBytes > maxBytes) {
            break;
        }
        result += segment;
        resultBytes += segmentBytes;
    }

    return result;
}

function fitsFileNameBudget(value: string) {
    return value.length <= MAX_PRINT_FILE_NAME_LENGTH
        && textEncoder.encode(value).byteLength <= MAX_PRINT_FILE_NAME_LENGTH;
}

function appendFileNameSuffix(sourceFileName: string, suffix: string) {
    const sourceStem = sanitizeSourceStem(sourceFileName);
    const completeFileName = `${sourceStem}${suffix}`;
    if (fitsFileNameBudget(completeFileName)) {
        return completeFileName;
    }

    const truncationSuffix = `~${suffix}`;
    const truncatedStem = truncateTextToBudget(
        sourceStem,
        MAX_PRINT_FILE_NAME_LENGTH - truncationSuffix.length,
        MAX_PRINT_FILE_NAME_LENGTH - textEncoder.encode(truncationSuffix).byteLength,
    ).replace(TRAILING_FILE_NAME_CHARACTERS_PATTERN, '');

    const fallbackStem = truncatedStem || DEFAULT_PDF_STEM;
    const truncatedFileName = `${fallbackStem}${truncationSuffix}`;
    if (fitsFileNameBudget(truncatedFileName)) {
        return truncatedFileName;
    }

    return `${DEFAULT_PDF_STEM}${suffix}`;
}

function buildSourcePdfFileName(sourceFileName: string) {
    return appendFileNameSuffix(sourceFileName, '.pdf');
}

function appendSelectionLabel(sourceFileName: string, selectionLabel: string) {
    const safeSelectionLabel = sanitizeFileNameText(selectionLabel)
        .replace(TRAILING_FILE_NAME_CHARACTERS_PATTERN, '');

    return appendFileNameSuffix(sourceFileName, ` - ${safeSelectionLabel}.pdf`);
}

export function buildPrintSelectionFileName(options: IBuildPrintSelectionFileNameOptions) {
    const sourceFileName = resolveSourceFileName(options.fileName);
    if (!options.pageNumbers?.length) {
        return buildSourcePdfFileName(sourceFileName);
    }

    const pageNumbers = normalizePrintPageNumbers(options.pageNumbers, options.totalPages);
    if (pageNumbers.length === 0 || pageNumbers.length === options.totalPages) {
        return buildSourcePdfFileName(sourceFileName);
    }

    const [firstPage] = pageNumbers;
    if (firstPage === undefined) {
        return buildSourcePdfFileName(sourceFileName);
    }

    if (pageNumbers.length === 1) {
        return appendSelectionLabel(sourceFileName, options.formatPage(firstPage));
    }

    const pageSpec = formatPageSpec(pageNumbers);
    const selectionLabel = pageSpec.length <= MAX_EXACT_PAGE_SPEC_LENGTH
        ? options.formatPages(pageSpec)
        : options.formatSelection({
            count: pageNumbers.length,
            first: firstPage,
            last: pageNumbers.at(-1) ?? firstPage,
            fingerprint: fingerprintPageSpec(pageSpec),
        });

    return appendSelectionLabel(sourceFileName, selectionLabel);
}
