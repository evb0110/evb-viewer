type TAssistantCodeTokenKind = 'plain' | 'comment' | 'keyword' | 'literal' | 'number' | 'operator';

export interface IAssistantCodeToken {
    kind: TAssistantCodeTokenKind;
    text: string;
}

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
    bash: 'shell',
    cjs: 'javascript',
    html: 'markup',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'shell',
    ts: 'typescript',
    tsx: 'typescript',
    vue: 'markup',
    xml: 'markup',
    yml: 'yaml',
};

const KEYWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
    javascript: new Set('async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch throw try typeof undefined var void while with yield true false null'.split(' ')),
    typescript: new Set('abstract any as asserts async await bigint boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of override package private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield'.split(' ')),
    python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(' ')),
    rust: new Set('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' ')),
    shell: new Set('case do done elif else esac export fi for function if in local readonly return set then unset while'.split(' ')),
    ruby: new Set('alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'.split(' ')),
    css: new Set('and important not only or'.split(' ')),
    json: new Set([
        'true',
        'false',
        'null',
    ]),
    yaml: new Set([
        'true',
        'false',
        'null',
        'yes',
        'no',
    ]),
};

function normalizeLanguage(language: string | null) {
    const normalized = language?.trim().toLowerCase() ?? '';
    return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function appendToken(tokens: IAssistantCodeToken[], kind: TAssistantCodeTokenKind, text: string) {
    if (!text) {
        return;
    }
    const previous = tokens.at(-1);
    if (previous?.kind === kind) {
        previous.text += text;
        return;
    }
    tokens.push({
        kind,
        text,
    });
}

function matchAt(pattern: RegExp, code: string, cursor: number) {
    const match = pattern.exec(code.slice(cursor));
    return match?.index === 0 ? match[0] : null;
}

export function highlightAssistantCode(code: string, language: string | null): IAssistantCodeToken[] {
    const normalizedLanguage = normalizeLanguage(language);
    const keywords = KEYWORDS[normalizedLanguage] ?? new Set<string>();
    const hashComments = [
        'python',
        'ruby',
        'shell',
        'yaml',
    ].includes(normalizedLanguage);
    const markup = normalizedLanguage === 'markup';
    const tokens: IAssistantCodeToken[] = [];
    let cursor = 0;

    while (cursor < code.length) {
        const remainder = code.slice(cursor);
        const comment = markup
            ? matchAt(/^<!--[\s\S]*?-->/u, code, cursor)
            : matchAt(/^\/\*[\s\S]*?\*\//u, code, cursor)
                ?? matchAt(/^\/\/[^\n]*/u, code, cursor)
                ?? (hashComments ? matchAt(/^#[^\n]*/u, code, cursor) : null);
        if (comment) {
            appendToken(tokens, 'comment', comment);
            cursor += comment.length;
            continue;
        }

        const literal = matchAt(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/u, code, cursor);
        if (literal) {
            appendToken(tokens, 'literal', literal);
            cursor += literal.length;
            continue;
        }

        const number = matchAt(/^(?:0[xob][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/iu, code, cursor);
        if (number) {
            appendToken(tokens, 'number', number);
            cursor += number.length;
            continue;
        }

        const word = matchAt(/^[\p{L}_$][\p{L}\p{N}_$-]*/u, code, cursor);
        if (word) {
            appendToken(tokens, keywords.has(word) ? 'keyword' : 'plain', word);
            cursor += word.length;
            continue;
        }

        const operator = matchAt(/^(?:=>|===?|!==?|\?\?|\?\.|\+\+|--|&&|\|\||<<|>>|\*\*|[{}()[\].,:;+*/%&|^~!?<>=-])/u, code, cursor);
        if (operator) {
            appendToken(tokens, 'operator', operator);
            cursor += operator.length;
            continue;
        }

        appendToken(tokens, 'plain', remainder[0] ?? '');
        cursor += 1;
    }

    return tokens;
}
