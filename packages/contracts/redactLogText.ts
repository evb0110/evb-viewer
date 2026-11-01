const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s]+/giu;
const DATA_URL_PATTERN = /\bdata:[^\s]+/giu;
const SECRET_ASSIGNMENT_PATTERN = /(?<![\w-])["']?(?:x[-_])?(?:authorization|auth[-_]?token|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key|password|passwd|pwd|secret|token)\b["']?\s*[:=]\s*/giu;
interface IRedaction {
    pattern: RegExp;
    replacement: (match: string) => string;
}

// A quoted path (JSON log data, quoted messages) runs to its closing quote,
// spaces and JSON-escaped backslashes included. An unquoted one runs to a
// document extension on its line, or else to the next whitespace.
const QUOTED_PATH_START = String.raw`(?<=(["']))`;
const QUOTED_PATH_TAIL = String.raw`(?:\\.|(?!\1)[^\\\n])*`;
const DOCUMENT_PATH_TAIL = String.raw`[^\n"']*?\.(?:pdf|djvu?|png|jpe?g|tiff?|docx)\b`;

function pathRedactions(prefix: string, plainTail: string, replacement: IRedaction['replacement']): IRedaction[] {
    // An already redacted path stays as it is, so redacting again changes nothing.
    const start = `${prefix}(?!\\[redacted\\])`;
    return [
        `${QUOTED_PATH_START}${start}${QUOTED_PATH_TAIL}`,
        `${start}${DOCUMENT_PATH_TAIL}`,
        `${start}${plainTail}`,
    ].map(source => ({
        pattern: new RegExp(source, 'giu'),
        replacement,
    }));
}

const HOME_PATH_REDACTION_PATTERNS: readonly IRedaction[] = [
    ...pathRedactions(String.raw`\/Users\/`, String.raw`[^/\s"',)]+(?:\/[^\s"',)]+)*`, () => '/Users/[redacted]'),
    ...pathRedactions(
        String.raw`[A-Za-z]:(?:\\\\|\\)Users(?:\\\\|\\)`,
        String.raw`[^\\\s"',)]+(?:\\[^\s"',)]+)*`,
        match => (match.includes('\\\\') ? 'C:\\\\Users\\\\[redacted]' : 'C:\\Users\\[redacted]'),
    ),
];

const NON_URL_REDACTION_PATTERNS: readonly IRedaction[] = [
    {
        pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gu,
        replacement: () => 'Bearer [redacted]',
    },
    ...pathRedactions(String.raw`file:\/\/`, String.raw`[^\s"',)]+`, () => 'file://[redacted]'),
    // Browser workspace documents: keep the opaque id, hide the file name.
    ...pathRedactions(
        String.raw`browser:\/\/documents\/`,
        String.raw`[^/\s"',)]+\/[^\s"',)]+`,
        match => match.replace(/^(browser:\/\/documents\/[^/]+)\/.*$/su, '$1/[redacted]'),
    ),
];

function findQuotedValueEnd(value: string, start: number) {
    const quote = value[start];
    for (let index = start + 1; index < value.length; index += 1) {
        if (value[index] === '\\') {
            index += 1;
            continue;
        }
        if (value[index] === quote) {
            return index + 1;
        }
    }
    return value.length;
}

function findCompositeValueEnd(value: string, start: number) {
    const stack: string[] = [];
    for (let index = start; index < value.length; index += 1) {
        const character = value[index];
        if (character === '"' || character === '\'') {
            index = findQuotedValueEnd(value, index) - 1;
            continue;
        }
        if (character === '{' || character === '[') {
            stack.push(character);
            continue;
        }
        if (character === '}' || character === ']') {
            const expectedOpening = character === '}' ? '{' : '[';
            if (stack.at(-1) !== expectedOpening) {
                return index;
            }
            stack.pop();
            if (stack.length === 0) {
                return index + 1;
            }
        }
    }
    return value.length;
}

function findSecretValueEnd(value: string, start: number) {
    if (value.startsWith('"[redacted-secret]"', start)) {
        return start + '"[redacted-secret]"'.length;
    }
    const firstCharacter = value[start];
    if (firstCharacter === '"' || firstCharacter === '\'') {
        return findQuotedValueEnd(value, start);
    }
    if (firstCharacter === '{' || firstCharacter === '[') {
        return findCompositeValueEnd(value, start);
    }

    const remainder = value.slice(start);
    const authorizationSchemeMatch = remainder.match(/^(?:Basic|Bearer)\s+[^\s,}\]]+/iu);
    if (authorizationSchemeMatch) {
        return start + authorizationSchemeMatch[0].length;
    }
    const unquotedMatch = remainder.match(/^[^\s,"'}\]]+/u);
    return start + (unquotedMatch?.[0].length ?? 0);
}

function redactNamedSecrets(value: string) {
    let result = '';
    let cursor = 0;
    SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;

    for (const match of value.matchAll(SECRET_ASSIGNMENT_PATTERN)) {
        if (match.index < cursor) {
            continue;
        }
        const valueStart = match.index + match[0].length;
        const valueEnd = findSecretValueEnd(value, valueStart);
        result += value.slice(cursor, valueStart);
        result += '"[redacted-secret]"';
        cursor = valueEnd;
    }

    result += value.slice(cursor);
    return result;
}

function redactHomePaths(value: string) {
    let redacted = value;
    for (const {
        pattern,
        replacement,
    } of HOME_PATH_REDACTION_PATTERNS) {
        redacted = redacted.replace(pattern, replacement);
    }
    return redacted;
}

function redactNonOpaqueText(value: string) {
    let redacted = redactNamedSecrets(value);
    for (const {
        pattern,
        replacement,
    } of NON_URL_REDACTION_PATTERNS) {
        redacted = redacted.replace(pattern, replacement);
    }
    return redactHomePaths(redacted);
}

function redactUrlQuery(query: string) {
    if (query.length === 0) {
        return query;
    }

    return query
        .split('&')
        .map((parameter) => {
            if (parameter.length === 0) {
                return parameter;
            }
            const separatorIndex = parameter.indexOf('=');
            if (separatorIndex === -1) {
                return `${parameter}=[redacted]`;
            }
            return `${parameter.slice(0, separatorIndex)}=[redacted]`;
        })
        .join('&');
}

function splitRedactableSpan(value: string, precedingCharacter: string | undefined) {
    let spanEnd = value.length;
    let foundContextualQuote = false;
    const pairedDelimiters = [
        [
            '(',
            ')',
        ],
        [
            '[',
            ']',
        ],
        [
            '{',
            '}',
        ],
        [
            '<',
            '>',
        ],
    ] as const;

    if (
        precedingCharacter === '"'
        || precedingCharacter === '\''
        || precedingCharacter === '`'
    ) {
        for (let index = 0; index < spanEnd; index += 1) {
            if (value[index] !== precedingCharacter || value[index - 1] === '\\') {
                continue;
            }
            const followingCharacter = value[index + 1];
            if (
                followingCharacter === undefined
                || /[\s,;.!?)}\]]/u.test(followingCharacter)
            ) {
                spanEnd = index;
                foundContextualQuote = true;
                break;
            }
        }
    }

    if (!foundContextualQuote) {
        while (spanEnd > 0 && /[,;.!]/u.test(value[spanEnd - 1] ?? '')) {
            spanEnd -= 1;
        }
    }
    const wrapper = pairedDelimiters.find(pair => pair[0] === precedingCharacter);
    const removedWrapper = wrapper?.[1] === value[spanEnd - 1];
    if (removedWrapper) {
        spanEnd -= 1;
    }

    return {
        redactedSpan: value.slice(0, spanEnd),
        trailingText: value.slice(spanEnd),
    };
}

function redactNonUrlText(value: string) {
    let result = '';
    let cursor = 0;

    for (const match of value.matchAll(DATA_URL_PATTERN)) {
        const index = match.index;
        const {
            redactedSpan,
            trailingText,
        } = splitRedactableSpan(match[0], value[index - 1]);
        result += redactNonOpaqueText(value.slice(cursor, index));
        result += redactedSpan.length > 0 ? 'data:[redacted]' : '';
        result += redactNonOpaqueText(trailingText);
        cursor = index + match[0].length;
    }

    result += redactNonOpaqueText(value.slice(cursor));
    return result;
}

function redactHttpUrl(value: string) {
    const authorityStart = value.indexOf('://') + 3;
    const authoritySuffix = value.slice(authorityStart);
    const authorityEndOffset = authoritySuffix.search(/[/?#]/u);
    const authorityEnd = authorityEndOffset === -1
        ? value.length
        : authorityStart + authorityEndOffset;
    const authority = value.slice(authorityStart, authorityEnd);
    const userInfoEnd = authority.lastIndexOf('@');
    const redactedAuthority = userInfoEnd === -1
        ? authority
        : `[redacted]@${authority.slice(userInfoEnd + 1)}`;
    const suffix = value.slice(authorityEnd);
    const fragmentStart = suffix.indexOf('#');
    const suffixWithoutFragment = fragmentStart === -1
        ? suffix
        : suffix.slice(0, fragmentStart);
    const queryStart = suffixWithoutFragment.indexOf('?');
    const path = queryStart === -1
        ? suffixWithoutFragment
        : suffixWithoutFragment.slice(0, queryStart);
    const query = queryStart === -1
        ? ''
        : `?${redactUrlQuery(suffixWithoutFragment.slice(queryStart + 1))}`;
    const fragment = fragmentStart === -1 ? '' : '#[redacted]';

    return `${value.slice(0, authorityStart)}${redactedAuthority}${redactHomePaths(path)}${query}${fragment}`;
}

/**
 * Redacts secret-bearing log text without discarding useful URL diagnostics.
 * HTTP URL spans are handled separately so the generic token redaction does
 * not erase query keys. Reapplying the function produces the same text.
 */
export function redactLogText(value: string) {
    let result = '';
    let cursor = 0;

    for (const match of value.matchAll(HTTP_URL_PATTERN)) {
        const index = match.index;
        const {
            redactedSpan,
            trailingText,
        } = splitRedactableSpan(match[0], value[index - 1]);
        result += redactNonUrlText(value.slice(cursor, index));
        result += redactHttpUrl(redactedSpan);
        result += redactNonUrlText(trailingText);
        cursor = index + match[0].length;
    }

    result += redactNonUrlText(value.slice(cursor));
    return result;
}
