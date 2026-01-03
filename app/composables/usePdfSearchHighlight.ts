import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '../types/pdf';

const HIGHLIGHT_CLASS = 'pdf-search-highlight';
const HIGHLIGHT_CURRENT_CLASS = 'pdf-search-highlight--current';

export interface IHighlightResult {
    elements: HTMLElement[];
    currentMatchElements: HTMLElement[];
}

export function usePdfSearchHighlight() {
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

        const matchesWithCurrent = pageMatches.matches.map((m, index) => ({
            ...m,
            isCurrent:
                currentMatch !== null &&
                currentMatch.pageIndex === pageMatches.pageIndex &&
                currentMatch.matchIndex === index,
        }));

        const spans = textLayerDiv.querySelectorAll<HTMLSpanElement>(':scope > span, .markedContent span');
        const allHighlightElements: HTMLElement[] = [];
        const currentMatchElements: HTMLElement[] = [];

        let textOffset = 0;
        spans.forEach((span) => {
            if (span.querySelector('span')) {
                return;
            }

            const text = span.textContent ?? '';
            const spanLength = text.length;

            const elements = highlightTextInSpan(span, textOffset, matchesWithCurrent);
            allHighlightElements.push(...elements);

            elements.forEach((el) => {
                if (el.classList.contains(HIGHLIGHT_CURRENT_CLASS)) {
                    currentMatchElements.push(el);
                }
            });

            textOffset += spanLength;
        });

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
}
