import type {
    IPdfPageMatches, IPdfSearchMatch,
} from '@app/types/pdfUi';
import {
    assembleTextLayerSearchText,
    buildRunMatchOverlaps,
    clearDomHighlights,
    getCachedTextLayerIndex,
    highlightTextRunInPdfjsStyle,
    resetTextLayerMappedText,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import type { IHighlightMatchRange } from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import {
    canUseHighlightAPI,
    clearHighlightAPIForLayer,
    createCssHighlightState,
    createHighlightRangesInSpan,
    getHighlightMode,
    registerHighlightRange,
    updateHighlightAPI,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightCss';
import {
    buildVisualMatchesWithCurrent,
    reconcileVisualMatchesWithCurrent,
} from '@app/modules/pdf-viewer/engine/search/buildVisualMatchesWithCurrent';

const HIGHLIGHT_CLASS = 'pdf-search-highlight';
const HIGHLIGHT_CURRENT_CLASS = 'pdf-search-highlight--current';
const HIGHLIGHT_API_NAME = 'pdf-search-match';
const HIGHLIGHT_API_CURRENT_NAME = 'pdf-search-current-match';

interface IHighlightResult {
    elements: HTMLElement[];
    currentMatchElements: HTMLElement[];
    currentMatchRanges: Range[];
}
interface IPaintedSegment {
    start: number;
    end: number;
    element?: HTMLElement;
    range?: Range;
    id?: string;
}
interface IPaintedLayer {
    pageMatches: IPdfPageMatches;
    mode: ReturnType<typeof getHighlightMode>;
    text: string;
    assembled: ReturnType<typeof assembleTextLayerSearchText>;
    matches: IHighlightMatchRange[];
    segments: IPaintedSegment[];
    result: IHighlightResult;
    resolveCurrent: ((current: IPdfSearchMatch | null) => IHighlightMatchRange[]) | null;
    pending?: AbortController;
}

function createHighlightResult(): IHighlightResult {
    return {
        elements: [],
        currentMatchElements: [],
        currentMatchRanges: [],
    };
}

export const usePdfSearchHighlight = () => {
    const cssState = createCssHighlightState();
    const paintedLayers = new WeakMap<HTMLElement, IPaintedLayer>();

    function clearPaint(container: HTMLElement) {
        clearHighlightAPIForLayer(cssState, container, HIGHLIGHT_API_NAME, HIGHLIGHT_API_CURRENT_NAME);
        clearDomHighlights(container, HIGHLIGHT_CLASS);
        resetTextLayerMappedText(container);
    }

    function clearHighlights(container: HTMLElement) {
        paintedLayers.get(container)?.pending?.abort();
        paintedLayers.delete(container);
        clearPaint(container);
    }

    function updateCurrent(textLayerDiv: HTMLElement, painted: IPaintedLayer, matches: IHighlightMatchRange[]) {
        const selected = matches.filter(match => match.isCurrent);
        const segments = painted.segments.filter(segment => selected.some(match => (
            segment.range ? match.start === segment.start && match.end === segment.end : match.start <= segment.start && match.end >= segment.end
        )));
        const elements = segments.flatMap(segment => segment.element ? [segment.element] : []);
        const ranges = segments.flatMap(segment => segment.range ? [segment.range] : []);
        for (const element of painted.result.currentMatchElements) {
            if (!elements.includes(element)) element.classList.remove(HIGHLIGHT_CURRENT_CLASS);
        }
        for (const element of elements) {
            if (!element.classList.contains(HIGHLIGHT_CURRENT_CLASS)) element.classList.add(HIGHLIGHT_CURRENT_CLASS);
        }
        const ids = cssState.layerRangeIds.get(textLayerDiv);
        if (ids) {
            const changed = new Set([
                ...painted.segments.filter(segment => segment.range && painted.result.currentMatchRanges.includes(segment.range)),
                ...segments,
            ]);
            for (const segment of changed) {
                if (!segment.range || !segment.id) continue;
                const current = ranges.includes(segment.range);
                if (ids.current.has(segment.id) === current) continue;
                const from = current ? HIGHLIGHT_API_NAME : HIGHLIGHT_API_CURRENT_NAME;
                const to = current ? HIGHLIGHT_API_CURRENT_NAME : HIGHLIGHT_API_NAME;
                CSS.highlights.get(from)?.delete(segment.range);
                const highlight = CSS.highlights.get(to) ?? new Highlight();
                highlight.add(segment.range);
                CSS.highlights.set(to, highlight);
                (current ? ids.normal : ids.current).delete(segment.id);
                (current ? ids.current : ids.normal).add(segment.id);
                (current ? cssState.highlightRanges : cssState.currentHighlightRanges).delete(segment.id);
                (current ? cssState.currentHighlightRanges : cssState.highlightRanges).set(segment.id, segment.range);
            }
        }
        painted.result.currentMatchElements.splice(0, painted.result.currentMatchElements.length, ...elements);
        painted.result.currentMatchRanges.splice(0, painted.result.currentMatchRanges.length, ...ranges);
    }

    function paintMatches(textLayerDiv: HTMLElement, painted: IPaintedLayer, matches: IHighlightMatchRange[]) {
        if (painted.matches.length !== matches.length || painted.matches.some((match, index) => (
            match.start !== matches[index]?.start || match.end !== matches[index]?.end
        ))) {
            clearPaint(textLayerDiv);
            painted.segments = [];
            painted.result.elements.splice(0);
            const {runs} = getCachedTextLayerIndex(textLayerDiv);
            const runOverlaps = buildRunMatchOverlaps(runs, matches);
            for (const [
                runIndex,
                run,
            ] of runs.entries()) {
                if (run.kind !== 'span' || !runOverlaps[runIndex]?.length) continue;
                if (painted.mode === 'css' && run.textNode) {
                    for (const match of runOverlaps[runIndex]) {
                        const [entry] = createHighlightRangesInSpan(run.textNode, run.startOffset, [match], [match]);
                        if (!entry) continue;
                        const id = `pdf-${painted.pageMatches.pageIndex}-${run.startOffset}-${painted.segments.length}`;
                        registerHighlightRange(cssState, textLayerDiv, entry.range, false, id);
                        painted.segments.push({
                            start: match.start,
                            end: match.end,
                            range: entry.range,
                            id,
                        });
                    }
                } else {
                    const elements = highlightTextRunInPdfjsStyle(run, matches, HIGHLIGHT_CLASS, HIGHLIGHT_CURRENT_CLASS, runOverlaps[runIndex]);
                    painted.result.elements.push(...elements);
                    let offset = run.startOffset;
                    for (const node of run.span.childNodes) {
                        const end = offset + (node.textContent?.length ?? 0);
                        if (node instanceof HTMLElement && node.classList.contains(HIGHLIGHT_CLASS)) {
                            painted.segments.push({
                                start: offset,
                                end,
                                element: node,
                            });
                        }
                        offset = end;
                    }
                }
            }
            if (painted.mode === 'css') updateHighlightAPI(cssState, HIGHLIGHT_API_NAME, HIGHLIGHT_API_CURRENT_NAME);
            painted.matches = matches;
        }
        updateCurrent(textLayerDiv, painted, matches);
    }

    function retainMatchIdentity(painted: IPaintedLayer, matches: IHighlightMatchRange[], verified: boolean) {
        const backend = painted.pageMatches.matches;
        // Reconciliation sorts by ordinal. Complete ordered windows retain each
        // backend identity; incomplete or unordered drift keeps its resolver.
        const ordered = backend.every((match, index) => index === 0 || match.start >= backend[index - 1]!.start);
        if (matches.length !== backend.length || (!verified && !ordered)) return;
        const identities = backend.map((match, index) => ({
            match,
            ordinal: match.pageMatchIndex ?? index,
        }));
        if (!verified) identities.sort((a, b) => a.ordinal - b.ordinal);
        painted.resolveCurrent = current => {
            const index = current?.pageIndex === painted.pageMatches.pageIndex
                ? identities.findIndex(({
                    match, ordinal,
                }) => match.matchIndex === current.matchIndex
                    || ordinal === current.pageMatchIndex)
                : -1;
            const selected = current?.pageIndex === painted.pageMatches.pageIndex ? Math.max(0, index) : -1;
            return matches.map((match, ordinal) => ({
                ...match,
                isCurrent: ordinal === selected,
            }));
        };
    }

    function highlightPage(textLayerDiv: HTMLElement, pageMatches: IPdfPageMatches | null, currentMatch: IPdfSearchMatch | null): IHighlightResult {
        if (!pageMatches || pageMatches.matches.length === 0) {
            clearHighlights(textLayerDiv);
            return createHighlightResult();
        }
        const mode = canUseHighlightAPI() ? getHighlightMode() : 'dom';
        let painted = paintedLayers.get(textLayerDiv);
        if (!painted || painted.mode !== mode || (painted.pageMatches !== pageMatches
            && (!pageMatches.signatureToken || painted.pageMatches.signatureToken !== pageMatches.signatureToken))) {
            clearHighlights(textLayerDiv);
            const {
                text, runs,
            } = getCachedTextLayerIndex(textLayerDiv);
            painted = {
                pageMatches,
                mode,
                text,
                assembled: assembleTextLayerSearchText({
                    text,
                    runs,
                }),
                matches: [],
                segments: [],
                result: createHighlightResult(),
                resolveCurrent: null,
            };
            paintedLayers.set(textLayerDiv, painted);
        }
        painted.pending?.abort();
        if (painted.resolveCurrent) {
            updateCurrent(textLayerDiv, painted, painted.resolveCurrent(currentMatch));
            return painted.result;
        }
        const verified = buildVisualMatchesWithCurrent(pageMatches, currentMatch, painted.text, painted.assembled);
        if (verified.length > 0) {
            paintMatches(textLayerDiv, painted, verified);
            retainMatchIdentity(painted, verified, true);
            return painted.result;
        }
        updateCurrent(textLayerDiv, painted, []);
        const controller = new AbortController();
        painted.pending = controller;
        const layer = painted;
        void reconcileVisualMatchesWithCurrent(pageMatches, currentMatch, layer.text, layer.assembled, controller.signal)
            .then(reconciled => {
                if (controller.signal.aborted) return;
                paintMatches(textLayerDiv, layer, reconciled);
                retainMatchIdentity(layer, reconciled, false);
            }).catch(() => {
                // Only text-verified ranges are painted before reconciliation.
            });
        return painted.result;
    }

    return {
        clearHighlights,
        highlightPage,
        getCurrentMatchRanges: (textLayerDiv: HTMLElement) => paintedLayers.get(textLayerDiv)?.result.currentMatchRanges ?? [],
        HIGHLIGHT_CLASS,
        HIGHLIGHT_CURRENT_CLASS,
    };
};
