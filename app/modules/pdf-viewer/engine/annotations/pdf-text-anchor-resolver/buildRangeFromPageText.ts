export interface IBuildRangeFromPageTextOptions {
    text: string;
    occurrence?: number;
    caseSensitive?: boolean;
    wholeWord?: boolean;
}

/** One character of the page, or the space standing for a whitespace run. */
interface ISourceCharacter {
    node: Text;
    start: number;
    end: number;
}

// Case folds one character at a time, so each folded unit still names the
// character it came from even where folding changes the length.
function fold(value: string, caseSensitive: boolean) {
    return caseSensitive ? value : Array.from(value, character => character.toLocaleLowerCase()).join('');
}

export function buildRangeFromPageText(
    pageContainer: HTMLElement,
    options: IBuildRangeFromPageTextOptions,
) {
    const caseSensitive = options.caseSensitive === true;
    const spans = Array.from(pageContainer.querySelectorAll<HTMLElement>('.text-layer span, .textLayer span'))
        .filter(span => !span.parentElement?.closest('span'));
    // `positions[i]` is the source of `haystack[i]`. Search highlighting
    // wraps matches in nested spans, so every text node of a span is read.
    const positions: ISourceCharacter[] = [];
    let haystack = '';
    const append = (value: string, source: ISourceCharacter) => {
        haystack += value;
        for (let unit = 0; unit < value.length; unit += 1) positions.push(source);
    };
    const separate = (node: Text, offset: number) => {
        if (haystack && !haystack.endsWith(' ')) append(' ', {
            node,
            start: offset,
            end: offset,
        });
    };
    for (const span of spans) {
        const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode() as Text | null, first = true; node; node = walker.nextNode() as Text | null, first = false) {
            if (first) separate(node, 0);
            let offset = 0;
            for (const character of node.data) {
                if (/\s/u.test(character)) separate(node, offset);
                else append(fold(character, caseSensitive), {
                    node,
                    start: offset,
                    end: offset + character.length,
                });
                offset += character.length;
            }
        }
    }
    while (haystack.endsWith(' ')) {
        haystack = haystack.slice(0, -1);
        positions.pop();
    }
    const needle = fold(options.text.trim().replace(/\s+/gu, ' '), caseSensitive);
    let cursor = 0;
    let found = 0;
    while (needle && cursor <= haystack.length) {
        const startOffset = haystack.indexOf(needle, cursor);
        if (startOffset < 0) {
            return null;
        }
        const endOffset = startOffset + needle.length;
        const before = haystack[startOffset - 1] ?? '';
        const after = haystack[endOffset] ?? '';
        if (!options.wholeWord || (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after))) {
            found += 1;
            if (found === Math.max(1, Math.trunc(options.occurrence ?? 1))) {
                const start = positions[startOffset];
                const end = positions[endOffset - 1];
                if (!start || !end) {
                    return null;
                }
                const range = document.createRange();
                range.setStart(start.node, start.start);
                range.setEnd(end.node, end.end);
                let matchedText = '';
                for (const [
                    index,
                    source,
                ] of positions.slice(startOffset, endOffset).entries()) {
                    if (source === positions[startOffset + index - 1] && index > 0) continue;
                    matchedText += source.start === source.end ? ' ' : source.node.data.slice(source.start, source.end);
                }
                return {
                    range,
                    matchedText,
                };
            }
        }
        cursor = startOffset + Math.max(1, needle.length);
    }
    return null;
}
