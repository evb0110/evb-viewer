interface IAssistantMessageTextSegment {
    kind: 'text';
    text: string;
}

interface IAssistantMessageInlineCodeSegment {
    kind: 'code';
    text: string;
}

interface IAssistantMessageStrongSegment {
    kind: 'strong';
    text: string;
}

interface IAssistantMessageEmphasisSegment {
    kind: 'emphasis';
    text: string;
}

interface IAssistantMessageLinkSegment {
    kind: 'link';
    text: string;
    href: string;
}

export type TAssistantMessageSegment =
    | IAssistantMessageTextSegment
    | IAssistantMessageInlineCodeSegment
    | IAssistantMessageStrongSegment
    | IAssistantMessageEmphasisSegment
    | IAssistantMessageLinkSegment;

interface IAssistantMessageTextBlock {
    kind: 'text';
    segments: TAssistantMessageSegment[];
}

interface IAssistantMessageHeadingBlock {
    kind: 'heading';
    level: 1 | 2 | 3 | 4 | 5 | 6;
    segments: TAssistantMessageSegment[];
}

interface IAssistantMessageListBlock {
    kind: 'list';
    ordered: boolean;
    items: TAssistantMessageSegment[][];
}

interface IAssistantMessageBlockquoteBlock {
    kind: 'blockquote';
    segments: TAssistantMessageSegment[];
}

interface IAssistantMessageCodeBlock {
    kind: 'code';
    language: string | null;
    code: string;
}

interface IAssistantMessageRuleBlock { kind: 'rule' }

interface IAssistantMessageTableBlock {
    kind: 'table';
    rows: TAssistantMessageSegment[][][];
}

type TAssistantMessageBlock =
    | IAssistantMessageTextBlock
    | IAssistantMessageHeadingBlock
    | IAssistantMessageListBlock
    | IAssistantMessageBlockquoteBlock
    | IAssistantMessageCodeBlock
    | IAssistantMessageTableBlock
    | IAssistantMessageRuleBlock;

const FENCE_PATTERN = /^\s*```([^\s`]*)?\s*$/u;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/u;
const BLOCKQUOTE_PATTERN = /^\s{0,3}>\s?(.*)$/u;
const UNORDERED_LIST_PATTERN = /^\s{0,3}[-*+]\s+(.+)$/u;
const ORDERED_LIST_PATTERN = /^\s{0,3}\d+[.)]\s+(.+)$/u;
const HORIZONTAL_RULE_PATTERN = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const TABLE_SEPARATOR_PATTERN = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/u;

function parseTableRow(line: string) {
    return line.trim().replace(/^\||\|$/gu, '').split('|').map(cell => parseInlineSegments(cell.trim()));
}

function appendTextSegment(segments: TAssistantMessageSegment[], text: string) {
    if (text.length === 0) {
        return;
    }
    segments.push({
        kind: 'text',
        text,
    });
}

function isAlphaNumeric(value: string | undefined) {
    return Boolean(value && /[\p{L}\p{N}]/u.test(value));
}

function isSafeLinkHref(href: string) {
    const normalized = href.trim();
    if (!normalized) {
        return false;
    }
    if (
        normalized.startsWith('#')
        || normalized.startsWith('/')
        || normalized.startsWith('./')
        || normalized.startsWith('../')
    ) {
        return true;
    }

    try {
        const url = new URL(normalized);
        return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
    } catch {
        return false;
    }
}

function findClosingMarker(text: string, marker: string, start: number) {
    const end = text.indexOf(marker, start + marker.length);
    if (end < 0 || end === start + marker.length) {
        return null;
    }
    return end;
}

function canUseSingleEmphasisMarker(text: string, index: number, marker: '*' | '_') {
    const previous = text[index - 1];
    const next = text[index + 1];
    if (!next || /\s/u.test(next)) {
        return false;
    }
    if (marker === '_' && isAlphaNumeric(previous)) {
        return false;
    }
    return true;
}

function findClosingSingleEmphasisMarker(text: string, marker: '*' | '_', start: number) {
    let cursor = start + 1;
    while (cursor < text.length) {
        const index = text.indexOf(marker, cursor);
        if (index < 0) {
            return null;
        }

        const previous = text[index - 1];
        const next = text[index + 1];
        if (previous && !/\s/u.test(previous) && !(marker === '_' && isAlphaNumeric(next))) {
            return index;
        }
        cursor = index + 1;
    }
    return null;
}

function parseInlineSegments(text: string) {
    const segments: TAssistantMessageSegment[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        let matched = false;

        for (let index = cursor; index < text.length; index += 1) {
            const char = text[index];

            if (char === '`') {
                const end = findClosingMarker(text, '`', index);
                if (end == null) {
                    continue;
                }
                appendTextSegment(segments, text.slice(cursor, index));
                segments.push({
                    kind: 'code',
                    text: text.slice(index + 1, end),
                });
                cursor = end + 1;
                matched = true;
                break;
            }

            if (char === '[') {
                const labelEnd = text.indexOf('](', index + 1);
                if (labelEnd < 0) {
                    continue;
                }
                const hrefEnd = text.indexOf(')', labelEnd + 2);
                if (hrefEnd < 0) {
                    continue;
                }
                const label = text.slice(index + 1, labelEnd);
                const href = text.slice(labelEnd + 2, hrefEnd).trim();
                if (!label || !isSafeLinkHref(href)) {
                    continue;
                }
                appendTextSegment(segments, text.slice(cursor, index));
                segments.push({
                    kind: 'link',
                    text: label,
                    href,
                });
                cursor = hrefEnd + 1;
                matched = true;
                break;
            }

            const pair = text.slice(index, index + 2);
            if (pair === '**' || pair === '__') {
                const end = findClosingMarker(text, pair, index);
                if (end == null) {
                    continue;
                }
                appendTextSegment(segments, text.slice(cursor, index));
                segments.push({
                    kind: 'strong',
                    text: text.slice(index + 2, end),
                });
                cursor = end + 2;
                matched = true;
                break;
            }

            if ((char === '*' || char === '_') && canUseSingleEmphasisMarker(text, index, char)) {
                const end = findClosingSingleEmphasisMarker(text, char, index);
                if (end == null) {
                    continue;
                }
                appendTextSegment(segments, text.slice(cursor, index));
                segments.push({
                    kind: 'emphasis',
                    text: text.slice(index + 1, end),
                });
                cursor = end + 1;
                matched = true;
                break;
            }
        }

        if (!matched) {
            appendTextSegment(segments, text.slice(cursor));
            break;
        }
    }

    return segments;
}

function pushTextBlock(blocks: TAssistantMessageBlock[], lines: string[]) {
    if (lines.length === 0) {
        return;
    }

    blocks.push({
        kind: 'text',
        segments: parseInlineSegments(lines.join('\n')),
    });
    lines.length = 0;
}

function normalizeFenceLanguage(language: string | undefined) {
    const normalized = language?.trim();
    if (!normalized) {
        return null;
    }
    return normalized;
}

function matchListItem(line: string) {
    const unordered = line.match(UNORDERED_LIST_PATTERN);
    if (unordered?.[1]) {
        return {
            ordered: false,
            text: unordered[1],
        };
    }

    const ordered = line.match(ORDERED_LIST_PATTERN);
    if (ordered?.[1]) {
        return {
            ordered: true,
            text: ordered[1],
        };
    }

    return null;
}

export function formatAssistantMessage(text: string) {
    const blocks: TAssistantMessageBlock[] = [];
    const textLines: string[] = [];
    let codeLanguage: string | null = null;
    let codeLines: string[] | null = null;
    const lines = text.replace(/\r\n?/gu, '\n').split('\n');

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';

        const fenceMatch = line.match(FENCE_PATTERN);
        if (codeLines) {
            if (fenceMatch) {
                blocks.push({
                    kind: 'code',
                    language: codeLanguage,
                    code: codeLines.join('\n'),
                });
                codeLanguage = null;
                codeLines = null;
                continue;
            }
            codeLines.push(line);
            continue;
        }

        if (fenceMatch) {
            pushTextBlock(blocks, textLines);
            codeLanguage = normalizeFenceLanguage(fenceMatch[1]);
            codeLines = [];
            continue;
        }

        if (line.includes('|') && TABLE_SEPARATOR_PATTERN.test(lines[index + 1] ?? '')) {
            pushTextBlock(blocks, textLines);
            const rows = [parseTableRow(line)];
            index += 2;
            while (index < lines.length && (lines[index] ?? '').includes('|')) {
                rows.push(parseTableRow(lines[index] ?? ''));
                index += 1;
            }
            index -= 1;
            blocks.push({
                kind: 'table',
                rows,
            });
            continue;
        }

        if (HORIZONTAL_RULE_PATTERN.test(line)) {
            pushTextBlock(blocks, textLines);
            blocks.push({ kind: 'rule' });
            continue;
        }

        const headingMatch = line.match(HEADING_PATTERN);
        if (headingMatch?.[1] && headingMatch[2]?.trim()) {
            pushTextBlock(blocks, textLines);
            blocks.push({
                kind: 'heading',
                level: headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6,
                segments: parseInlineSegments(headingMatch[2].trim()),
            });
            continue;
        }

        const blockquoteMatch = line.match(BLOCKQUOTE_PATTERN);
        if (blockquoteMatch) {
            pushTextBlock(blocks, textLines);
            const quoteLines: string[] = [];
            while (index < lines.length) {
                const match = (lines[index] ?? '').match(BLOCKQUOTE_PATTERN);
                if (!match) {
                    break;
                }
                quoteLines.push(match[1] ?? '');
                index += 1;
            }
            index -= 1;
            blocks.push({
                kind: 'blockquote',
                segments: parseInlineSegments(quoteLines.join('\n')),
            });
            continue;
        }

        const listItem = matchListItem(line);
        if (listItem) {
            pushTextBlock(blocks, textLines);
            const items: TAssistantMessageSegment[][] = [];
            const ordered = listItem.ordered;
            while (index < lines.length) {
                const item = matchListItem(lines[index] ?? '');
                if (!item || item.ordered !== ordered) {
                    break;
                }
                items.push(parseInlineSegments(item.text));
                index += 1;
            }
            index -= 1;
            blocks.push({
                kind: 'list',
                ordered,
                items,
            });
            continue;
        }

        if (line.trim().length === 0) {
            pushTextBlock(blocks, textLines);
            continue;
        }

        textLines.push(line);
    }

    if (codeLines) {
        blocks.push({
            kind: 'code',
            language: codeLanguage,
            code: codeLines.join('\n'),
        });
    } else {
        pushTextBlock(blocks, textLines);
    }

    return blocks;
}

export function createStreamingAssistantMessageFormatter() {
    let text = '';
    let committedLength = 0;
    let committedBlocks: TAssistantMessageBlock[] = [];
    return {format(nextText: string) {
        if (!nextText.startsWith(text)) {
            text = nextText;
            committedLength = 0;
            committedBlocks = [];
        } else {
            text = nextText;
        }
        const suffix = text.slice(committedLength);
        const boundary = suffix.lastIndexOf('\n\n');
        if (boundary >= 0) {
            const stable = suffix.slice(0, boundary + 2);
            const fenceCount = (stable.match(/```/gu) ?? []).length;
            if (fenceCount % 2 === 0) {
                committedBlocks = [
                    ...committedBlocks,
                    ...formatAssistantMessage(stable),
                ];
                committedLength += stable.length;
            }
        }
        return [
            ...committedBlocks,
            ...formatAssistantMessage(text.slice(committedLength)),
        ];
    }};
}
