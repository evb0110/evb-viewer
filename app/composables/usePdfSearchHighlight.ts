import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    ISearchExcerpt,
} from '@app/types/pdf';
import { STORAGE_KEYS } from '@app/constants/storage-keys';

const HIGHLIGHT_CLASS = 'pdf-search-highlight';
const HIGHLIGHT_CURRENT_CLASS = 'pdf-search-highlight--current';

const HIGHLIGHT_API_NAME = 'pdf-search-match';
const HIGHLIGHT_API_CURRENT_NAME = 'pdf-search-current-match';

const EXCERPT_CONTEXT_CHARS = 40;

type TPdfHighlightMode = 'dom' | 'css';

export interface IHighlightResult {
    elements: HTMLElement[];
    currentMatchElements: HTMLElement[];
    currentMatchRanges: Range[];
}

export const usePdfSearchHighlight = () => {
    type TTextLayerRun =
        | {
            kind: 'span';
            span: HTMLSpanElement;
            textNode: Text | null;
            startOffset: number;
        }
        | {
            kind: 'br';
            startOffset: number;
        };

    type THighlightRange = {
        range: Range;
        isCurrent: boolean;
    };

    const highlightRanges = new Map<string, Range>();
    const currentHighlightRanges = new Map<string, Range>();

    const layerRangeIds = new WeakMap<HTMLElement, {
        normal: Set<string>;
        current: Set<string>;
    }>();
    const layerCurrentRanges = new WeakMap<HTMLElement, Range[]>();

    function canUseHighlightAPI() {
        return typeof CSS !== 'undefined'
            && 'highlights' in CSS
            && typeof Highlight !== 'undefined';
    }

    function getHighlightMode(): TPdfHighlightMode {
        if (!canUseHighlightAPI()) {
            return 'dom';
        }

        if (typeof window === 'undefined') {
            return 'dom';
        }

        try {
            const stored = window.localStorage?.getItem(STORAGE_KEYS.HIGHLIGHT_MODE);
            return stored === 'css' ? 'css' : 'dom';
        } catch {
            return 'dom';
        }
    }

    function isHighlightDebugEnabled() {
        if (typeof window === 'undefined') {
            return false;
        }

        try {
            return window.localStorage?.getItem(STORAGE_KEYS.HIGHLIGHT_DEBUG) === '1';
        } catch {
            return false;
        }
    }

    function updateHighlightAPI() {
        if (!canUseHighlightAPI()) {
            return;
        }

        if (highlightRanges.size === 0) {
            CSS.highlights.delete(HIGHLIGHT_API_NAME);
        } else {
            CSS.highlights.set(HIGHLIGHT_API_NAME, new Highlight(...highlightRanges.values()));
        }

        if (currentHighlightRanges.size === 0) {
            CSS.highlights.delete(HIGHLIGHT_API_CURRENT_NAME);
        } else {
            CSS.highlights.set(HIGHLIGHT_API_CURRENT_NAME, new Highlight(...currentHighlightRanges.values()));
        }
    }

    function buildTextLayerIndex(textLayerDiv: HTMLElement): {
        text: string;
        runs: TTextLayerRun[];
    } {
        const runs: TTextLayerRun[] = [];
        const textParts: string[] = [];
        let offset = 0;

        function visit(node: Node) {
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return;
            }

            const element = node as HTMLElement;

            if (element.tagName === 'BR') {
                runs.push({
                    kind: 'br',
                    startOffset: offset,
                });
                textParts.push('\n');
                offset += 1;
                return;
            }

            // Leaf spans represent actual text runs in the PDF.js text layer.
            // Container spans (e.g. `.markedContent`) are traversed.
            if (element.tagName === 'SPAN' && element.children.length === 0) {
                const span = element as HTMLSpanElement;
                const text = span.textContent ?? '';
                const textNode = span.firstChild && span.firstChild.nodeType === Node.TEXT_NODE
                    ? span.firstChild as Text
                    : null;
                runs.push({
                    kind: 'span',
                    span,
                    textNode,
                    startOffset: offset,
                });
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

    function clearHighlightAPIForLayer(container: HTMLElement) {
        if (!canUseHighlightAPI()) {
            return;
        }

        const ids = layerRangeIds.get(container);
        if (!ids) {
            return;
        }

        for (const id of ids.normal) {
            highlightRanges.delete(id);
        }
        for (const id of ids.current) {
            currentHighlightRanges.delete(id);
        }

        layerRangeIds.delete(container);
        layerCurrentRanges.delete(container);
        updateHighlightAPI();
    }

    function clearHighlights(container: HTMLElement) {
        clearHighlightAPIForLayer(container);

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

    function registerHighlightRange(
        container: HTMLElement,
        range: Range,
        isCurrent: boolean,
        id: string,
    ) {
        let ids = layerRangeIds.get(container);
        if (!ids) {
            ids = {
                normal: new Set<string>(),
                current: new Set<string>(),
            };
            layerRangeIds.set(container, ids);
        }

        if (isCurrent) {
            ids.current.add(id);
            currentHighlightRanges.set(id, range);
        } else {
            ids.normal.add(id);
            highlightRanges.set(id, range);
        }
    }

    function createHighlightRangesInSpan(
        textNode: Text,
        spanStartOffset: number,
        matches: Array<{
            start: number;
            end: number;
            isCurrent: boolean;
        }>,
    ): THighlightRange[] {
        const text = textNode.nodeValue ?? '';
        const spanEndOffset = spanStartOffset + text.length;

        const relevantMatches = matches.filter(
            (m) => m.start < spanEndOffset && m.end > spanStartOffset,
        );

        if (relevantMatches.length === 0) {
            return [];
        }

        const ranges: THighlightRange[] = [];
        for (const match of relevantMatches) {
            const matchStartInSpan = Math.max(0, match.start - spanStartOffset);
            const matchEndInSpan = Math.min(text.length, match.end - spanStartOffset);

            if (matchStartInSpan >= matchEndInSpan) {
                continue;
            }

            const range = document.createRange();
            range.setStart(textNode, matchStartInSpan);
            range.setEnd(textNode, matchEndInSpan);
            ranges.push({
                range,
                isCurrent: match.isCurrent,
            });
        }

        return ranges;
    }

    function highlightTextInSpan(
        span: HTMLSpanElement,
        spanStartOffset: number,
        matches: Array<{
            start: number;
            end: number;
            isCurrent: boolean;
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
            isCurrent: boolean;
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
                currentMatchRanges: [],
            };
        }

        const query = pageMatches.searchQuery?.trim() ?? '';
        if (!query) {
            return {
                elements: [],
                currentMatchElements: [],
                currentMatchRanges: [],
            };
        }

        // Build a linear view of the text layer (including line breaks) and find matches in that space.
        // Backend offsets come from `pdftotext -layout` and often diverge from PDF.js span concatenation
        // due to whitespace/newline differences. Searching within the rendered text layer keeps highlights
        // anchored to what the user actually sees.
        const {
            text: layerText,
            runs,
        } = buildTextLayerIndex(textLayerDiv);
        const lowerText = layerText.toLowerCase();
        const lowerQuery = query.toLowerCase();

        const matchRanges: Array<{
            start: number;
            end: number;
        }> = [];
        let pos = 0;
        while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
            matchRanges.push({
                start: pos,
                end: pos + lowerQuery.length,
            });
            pos += lowerQuery.length;
        }

        if (matchRanges.length === 0) {
            return {
                elements: [],
                currentMatchElements: [],
                currentMatchRanges: [],
            };
        }

        const normalizeContext = (value: string) =>
            value.replace(/\s+/g, ' ').trim().toLowerCase();

        const commonPrefixLength = (a: string, b: string) => {
            const limit = Math.min(a.length, b.length);
            let count = 0;
            while (count < limit && a[count] === b[count]) {
                count += 1;
            }
            return count;
        };

        const commonSuffixLength = (a: string, b: string) => {
            const limit = Math.min(a.length, b.length);
            let count = 0;
            while (count < limit && a[a.length - 1 - count] === b[b.length - 1 - count]) {
                count += 1;
            }
            return count;
        };

        const buildExcerpt = (text: string, startOffset: number, endOffset: number): ISearchExcerpt => {
            const excerptStart = Math.max(0, startOffset - EXCERPT_CONTEXT_CHARS);
            const excerptEnd = Math.min(text.length, endOffset + EXCERPT_CONTEXT_CHARS);

            const beforeRaw = text.slice(excerptStart, startOffset);
            const match = text.slice(startOffset, endOffset);
            const afterRaw = text.slice(endOffset, excerptEnd);

            const beforeNormalized = beforeRaw.replace(/\s+/g, ' ').trimStart();
            const afterNormalized = afterRaw.replace(/\s+/g, ' ').trimEnd();

            const isWordChar = (ch: string) => /[0-9A-Za-z]/.test(ch);
            const matchLen = match.length;

            let before = beforeNormalized;
            let after = afterNormalized;

            if (matchLen >= 4 && matchLen > 0) {
                const beforeHasBoundaryWhitespace = /\s$/.test(beforeRaw);
                const afterHasBoundaryWhitespace = /^\s/.test(afterRaw);

                const beforeLast = beforeNormalized.at(-1) ?? '';
                const matchFirst = match.at(0) ?? '';
                const matchLast = match.at(-1) ?? '';
                const afterFirst = afterNormalized.at(0) ?? '';

                if (!beforeHasBoundaryWhitespace && beforeLast && matchFirst && isWordChar(beforeLast) && isWordChar(matchFirst)) {
                    before = `${beforeNormalized} `;
                }

                const looksLikePluralSuffix = afterNormalized === 's' || afterNormalized.startsWith('s ');
                if (
                    !afterHasBoundaryWhitespace
                    && !looksLikePluralSuffix
                    && matchLast
                    && afterFirst
                    && isWordChar(matchLast)
                    && isWordChar(afterFirst)
                ) {
                    after = ` ${afterNormalized}`;
                }
            }

            return {
                prefix: excerptStart > 0,
                suffix: excerptEnd < text.length,
                before,
                match,
                after,
            };
        };

        let backendIndexOnPage = -1;
        if (currentMatch !== null && currentMatch.pageIndex === pageMatches.pageIndex) {
            backendIndexOnPage = pageMatches.matches.findIndex(
                (m, index) => currentMatch.matchIndex === (m.matchIndex ?? index),
            );
        }

        let currentIndexOnPage = -1;

        // If pageMatchIndex is available, use it directly (OCR pages provide this)
        if (currentMatch && currentMatch.pageMatchIndex !== undefined && currentMatch.pageIndex === pageMatches.pageIndex) {
            currentIndexOnPage = currentMatch.pageMatchIndex;
            if (isHighlightDebugEnabled()) {
                console.log('[PDF-HIGHLIGHT] Using pageMatchIndex:', currentMatch.pageMatchIndex);
            }
        } else if (backendIndexOnPage !== -1 && currentMatch?.excerpt) {
            // Fallback to fuzzy matching for non-OCR pages
            const expectedIndex = backendIndexOnPage;
            const targetBefore = normalizeContext(currentMatch.excerpt.before);
            const targetAfter = normalizeContext(currentMatch.excerpt.after);

            let bestIndex = -1;
            let bestScore = Number.NEGATIVE_INFINITY;

            for (let i = 0; i < matchRanges.length; i += 1) {
                const candidate = matchRanges[i]!;
                const candidateExcerpt = buildExcerpt(layerText, candidate.start, candidate.end);

                const candidateBefore = normalizeContext(candidateExcerpt.before);
                const candidateAfter = normalizeContext(candidateExcerpt.after);

                const beforeScore = commonSuffixLength(
                    targetBefore.slice(-EXCERPT_CONTEXT_CHARS),
                    candidateBefore.slice(-EXCERPT_CONTEXT_CHARS),
                );
                const afterScore = commonPrefixLength(
                    targetAfter.slice(0, EXCERPT_CONTEXT_CHARS),
                    candidateAfter.slice(0, EXCERPT_CONTEXT_CHARS),
                );

                const proximityPenalty = Math.abs(i - expectedIndex);
                const score = beforeScore + afterScore - proximityPenalty;

                if (score > bestScore) {
                    bestScore = score;
                    bestIndex = i;
                }
            }

            if (bestIndex !== -1) {
                currentIndexOnPage = bestIndex;
            }
        } else if (backendIndexOnPage !== -1) {
            // Fallback when no excerpt is available
            currentIndexOnPage = backendIndexOnPage;
        }

        const matchesWithCurrent = matchRanges.map((m, index) => ({
            ...m,
            isCurrent: index === currentIndexOnPage,
        }));

        if (isHighlightDebugEnabled() && matchRanges.length !== pageMatches.matches.length && backendIndexOnPage !== -1) {
            console.warn('[PDF-HIGHLIGHT] Text-layer match count differs from backend results', {
                pageIndex: pageMatches.pageIndex,
                query,
                backendCount: pageMatches.matches.length,
                textLayerCount: matchRanges.length,
                backendIndexOnPage,
                mappedTextLayerIndex: currentIndexOnPage,
            });
        }

        if (canUseHighlightAPI() && getHighlightMode() === 'css') {
            const currentRanges: Range[] = [];

            for (const run of runs) {
                if (run.kind !== 'span') {
                    continue;
                }

                if (!run.textNode) {
                    continue;
                }

                const ranges = createHighlightRangesInSpan(run.textNode, run.startOffset, matchesWithCurrent);
                ranges.forEach((rangeEntry, idx) => {
                    const {
                        range,
                        isCurrent,
                    } = rangeEntry;
                    const id = `pdf-${pageMatches.pageIndex}-${run.startOffset}-${idx}-${isCurrent ? 'c' : 'n'}`;
                    registerHighlightRange(textLayerDiv, range, isCurrent, id);
                    if (isCurrent) {
                        currentRanges.push(range);
                    }
                });
            }

            layerCurrentRanges.set(textLayerDiv, currentRanges);
            updateHighlightAPI();

            return {
                elements: [],
                currentMatchElements: [],
                currentMatchRanges: currentRanges,
            };
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
            currentMatchRanges: [],
        };
    }

    function scrollToHighlight(
        element: HTMLElement,
        container: HTMLElement,
        behavior: ScrollBehavior = 'auto',
    ) {
        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();

        const elementTop = elementRect.top - containerRect.top + container.scrollTop;
        const elementCenter = elementTop - container.clientHeight / 2 + elementRect.height / 2;

        container.scrollTo({
            top: Math.max(0, elementCenter),
            behavior,
        });
    }

    function getCurrentMatchRanges(textLayerDiv: HTMLElement): Range[] {
        return layerCurrentRanges.get(textLayerDiv) ?? [];
    }

    return {
        clearHighlights,
        highlightPage,
        scrollToHighlight,
        getCurrentMatchRanges,
        HIGHLIGHT_CLASS,
        HIGHLIGHT_CURRENT_CLASS,
    };
};
