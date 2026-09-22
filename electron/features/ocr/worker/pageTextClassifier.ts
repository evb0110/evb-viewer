import {runOcrCommand} from '@electron/features/ocr/worker/runOcrCommand';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import type {
    TOcrPageTextClassification,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';

const TEXT_TOKEN_RE = /\bBT\b|\bET\b|(?:^|\s)([0-7])(?:\.0+)?\s+Tr\b|\b(Tj|TJ)\b|(?:^|\s)(['"])(?=\s|$)/gm;
const EVB_OCR_LAYER_MARKER = 'EVB_VIEWER_OCR_LAYER';
const EVB_OCR_LAYER_BLOCK_RE = /(?:^|\r?\n)\s*%\s+EVB_VIEWER_OCR_LAYER_BEGIN\s*\r?\n[\s\S]*?(?:^|\r?\n)\s*\/[A-Za-z0-9._-]+\s+Do\b[^\r\n]*\r?\n[\s\S]*?(?:^|\r?\n)\s*%\s+EVB_VIEWER_OCR_LAYER_END\s*(?=\r?\n|$)/m;
const OCR_TEXT_VISIBILITY_MAX_PAGE_MAP_BYTES = 16 * 1024 * 1024;
const OCR_TEXT_VISIBILITY_MAX_STREAM_BYTES = 4 * 1024 * 1024;
const OCR_TEXT_VISIBILITY_MAX_PAGE_BYTES = 16 * 1024 * 1024;
const OCR_TEXT_VISIBILITY_TIMEOUT_MS = 2 * 60 * 1000;
const OCR_TEXT_WORD_RE = /[\p{L}\p{N}]+/gu;
const OCR_TEXT_SINGLE_CHARACTER_TOKEN_MAX_FRACTION = 0.6;
const OCR_TEXT_MINIMUM_LONG_TOKEN_COUNT = 2;
const OCR_TEXT_SHORT_PHRASE_MAX_TOKEN_COUNT = 2;

type TOcrTextScript = 'latin' | 'cyrillic' | 'greek' | 'rtl' | 'han' | 'kana' | 'hangul' | 'devanagari' | 'thai';

const OCR_LANGUAGE_SCRIPTS: Record<string, readonly TOcrTextScript[]> = {
    ara: ['rtl'],
    bul: ['cyrillic'],
    ces: ['latin'],
    chi_sim: ['han'],
    chi_tra: ['han'],
    dan: ['latin'],
    deu: ['latin'],
    ell: ['greek'],
    eng: ['latin'],
    fin: ['latin'],
    fra: ['latin'],
    grc: ['greek'],
    heb: ['rtl'],
    hrv: ['latin'],
    hun: ['latin'],
    ind: ['latin'],
    ita: ['latin'],
    jpn: [
        'han',
        'kana',
    ],
    kmr: ['latin'],
    kor: ['hangul'],
    nld: ['latin'],
    nor: ['latin'],
    pol: ['latin'],
    por: ['latin'],
    ron: ['latin'],
    rus: ['cyrillic'],
    slk: ['latin'],
    spa: ['latin'],
    srp: ['cyrillic'],
    swe: ['latin'],
    syr: ['rtl'],
    tha: ['thai'],
    tur: ['latin'],
    ukr: ['cyrillic'],
    vie: ['latin'],
};

const OCR_SCRIPT_PATTERNS: Record<TOcrTextScript, RegExp> = {
    latin: /\p{Script_Extensions=Latin}/u,
    cyrillic: /\p{Script_Extensions=Cyrillic}/u,
    greek: /\p{Script_Extensions=Greek}/u,
    rtl: /[\p{Script_Extensions=Arabic}\p{Script_Extensions=Hebrew}\p{Script_Extensions=Syriac}]/u,
    han: /\p{Script_Extensions=Han}/u,
    kana: /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u,
    hangul: /\p{Script_Extensions=Hangul}/u,
    devanagari: /\p{Script_Extensions=Devanagari}/u,
    thai: /\p{Script_Extensions=Thai}/u,
};

function getLanguageScripts(languages: readonly string[]) {
    const scripts = new Set<TOcrTextScript>();
    for (const language of languages) {
        for (const script of OCR_LANGUAGE_SCRIPTS[language] ?? []) {
            scripts.add(script);
        }
    }
    return scripts;
}

export interface IOcrPageTextEvidence {
    classification: TOcrPageTextClassification;
    extractedTextLength: number;
    hasHiddenTextOperators: boolean;
    hasVisibleTextOperators: boolean;
    evbGeneration?: string;
}

export interface IOcrPdfTextVisibility {
    hasHiddenTextOperators: boolean;
    hasVisibleTextOperators: boolean;
}

function hasLanguageScript(text: string, languages: readonly string[] | undefined) {
    // Digits are script-neutral. A page containing only a page number, date,
    // or other numeric label is still valid selectable OCR regardless of the
    // selected language model.
    if (!/\p{L}/u.test(text)) {
        return true;
    }
    if (languages === undefined || languages.length === 0) {
        return true;
    }
    const scripts = getLanguageScripts(languages);
    // An unrecognized model code must not make the classifier guess Latin and
    // reject otherwise valid OCR in a script it does not know about yet.
    if (scripts.size === 0) return true;
    return [...scripts].some(script => OCR_SCRIPT_PATTERNS[script].test(text));
}

/**
 * Existing EVB generations are normally safe to retain, but a previous OCR
 * run can have produced only isolated glyph fragments. Presence of text is
 * not enough to call that layer selectable. Keep this conservative and apply
 * it only to EVB-owned OCR, so native authored text is never replaced by a
 * heuristic.
 */
export function isLikelyUsableOcrText(
    text: string,
    languages?: readonly string[],
) {
    const tokens = text.match(OCR_TEXT_WORD_RE) ?? [];
    if (tokens.length === 0 || !hasLanguageScript(text, languages)) {
        return false;
    }
    const singleCharacterTokens = tokens.filter(token => Array.from(token).length <= 1).length;
    const longTokens = tokens.filter(token => Array.from(token).length >= 3).length;
    const numericOnly = tokens.every(token => /^\p{N}+$/u.test(token));
    if (numericOnly) {
        return true;
    }
    const singleTokenIsMixedAlphaNumeric = tokens.length === 1
        && /\p{L}/u.test(tokens[0])
        && /\p{N}/u.test(tokens[0]);
    const shortPhraseHasMeaningfulWord = tokens.length <= OCR_TEXT_SHORT_PHRASE_MAX_TOKEN_COUNT
        && longTokens > 0;
    return singleCharacterTokens / tokens.length < OCR_TEXT_SINGLE_CHARACTER_TOKEN_MAX_FRACTION
        && !singleTokenIsMixedAlphaNumeric
        // A page can legitimately contain one isolated word, a short heading
        // such as “Глава 1”, or a numeric-only label. The two-long-token guard
        // is still useful for the multi-fragment garbage produced by a broken
        // OCR layer, but must not reject those valid short results.
        && (longTokens >= OCR_TEXT_MINIMUM_LONG_TOKEN_COUNT
            || tokens.length === 1
            || shortPhraseHasMeaningfulWord);
}

export function inspectPdfTextVisibility(streamSources: readonly string[]): IOcrPdfTextVisibility {
    let renderingMode = 0;
    let inTextObject = false;
    let hasHiddenTextOperators = false;
    let hasVisibleTextOperators = false;

    for (const source of streamSources) {
        // EVB's searchable layer is a marked Form XObject. The page content
        // stream therefore contains the marker and a Do operator, while the
        // BT/ET and 3 Tr operators live in the nested object. Treat the
        // marker as hidden text evidence so a missing catalog cannot make an
        // unusable EVB layer look like native text and skip rescan.
        if (source.includes(EVB_OCR_LAYER_MARKER) && EVB_OCR_LAYER_BLOCK_RE.test(source)) {
            hasHiddenTextOperators = true;
        }
        TEXT_TOKEN_RE.lastIndex = 0;
        for (const match of source.matchAll(TEXT_TOKEN_RE)) {
            const token = match[0].trim();
            if (token === 'BT') {
                inTextObject = true;
            } else if (token === 'ET') {
                inTextObject = false;
            } else if (match[1] !== undefined) {
                renderingMode = Number(match[1]);
            } else if (inTextObject && (match[2] !== undefined || match[3] !== undefined)) {
                if (renderingMode === 3) hasHiddenTextOperators = true;
                else hasVisibleTextOperators = true;
            }
        }
    }
    return {
        hasHiddenTextOperators,
        hasVisibleTextOperators,
    };
}

export type TOcrPdfTextVisibilityAnalysis =
    | {
        status: 'available';
        visibility: Map<number, IOcrPdfTextVisibility>;
    }
    | {
        status: 'degraded';
        reason: 'qpdf-unavailable' | 'qpdf-failed';
        message: string;
        visibility: Map<number, IOcrPdfTextVisibility>;
    };

interface IOcrQpdfPage {contentObjects: string[]}

function abortIfRequested(signal?: AbortSignal) {
    if (!signal?.aborted) {
        return;
    }
    throw signal.reason instanceof Error ? signal.reason : new Error('OCR job aborted');
}

function parseQpdfPageMap(output: string, requestedPageNumbers: ReadonlySet<number>) {
    const pages = new Map<number, IOcrQpdfPage>();
    let currentPage: IOcrQpdfPage | null = null;
    let readingContents = false;

    for (const line of output.split(/\r?\n/u)) {
        const pageMatch = /^page\s+(\d+):\s+(\d+)\s+(\d+)\s+R\s*$/u.exec(line);
        if (pageMatch) {
            const pageNumber = Number(pageMatch[1]);
            currentPage = requestedPageNumbers.has(pageNumber)
                ? {contentObjects: []}
                : null;
            if (currentPage) {
                pages.set(pageNumber, currentPage);
            }
            readingContents = false;
            continue;
        }
        if (currentPage === null) {
            continue;
        }
        if (line.trim() === 'content:') {
            readingContents = true;
            continue;
        }
        if (!readingContents) {
            continue;
        }
        const contentMatch = /^\s+(\d+)\s+(\d+)\s+R\s*$/u.exec(line);
        if (contentMatch) {
            const objectNumber = contentMatch[1] ?? '<missing>';
            const generation = contentMatch[2] ?? '<missing>';
            currentPage.contentObjects.push(`${objectNumber},${generation}`);
            continue;
        }
        if (line.trim().length > 0 && !/^\s/u.test(line)) {
            readingContents = false;
        }
    }

    for (const pageNumber of requestedPageNumbers) {
        if (!pages.has(pageNumber)) {
            throw new Error(`qpdf did not report requested page ${pageNumber}`);
        }
    }
    return pages;
}

async function inspectPdfPageTextVisibilityWithQpdf(
    pdfPath: string,
    pageNumbers: readonly number[],
    qpdfBinary: string,
    signal?: AbortSignal,
): Promise<Map<number, IOcrPdfTextVisibility>> {
    abortIfRequested(signal);
    const requestedPageNumbers = new Set(pageNumbers);
    if (requestedPageNumbers.size === 0) {
        return new Map();
    }
    const pageMapResult = await runOcrCommand(qpdfBinary, [
        '--show-pages',
        '--',
        pdfPath,
    ], {
        commandLabel: 'qpdf(ocr-text-visibility-pages)',
        timeoutMs: OCR_TEXT_VISIBILITY_TIMEOUT_MS,
        maxStdoutBytes: OCR_TEXT_VISIBILITY_MAX_PAGE_MAP_BYTES,
        rejectOnStdoutTruncation: true,
        ...(signal ? {signal} : {}),
    });
    const pageMap = parseQpdfPageMap(pageMapResult.stdout, requestedPageNumbers);
    const evidence = new Map<number, IOcrPdfTextVisibility>();

    for (const pageNumber of pageNumbers) {
        abortIfRequested(signal);
        if (evidence.has(pageNumber)) {
            continue;
        }
        const page = pageMap.get(pageNumber);
        if (!page) {
            throw new Error(`qpdf did not report requested page ${pageNumber}`);
        }
        let remainingBytes = OCR_TEXT_VISIBILITY_MAX_PAGE_BYTES;
        const sources: string[] = [];
        for (const objectReference of page.contentObjects) {
            abortIfRequested(signal);
            const byteLimit = Math.min(remainingBytes, OCR_TEXT_VISIBILITY_MAX_STREAM_BYTES);
            if (byteLimit <= 0) {
                throw new RangeError(`OCR text-visibility page ${pageNumber} exceeds the ${OCR_TEXT_VISIBILITY_MAX_PAGE_BYTES}-byte decoded budget`);
            }
            const streamResult = await runOcrCommand(qpdfBinary, [
                '--filtered-stream-data',
                `--show-object=${objectReference}`,
                '--',
                pdfPath,
            ], {
                commandLabel: 'qpdf(ocr-text-visibility-stream)',
                timeoutMs: OCR_TEXT_VISIBILITY_TIMEOUT_MS,
                maxStdoutBytes: byteLimit,
                rejectOnStdoutTruncation: true,
                ...(signal ? {signal} : {}),
            });
            sources.push(streamResult.stdout);
            remainingBytes -= Buffer.byteLength(streamResult.stdout, 'utf8');
            const visibility = inspectPdfTextVisibility(sources);
            if (visibility.hasHiddenTextOperators && visibility.hasVisibleTextOperators) {
                break;
            }
        }
        evidence.set(pageNumber, inspectPdfTextVisibility(sources));
    }
    return evidence;
}

export async function inspectPdfPageTextVisibility(
    pdfPath: string,
    pageNumbers: readonly number[],
    qpdfBinary?: string,
    signal?: AbortSignal,
): Promise<TOcrPdfTextVisibilityAnalysis> {
    if (qpdfBinary === undefined) {
        return {
            status: 'degraded',
            reason: 'qpdf-unavailable',
            message: 'qpdf is unavailable; hidden OCR layers could not be inspected',
            visibility: new Map(),
        };
    }
    try {
        return {
            status: 'available',
            visibility: await inspectPdfPageTextVisibilityWithQpdf(
                pdfPath,
                pageNumbers,
                qpdfBinary,
                signal,
            ),
        };
    } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
            throw error;
        }
        return {
            status: 'degraded',
            reason: 'qpdf-failed',
            message: `qpdf text-visibility inspection failed; hidden OCR layers could not be inspected: ${getErrorMessage(error)}`,
            visibility: new Map(),
        };
    }
}

export function classifyOcrPageText(input: {
    extractedText: string;
    visibility?: IOcrPdfTextVisibility;
    evbGeneration?: string;
    languages?: readonly string[];
}): IOcrPageTextEvidence {
    const extractedTextLength = input.extractedText.trim().length;
    const hasHiddenTextOperators = input.visibility?.hasHiddenTextOperators ?? false;
    const hasVisibleTextOperators = input.visibility?.hasVisibleTextOperators ?? false;
    if (input.evbGeneration && !isLikelyUsableOcrText(input.extractedText, input.languages)) {
        return {
            classification: 'foreign-hidden-ocr',
            extractedTextLength,
            hasHiddenTextOperators,
            hasVisibleTextOperators,
            evbGeneration: input.evbGeneration,
        };
    }
    if (input.evbGeneration) {
        return {
            classification: 'evb-current-generation',
            extractedTextLength,
            hasHiddenTextOperators,
            hasVisibleTextOperators,
            evbGeneration: input.evbGeneration,
        };
    }
    if (extractedTextLength === 0) {
        return {
            classification: 'no-text',
            extractedTextLength,
            hasHiddenTextOperators,
            hasVisibleTextOperators,
        };
    }
    return {
        classification: hasHiddenTextOperators && !hasVisibleTextOperators
            ? 'foreign-hidden-ocr'
            : 'native-text',
        extractedTextLength,
        hasHiddenTextOperators,
        hasVisibleTextOperators,
    };
}

export function shouldOcrClassifiedPage(
    classification: TOcrPageTextClassification,
    policy: TOcrTextSupersessionPolicy,
) {
    if (classification === 'no-text') {
        return true;
    }
    if (classification === 'evb-current-generation') {
        return policy === 'replace-evb' || policy === 'replace-all';
    }
    if (classification === 'foreign-hidden-ocr') {
        // A hidden-only text layer is not a usable selectable layer in the
        // viewer. Treat it like missing text so the default OCR flows can
        // repair documents that were given an unusable foreign OCR layer.
        return true;
    }
    return false;
}
