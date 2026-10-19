import type {
    TOcrPageTextClassification,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import type {IPdfOcrPageTextVisibility} from '@contracts/pdfOcrTextVisibility';

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
    lat: ['latin'],
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
function isLikelyUsableOcrText(
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

export function classifyOcrPageText(input: {
    extractedText: string;
    visibility?: IPdfOcrPageTextVisibility;
    languages?: readonly string[];
}): TOcrPageTextClassification {
    if (input.visibility?.evbOcrLayer) {
        return isLikelyUsableOcrText(input.extractedText, input.languages)
            ? 'evb-current-generation'
            : 'foreign-hidden-ocr';
    }
    if (input.extractedText.trim().length === 0) {
        return 'no-text';
    }
    // Only hidden text the writer removes, and nothing else, is a foreign layer
    // OCR may replace; anything painted or unread is the document's own text.
    const visibility = input.visibility;
    return visibility?.hiddenText && !visibility.paintedText && visibility.uncertain === null
        ? 'foreign-hidden-ocr'
        : 'native-text';
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
