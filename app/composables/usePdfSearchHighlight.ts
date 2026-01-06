import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from 'app/types/pdf';

const HIGHLIGHT_CLASS = 'pdf-search-highlight';
const HIGHLIGHT_CURRENT_CLASS = 'pdf-search-highlight--current';

export interface IHighlightResult {
    elements: HTMLElement[];
    currentMatchElements: HTMLElement[];
}

export const usePdfSearchHighlight = () => {
    type TTextLayerRun =
        | { kind: 'span'; span: HTMLSpanElement; startOffset: number }
        | { kind: 'br'; startOffset: number };

    function buildTextLayerIndex(textLayerDiv: HTMLElement): { text: string; runs: TTextLayerRun[] } {
        const runs: TTextLayerRun[] = [];
        const textParts: string[] = [];
        let offset = 0;

        function visit(node: Node) {
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return;
            }

            const element = node as HTMLElement;

            if (element.tagName === 'BR') {
                runs.push({ kind: 'br', startOffset: offset });
                textParts.push('\n');
                offset += 1;
                return;
            }

            // Leaf spans represent actual text runs in the PDF.js text layer.
            // Container spans (e.g. `.markedContent`) are traversed.
            if (element.tagName === 'SPAN' && element.children.length === 0) {
                const span = element as HTMLSpanElement;
                const text = span.textContent ?? '';
                runs.push({ kind: 'span', span, startOffset: offset });
                textParts.push(text);
                offset += text.length;
                return;
            }

            for (const child of Array.from(element.childNodes)) {
                visit(child);
            }
        }

        for (const child of Array.from(textLayerDiv.childNodes)) {
            visit(child);
        }

        return {
            text: textParts.join(''),
            runs,
        };
    }

    function clearHighlights(container: HTMLElement) {
        const highlights = container.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
        highlights.forEach((el) => {
            const parent = el.parentNode;
            if (parent) {
                while (el.firstChild) {
                    parent.insertBefore(el.firstChild, el);
                }
                parent.removeChild(el);
                parent.normalize();
            }
        });
    }

    function highlightTextInSpan(
        span: HTMLSpanElement,
        spanStartOffset: number,
        matches: Array<{
            start: number;
            end: number;
            isCurrent: boolean 
        }>,
    ): HTMLElement[] {
        const text = span.textContent ?? '';
        const spanEndOffset = spanStartOffset + text.length;

        const relevantMatches = matches.filter(
            (m) => m.start < spanEndOffset && m.end > spanStartOffset,
        );

        if (relevantMatches.length === 0) {
            return [];
        }

        const highlightElements: HTMLElement[] = [];
        const fragments: Array<{
            text: string;
            isHighlight: boolean;
            isCurrent: boolean 
        }> = [];

        let currentPos = 0;
        for (const match of relevantMatches) {
            const matchStartInSpan = Math.max(0, match.start - spanStartOffset);
            const matchEndInSpan = Math.min(text.length, match.end - spanStartOffset);

            if (matchStartInSpan > currentPos) {
                fragments.push({
                    text: text.slice(currentPos, matchStartInSpan),
                    isHighlight: false,
                    isCurrent: false,
                });
            }

            fragments.push({
                text: text.slice(matchStartInSpan, matchEndInSpan),
                isHighlight: true,
                isCurrent: match.isCurrent,
            });

            currentPos = matchEndInSpan;
        }

        if (currentPos < text.length) {
            fragments.push({
                text: text.slice(currentPos),
                isHighlight: false,
                isCurrent: false,
            });
        }

        span.textContent = '';

        for (const fragment of fragments) {
            if (fragment.isHighlight) {
                const mark = document.createElement('mark');
                mark.className = fragment.isCurrent
                    ? `${HIGHLIGHT_CLASS} ${HIGHLIGHT_CURRENT_CLASS}`
                    : HIGHLIGHT_CLASS;
                mark.textContent = fragment.text;
                span.appendChild(mark);
                highlightElements.push(mark);
            } else {
                span.appendChild(document.createTextNode(fragment.text));
            }
        }

        return highlightElements;
    }

    function highlightPage(
        textLayerDiv: HTMLElement,
        pageMatches: IPdfPageMatches | null,
        currentMatch: IPdfSearchMatch | null,
    ): IHighlightResult {
        clearHighlights(textLayerDiv);

        if (!pageMatches || pageMatches.matches.length === 0) {
            return {
                elements: [],
                currentMatchElements: [],
            };
        }

        const query = pageMatches.searchQuery?.trim() ?? '';
        if (!query) {
            return {
                elements: [],
                currentMatchElements: [],
            };
        }

        // Build a linear view of the text layer (including line breaks) and find matches in that space.
        // Backend offsets come from `pdftotext -layout` and often diverge from PDF.js span concatenation
        // due to whitespace/newline differences. Searching within the rendered text layer keeps highlights
        // anchored to what the user actually sees.
        const { text: layerText, runs } = buildTextLayerIndex(textLayerDiv);
        const lowerText = layerText.toLowerCase();
        const lowerQuery = query.toLowerCase();

        const matchRanges: Array<{ start: number; end: number }> = [];
        let pos = 0;
        while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
            matchRanges.push({ start: pos, end: pos + lowerQuery.length });
            pos += lowerQuery.length;
        }

        if (matchRanges.length === 0) {
            return {
                elements: [],
                currentMatchElements: [],
            };
        }

        let currentIndexOnPage = -1;
        if (currentMatch !== null && currentMatch.pageIndex === pageMatches.pageIndex) {
            currentIndexOnPage = pageMatches.matches.findIndex(
                (m, index) => currentMatch.matchIndex === (m.matchIndex ?? index),
            );
        }

        const matchesWithCurrent = matchRanges.map((m, index) => ({
            ...m,
            isCurrent: index === currentIndexOnPage,
        }));

        if (matchRanges.length !== pageMatches.matches.length && currentIndexOnPage !== -1) {
            console.warn('[PDF-HIGHLIGHT] Text-layer match count differs from backend results', {
                pageIndex: pageMatches.pageIndex,
                query,
                backendCount: pageMatches.matches.length,
                textLayerCount: matchRanges.length,
                currentIndexOnPage,
            });
        }

        const allHighlightElements: HTMLElement[] = [];
        const currentMatchElements: HTMLElement[] = [];

        for (const run of runs) {
            if (run.kind !== 'span') {
                continue;
            }

            const elements = highlightTextInSpan(run.span, run.startOffset, matchesWithCurrent);
            allHighlightElements.push(...elements);

            elements.forEach((el) => {
                if (el.classList.contains(HIGHLIGHT_CURRENT_CLASS)) {
                    currentMatchElements.push(el);
                }
            });
        }

        return {
            elements: allHighlightElements,
            currentMatchElements,
        };
    }

    function scrollToHighlight(element: HTMLElement, container: HTMLElement) {
        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();

        const elementTop = elementRect.top - containerRect.top + container.scrollTop;
        const elementCenter = elementTop - container.clientHeight / 2 + elementRect.height / 2;

        container.scrollTo({
            top: Math.max(0, elementCenter),
            behavior: 'smooth',
        });
    }

    return {
        clearHighlights,
        highlightPage,
        scrollToHighlight,
        HIGHLIGHT_CLASS,
        HIGHLIGHT_CURRENT_CLASS,
    };
};
