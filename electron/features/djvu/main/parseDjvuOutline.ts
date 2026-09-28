import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {
    requirePageIndex,
    type TPageIndex,
} from '@contracts/pageNumbers';
import {
    DJVU_OUTLINE_MAX_DEPTH,
    DJVU_OUTLINE_MAX_NODES,
    DJVU_OUTLINE_MAX_TITLE_CHARS,
} from '@contracts/djvuResourceLimits';

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
export function parseDjvuOutline(sexpression: string, pageComponents?: ReadonlyMap<string, number>): IPdfBookmarkEntry[] {
    if (!sexpression || sexpression.trim().length === 0) {
        return [];
    }

    const tokens = tokenize(sexpression);
    const ast = parseTokens(tokens);

    if (!Array.isArray(ast) || ast.length === 0) {
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

    return root.slice(1).flatMap((node) => {
        const bookmark = parseBookmarkNode(node, pageComponents);
        return bookmark ? [bookmark] : [];
    });
}

type TSexpToken = string | TSexpToken[];

function isSexpWhitespace(ch: string) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isSexpParen(ch: string) {
    return ch === '(' || ch === ')';
}

function readQuotedToken(input: string, startIndex: number): {
    token: string;
    nextIndex: number;
} {
    let str = '';
    let i = startIndex + 1;
    while (i < input.length) {
        const c = input[i]!;
        if (c === '\\' && i + 1 < input.length) {
            str += input[i + 1];
            i += 2;
            continue;
        }
        if (c === '"') {
            return {
                token: `"${str}"`,
                nextIndex: i + 1,
            };
        }
        str += c;
        i++;
    }
    return {
        token: `"${str}"`,
        nextIndex: i,
    };
}

function readAtomToken(input: string, startIndex: number): {
    token: string;
    nextIndex: number;
} {
    let atom = '';
    let i = startIndex;
    while (i < input.length) {
        const ch = input[i]!;
        if (isSexpWhitespace(ch) || isSexpParen(ch)) {
            break;
        }
        atom += ch;
        i++;
    }
    return {
        token: atom,
        nextIndex: i,
    };
}

function tokenize(input: string): string[] {
    const tokens: string[] = [];
    let i = 0;

    while (i < input.length) {
        const ch = input[i]!;

        if (isSexpWhitespace(ch)) {
            i++;
            continue;
        }

        if (isSexpParen(ch)) {
            tokens.push(ch);
            i++;
            continue;
        }

        if (ch === '"') {
            const quoted = readQuotedToken(input, i);
            tokens.push(quoted.token);
            i = quoted.nextIndex;
            continue;
        }

        const atom = readAtomToken(input, i);
        tokens.push(atom.token);
        i = atom.nextIndex;
    }

    return tokens;
}

function parseTokens(tokens: string[]): TSexpToken[] {
    const result: TSexpToken[] = [];
    const stack: TSexpToken[][] = [result];
    let atomCount = 0;
    let listCount = 0;
    for (const token of tokens) {
        if (token === '(') {
            if (stack.length > DJVU_OUTLINE_MAX_DEPTH) {
                throw new Error(`DjVu outline nesting is capped at ${DJVU_OUTLINE_MAX_DEPTH}`);
            }
            listCount += 1;
            if (listCount > DJVU_OUTLINE_MAX_NODES) {
                throw new Error('DjVu outline node count exceeds the supported limit');
            }
            const list: TSexpToken[] = [];
            stack.at(-1)!.push(list);
            stack.push(list);
            continue;
        }
        if (token === ')') {
            if (stack.length > 1) stack.pop();
            continue;
        }
        atomCount += 1;
        if (atomCount > DJVU_OUTLINE_MAX_NODES * 3) {
            throw new Error('DjVu outline token count exceeds the supported limit');
        }
        stack.at(-1)!.push(token.startsWith('"') && token.endsWith('"')
            ? token.slice(1, -1)
            : token);
    }

    return result;
}

function parseBookmarkNode(node: TSexpToken, pageComponents?: ReadonlyMap<string, number>): IPdfBookmarkEntry | null {
    if (!Array.isArray(node) || node.length < 2) {
        return null;
    }

    const title = typeof node[0] === 'string' ? node[0] : '';
    const dest = typeof node[1] === 'string' ? node[1] : '';

    // Parse page reference: "#<component id>" from the bundle directory, else "#N" (1-based)
    let pageIndex: TPageIndex | null = null;
    if (dest.startsWith('#')) {
        const componentIndex = pageComponents?.get(dest.slice(1));
        if (Number.isSafeInteger(componentIndex) && componentIndex! >= 0) {
            pageIndex = requirePageIndex(componentIndex!);
        } else {
            const pageNum = parseInt(dest.slice(1), 10);
            if (Number.isFinite(pageNum) && pageNum >= 1) {
                pageIndex = requirePageIndex(pageNum - 1);
            }
        }
    }

    // Remaining elements are child bookmarks
    const children = node.slice(2).flatMap((childNode) => {
        const bookmark = parseBookmarkNode(childNode, pageComponents);
        return bookmark ? [bookmark] : [];
    });

    return {
        title: title.slice(0, DJVU_OUTLINE_MAX_TITLE_CHARS),
        pageIndex,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: children,
    };
}
