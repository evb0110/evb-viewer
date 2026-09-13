const WORD_PATTERN = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}]|[-./](?=[\p{L}\p{M}\p{N}]))*/gu;

export const FAITHFUL_NORMALIZATION = 'NFC';
export const COMPATIBILITY_NORMALIZATION = 'NFKC + lowercase(und) + Unicode dash folding';
export const OCR_WHITESPACE_POLICY = 'collapse Unicode whitespace runs to ASCII spaces and trim the ends';
export const OCR_WORD_TOKENIZER = 'letters, marks and numbers, with internal hyphen, slash or dot separators';
const MARK_PATTERN = /\p{M}/gu;

function normalizeWhitespace(value) {
    return value
        .replace(/\s+/gu, ' ')
        .trim();
}

/** Primary score normalization. It preserves case, marks, punctuation and numeral forms. */
export function normalizeFaithfulOcrText(value) {
    return normalizeWhitespace(value.normalize('NFC'));
}

/** Compatibility score normalization retained for existing benchmark consumers. */
export function normalizeCompatibilityOcrText(value) {
    return normalizeWhitespace(value
        .normalize('NFKC')
        .toLocaleLowerCase('und')
        .replace(/[\u2010-\u2015\u2212]/gu, '-'));
}

export function tokenizeOcrWords(value) {
    return normalizeCompatibilityOcrText(value).match(WORD_PATTERN) ?? [];
}

export function tokenizeFaithfulOcrWords(value) {
    return normalizeFaithfulOcrText(value).match(WORD_PATTERN) ?? [];
}

export function editDistance(expected, actual) {
    if (expected.length > actual.length) {
        return editDistance(actual, expected);
    }
    let previous = Array.from({length: expected.length + 1}, (_, index) => index);
    for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
        const current = [actualIndex + 1];
        for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
            current.push(Math.min(
                current[expectedIndex] + 1,
                previous[expectedIndex + 1] + 1,
                previous[expectedIndex] + (expected[expectedIndex] === actual[actualIndex] ? 0 : 1),
            ));
        }
        previous = current;
    }
    return previous[expected.length];
}

export function measureOcrQuality(expected, actual) {
    const faithful = measureScore(
        expected,
        actual,
        normalizeFaithfulOcrText,
        tokenizeFaithfulOcrWords,
        FAITHFUL_NORMALIZATION,
    );
    const compatibility = measureScore(
        expected,
        actual,
        normalizeCompatibilityOcrText,
        tokenizeOcrWords,
        COMPATIBILITY_NORMALIZATION,
    );
    return {
        faithful,
        compatibility,
    };
}

/** Report combining-mark preservation separately from the primary CER. */
export function measureUnicodeMarks(expected, actual) {
    const expectedMarks = expected.normalize('NFC').match(MARK_PATTERN) ?? [];
    const actualMarks = actual.normalize('NFC').match(MARK_PATTERN) ?? [];
    return {
        expected: expectedMarks.length,
        actual: actualMarks.length,
        missing: Math.max(0, expectedMarks.length - actualMarks.length),
        extra: Math.max(0, actualMarks.length - expectedMarks.length),
        retainedRatio: expectedMarks.length === 0
            ? (actualMarks.length === 0 ? 1 : 0)
            : Math.min(expectedMarks.length, actualMarks.length) / expectedMarks.length,
    };
}

function measureScore(expected, actual, normalize, tokenize, normalization) {
    const normalizedExpected = normalize(expected);
    const normalizedActual = normalize(actual);
    const expectedCharacters = Array.from(normalizedExpected);
    const actualCharacters = Array.from(normalizedActual);
    const expectedWords = tokenize(normalizedExpected);
    const actualWords = tokenize(normalizedActual);
    return {
        cer: editDistance(expectedCharacters, actualCharacters)
            / Math.max(1, expectedCharacters.length),
        wer: editDistance(expectedWords, actualWords)
            / Math.max(1, expectedWords.length),
        normalizedExpected,
        normalizedActual,
        expectedScalarCount: expectedCharacters.length,
        actualScalarCount: actualCharacters.length,
        expectedWordCount: expectedWords.length,
        actualWordCount: actualWords.length,
        denominator: {
            cer: Math.max(1, expectedCharacters.length),
            wer: Math.max(1, expectedWords.length),
        },
        referenceEmpty: expectedCharacters.length === 0,
        insertedTextWithEmptyReference: expectedCharacters.length === 0 && actualCharacters.length > 0,
        normalization,
        tokenizer: OCR_WORD_TOKENIZER,
        whitespace: OCR_WHITESPACE_POLICY,
    };
}

export function retainsFaithfulCriticalToken(actual, token) {
    const expectedTokens = tokenizeFaithfulOcrWords(token);
    if (expectedTokens.length !== 1) {
        return false;
    }
    return tokenizeFaithfulOcrWords(actual).includes(expectedTokens[0]);
}

/** Legacy critical-token check. It intentionally uses compatibility normalization. */
export function retainsCriticalToken(actual, token) {
    const expectedTokens = tokenizeOcrWords(token);
    if (expectedTokens.length !== 1) {
        return false;
    }
    return tokenizeOcrWords(actual).includes(expectedTokens[0]);
}
