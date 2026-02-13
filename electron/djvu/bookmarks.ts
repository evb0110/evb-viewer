import type { IPdfBookmarkEntry } from '@app/types/pdf';

/**
 * Parse DjVu S-expression outline into bookmark entries.
 *
 * DjVu outline format (from djvused `print-outline`):
 *   (bookmarks
 *     ("Chapter 1" "#1"
 *       ("Section 1.1" "#5"))
 *     ("Chapter 2" "#20"))
 *
 * Where "#N" is a 1-based page number reference.
 * This mirrors Okular's `readBookmarks()` in kdjvu.cpp which recursively
 * traverses (title destination children...) tuples from ddjvu_miniexp_t.
 */
export function parseDjvuOutline(sexpression: string): IPdfBookmarkEntry[] {
    if (!sexpression || sexpression.trim().length === 0) {
        return [];
    }

    const tokens = tokenize(sexpression);
    const ast = parseTokens(tokens);

    if (!ast || !Array.isArray(ast) || ast.length === 0) {
        return [];
    }

    // The root should be (bookmarks ...)
    const root = ast[0];
    if (!Array.isArray(root)) {
        return [];
    }

    // First element is "bookmarks", rest are entries
    if (root[0] !== 'bookmarks') {
        return [];
    }

    return root.slice(1).map(parseBookmarkNode).filter((b): b is IPdfBookmarkEntry => b !== null);
}

type TSexpToken = string | TSexpToken[];

function tokenize(input: string): string[] {
    const tokens: string[] = [];
    let i = 0;

    while (i < input.length) {
        const ch = input[i]!;

        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            i++;
            continue;
        }

        if (ch === '(' || ch === ')') {
            tokens.push(ch);
            i++;
            continue;
        }

        if (ch === '"') {
            let str = '';
            i++; // skip opening quote
            while (i < input.length) {
                const c = input[i]!;
                if (c === '\\' && i + 1 < input.length) {
                    str += input[i + 1];
                    i += 2;
                    continue;
                }
                if (c === '"') {
                    i++; // skip closing quote
                    break;
                }
                str += c;
                i++;
            }
            tokens.push(`"${str}"`);
            continue;
        }

        // Atom (unquoted symbol like 'bookmarks')
        let atom = '';
        while (i < input.length && input[i] !== ' ' && input[i] !== '\t' &&
               input[i] !== '\n' && input[i] !== '\r' &&
               input[i] !== '(' && input[i] !== ')') {
            atom += input[i];
            i++;
        }
        tokens.push(atom);
    }

    return tokens;
}

function parseTokens(tokens: string[]): TSexpToken[] {
    const result: TSexpToken[] = [];
    let pos = 0;

    function parseList(): TSexpToken[] {
        const items: TSexpToken[] = [];
        pos++; // skip '('

        while (pos < tokens.length) {
            const token = tokens[pos]!;
            if (token === ')') {
                pos++;
                return items;
            }
            if (token === '(') {
                items.push(parseList());
            } else {
                // Strip quotes from strings
                if (token.startsWith('"') && token.endsWith('"')) {
                    items.push(token.slice(1, -1));
                } else {
                    items.push(token);
                }
                pos++;
            }
        }

        return items;
    }

    while (pos < tokens.length) {
        const token = tokens[pos]!;
        if (token === '(') {
            result.push(parseList());
        } else {
            if (token.startsWith('"') && token.endsWith('"')) {
                result.push(token.slice(1, -1));
            } else {
                result.push(token);
            }
            pos++;
        }
    }

    return result;
}

function parseBookmarkNode(node: TSexpToken): IPdfBookmarkEntry | null {
    if (!Array.isArray(node) || node.length < 2) {
        return null;
    }

    const title = typeof node[0] === 'string' ? node[0] : '';
    const dest = typeof node[1] === 'string' ? node[1] : '';

    // Parse page reference: "#N" where N is 1-based
    let pageIndex: number | null = null;
    if (dest.startsWith('#')) {
        const pageNum = parseInt(dest.slice(1), 10);
        if (Number.isFinite(pageNum) && pageNum >= 1) {
            pageIndex = pageNum - 1; // Convert to 0-based
        }
    }

    // Remaining elements are child bookmarks
    const children = node.slice(2)
        .map(parseBookmarkNode)
        .filter((b): b is IPdfBookmarkEntry => b !== null);

    return {
        title,
        pageIndex,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: children,
    };
}
