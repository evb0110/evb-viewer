const HIGHLIGHT_NAME = 'search-result-match';
const ranges = new Map<string, Range>();

function updateHighlight() {
    if (!CSS.highlights) {
        return;
    }

    if (ranges.size === 0) {
        CSS.highlights.delete(HIGHLIGHT_NAME);
        return;
    }

    const highlight = new Highlight(...ranges.values());
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);
}

export function registerSearchHighlight(id: string, range: Range) {
    ranges.set(id, range);
    updateHighlight();
}

export function unregisterSearchHighlight(id: string) {
    ranges.delete(id);
    updateHighlight();
}

export function clearAllSearchHighlights() {
    ranges.clear();
    if (CSS.highlights) {
        CSS.highlights.delete(HIGHLIGHT_NAME);
    }
}
