const HIGHLIGHT_NAME = 'search-result-match';
const MAX_HIGHLIGHT_RANGES = 2000;
const ranges = new Map<string, Range>();

function pruneDetachedRanges() {
    for (const [
        id,
        range,
    ] of ranges) {
        if (!range.startContainer.isConnected || !range.endContainer.isConnected) {
            ranges.delete(id);
        }
    }
}

function enforceRangeBudget() {
    while (ranges.size > MAX_HIGHLIGHT_RANGES) {
        const oldestKey = ranges.keys().next().value;
        if (!oldestKey) {
            break;
        }
        ranges.delete(oldestKey);
    }
}

function updateHighlight() {
    if (!CSS.highlights) {
        return;
    }

    pruneDetachedRanges();

    if (ranges.size === 0) {
        CSS.highlights.delete(HIGHLIGHT_NAME);
        return;
    }

    const highlight = new Highlight(...ranges.values());
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);
}

export function registerSearchHighlight(id: string, range: Range) {
    ranges.set(id, range);
    enforceRangeBudget();
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
