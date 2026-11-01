/**
 * PDF.js runs the bidi algorithm over each text chunk it builds and reverses a
 * right-to-left one. A writer that draws right-to-left text in logical order,
 * one positioned glyph per chunk (the EVB OCR layer does, so PDF.js cannot
 * reverse whole words), gets three changes back:
 *
 * - a combining mark comes before its letter: `ַה` for `הַ`;
 * - the space PDF.js put before a word's first letter comes after it: `ا ` for
 *   ` ا`;
 * - a combining mark that has an advance in its font leaves a gap PDF.js fills
 *   with a space item, which splits the word: `הַ`, ` `, `קְ`.
 *
 * Such a writer draws each glyph mirrored, advancing leftwards; a writer that
 * draws right-to-left text in visual order does not, and PDF.js's reversal is
 * right for it. The space repairs apply only to mirrored glyphs.
 *
 * Search text and the search highlight's map of the rendered text layer both
 * undo the changes here. A caller with glyph geometry proves that two glyphs
 * touch; the text layer has only each glyph's mirroring and treats
 * neighbouring glyphs as touching, as its contiguous text already does.
 */
export interface IPdfjsTextItem {
    text: string;
    /** The item's PDF.js direction: `ltr`, `rtl` or `ttb`. */
    dir: string;
    separatorAfter?: 'line' | 'none';
    transform?: readonly number[];
    width?: number;
    fontName?: string;
    /** Whether the glyph is drawn mirrored, for a caller without `transform`. */
    mirrored?: boolean;
}

/** Puts the combining marks PDF.js moved before a right-to-left letter back after it. */
export function restorePdfjsCombiningMarkOrder(text: string, direction: string) {
    if (direction !== 'rtl') {
        return text;
    }
    return text.replace(/^(\p{M}+)([^\p{M}])/u, '$2$1');
}

/** One drawn glyph: a single character and the marks drawn on it. */
function isPdfjsGlyphRun(text: string) {
    return /^\s*\S\p{M}*$/u.test(text);
}

function hasGlyphGeometry(item: IPdfjsTextItem) {
    return item.transform !== undefined && item.width !== undefined;
}

/** A logical-order right-to-left glyph: mirrored, so it advances leftwards. */
function isLogicalOrderRtlGlyph(item: IPdfjsTextItem) {
    const [
        a = 1,
        b = 0,
        c = 0,
        d = 1,
    ] = item.transform ?? [];
    return item.dir === 'rtl' && (item.transform ? a * d - b * c < 0 : item.mirrored === true);
}

/**
 * Whether `current` is drawn where `previous` ends, in the same font. Items
 * without geometry are taken to touch.
 */
function areAdjacentPdfjsGlyphs(
    previous: IPdfjsTextItem,
    previousText: string,
    current: IPdfjsTextItem,
) {
    if (previous.separatorAfter === 'line') {
        return false;
    }
    if (!hasGlyphGeometry(previous) || !hasGlyphGeometry(current)) {
        return true;
    }
    if (
        previous.fontName !== current.fontName
        || !Number.isFinite(previous.width)
        || !Number.isFinite(current.width)
    ) {
        return false;
    }
    const [
        a,
        b,
        , previousVerticalScale,
        previousX,
        previousY,
    ] = previous.transform!;
    const currentX = current.transform![4];
    const currentY = current.transform![5];
    if (
        a === undefined
        || b === undefined
        || previousX === undefined
        || previousY === undefined
        || currentX === undefined
        || currentY === undefined
        || previousVerticalScale === undefined
    ) {
        return false;
    }
    const scale = Math.hypot(a, b);
    if (!Number.isFinite(scale) || scale <= Number.EPSILON) {
        return false;
    }
    const expectedX = previousX + a / scale * previous.width!;
    const expectedY = previousY + b / scale * previous.width!;
    // A mark with an advance moves the next letter further than the item's width.
    const tolerance = /\p{M}$/u.test(previousText)
        ? Math.max(0.75, Math.abs(previousVerticalScale) * 0.75)
        : Math.max(0.75, previous.width! * 0.2);
    return Math.hypot(currentX - expectedX, currentY - expectedY) <= tolerance;
}

/** A space item PDF.js made from a combining mark's advance, inside a word. */
function isPdfjsMarkAdvanceSpace(
    previous: IPdfjsTextItem | undefined,
    previousText: string | undefined,
    item: IPdfjsTextItem,
    nextText: string | undefined,
) {
    return /^\s+$/u.test(item.text)
        && previous !== undefined
        && previousText !== undefined
        && /\p{M}$/u.test(previousText)
        && nextText !== undefined
        && isPdfjsGlyphRun(nextText)
        && !/^\s/u.test(nextText)
        && (hasGlyphGeometry(item) && hasGlyphGeometry(previous)
            ? item.width! <= Math.max(0.75, previous.width! * 1.25)
            : isLogicalOrderRtlGlyph(previous));
}

/**
 * Each item's text in logical order: marks after their letter, a word's
 * leading space before it, and `''` for a space PDF.js made inside a word.
 * The result has one entry per item, so callers keep their own item offsets.
 */
export function restorePdfjsRtlItemTexts(items: readonly IPdfjsTextItem[]) {
    const texts = items.map(item => restorePdfjsCombiningMarkOrder(item.text, item.dir));
    return texts.map((text, index) => {
        const item = items[index]!;
        const next = items[index + 1];
        const nextText = texts[index + 1];
        if (isPdfjsMarkAdvanceSpace(items[index - 1], texts[index - 1], item, nextText)) {
            return '';
        }
        const [
            , glyph,
            space,
        ] = (isLogicalOrderRtlGlyph(item) ? /^(\S\p{M}*)(\s+)$/u.exec(text) : null) ?? [];
        if (
            glyph !== undefined
            && space !== undefined
            && next !== undefined
            && nextText !== undefined
            && isPdfjsGlyphRun(nextText)
            && !/^\s/u.test(nextText)
            && areAdjacentPdfjsGlyphs(item, text, next)
        ) {
            return `${space}${glyph}`;
        }
        return text;
    });
}

/**
 * The items with PDF.js's right-to-left changes undone and each word's
 * positioned glyphs joined into one item, so a search assembler's item
 * separators fall only between words.
 */
export function mergePositionedPdfjsGlyphItems<TItem extends IPdfjsTextItem>(items: readonly TItem[]) {
    const texts = restorePdfjsRtlItemTexts(items);
    const merged: TItem[] = [];
    let previousIsGlyphRun = false;
    items.forEach((item, index) => {
        const text = texts[index]!;
        if (text === '' && item.text !== '') {
            return;
        }
        const isGlyphRun = isPdfjsGlyphRun(text);
        const previous = merged.at(-1);
        if (
            previous !== undefined
            && previousIsGlyphRun
            && isGlyphRun
            && !/^\s/u.test(text)
            && hasGlyphGeometry(previous)
            && hasGlyphGeometry(item)
            && areAdjacentPdfjsGlyphs(previous, previous.text, item)
        ) {
            merged[merged.length - 1] = {
                ...previous,
                text: previous.text + text,
                separatorAfter: item.separatorAfter,
                transform: item.transform,
                width: item.width,
            };
            return;
        }
        merged.push({
            ...item,
            text,
        });
        previousIsGlyphRun = isGlyphRun;
    });
    return merged;
}
