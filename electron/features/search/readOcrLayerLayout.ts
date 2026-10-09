import type {
    IDocumentTextPageLayout,
    IDocumentTextRegion,
} from '@contracts/documentTextCatalog';
import type { IPdfOcrLayerLine } from '@contracts/pdfOcrTextVisibility';

interface IBlock {
    lines: IPdfOcrLayerLine[];
    left: number;
    right: number;
    top: number;
    bottom: number;
}

type TSide = 'left' | 'right';

// A block narrower than this share of the page's text is a margin note or the
// edge of a facing page, not a column.
const ASIDE_MAX_WIDTH_SHARE = 0.1;
// A column block may reach this share of the text width past the gutter.
const GUTTER_SLACK_SHARE = 0.05;
// Text across the gutter, like a title, holds at least this many letters;
// fewer are specks and page edges Tesseract read as a line.
const FULL_WIDTH_MIN_LETTERS = 12;
const EXTENT_MIN_LINES = 3;
// A line starts a paragraph when it is indented by this share of its font
// size, or follows a line that stops this many font sizes short.
const INDENT_SHARE = 0.6;
const SHORT_LINE_SHARE = 2.5;
// Scans are skewed, so a line is measured against this many lines around it.
const NEIGHBOURHOOD = 4;

function blocksOf(lines: readonly IPdfOcrLayerLine[]) {
    const blocks: IBlock[] = [];
    for (const line of lines) {
        const last = blocks.at(-1);
        if (last && last.lines[0]!.block === line.block) {
            last.lines.push(line);
            last.left = Math.min(last.left, line.left);
            last.right = Math.max(last.right, line.right);
            last.top = Math.max(last.top, line.baseline);
            last.bottom = Math.min(last.bottom, line.baseline);
        } else {
            blocks.push({
                lines: [line],
                left: line.left,
                right: line.right,
                top: line.baseline,
                bottom: line.baseline,
            });
        }
    }
    return blocks;
}

function letterCount(block: IBlock) {
    return block.lines.reduce((count, line) => count + (line.text.match(/\p{L}/gu)?.length ?? 0), 0);
}

function median(values: number[]) {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)]!;
}

/**
 * A column's paragraphs: a block starts one unless it continues a sentence
 * (a hyphenated word, a small letter), and so does a line indented past its
 * neighbours and the line before, or one after a line that stops short. A
 * line-end hyphen joins the word it splits.
 */
function paragraphsOf(blocks: readonly IBlock[]) {
    const lines = blocks.flatMap(block => block.lines.map((line, index) => ({
        line,
        startsBlock: index === 0,
    }))).filter(({line}) => line.text.trim() !== '');
    const near = (index: number, edge: (line: IPdfOcrLayerLine) => number) => median(
        lines.slice(Math.max(0, index - NEIGHBOURHOOD), index + NEIGHBOURHOOD + 1).map(({line}) => edge(line)),
    );
    const paragraphs: string[] = [];
    lines.forEach(({
        line, startsBlock,
    }, index) => {
        const text = line.text.trim();
        const previous = paragraphs.at(-1);
        // Beside a drop cap the second line is as indented as the first.
        const indented = line.left > near(index, entry => entry.left) + INDENT_SHARE * line.size
            && (index === 0 || line.left > lines[index - 1]!.line.left + INDENT_SHARE * line.size);
        const afterShort = index > 0
            && lines[index - 1]!.line.right < near(index - 1, entry => entry.right) - SHORT_LINE_SHARE * line.size;
        const continues = previous !== undefined && (/\p{L}-$/u.test(previous) || /^\p{Ll}/u.test(text));
        if (previous === undefined || indented || afterShort || (startsBlock && !continues)) {
            paragraphs.push(text);
        } else if (/\p{L}-$/u.test(previous) && /^\p{Ll}/u.test(text)) {
            paragraphs[paragraphs.length - 1] = previous.slice(0, -1) + text;
        } else {
            paragraphs[paragraphs.length - 1] = `${previous} ${text}`;
        }
    });
    return paragraphs;
}

/**
 * How an EVB OCR layer sets its page: blocks that span the gutter run across
 * the page, and blocks on either side of it, read in the same stretch, form
 * columns in the order Tesseract read them.
 */
export function readOcrLayerLayout(lines: readonly IPdfOcrLayerLine[]): IDocumentTextPageLayout {
    const blocks = blocksOf(lines);
    if (blocks.length === 0) return {regions: []};
    const pageWidth = Math.max(...blocks.map(block => block.right)) - Math.min(...blocks.map(block => block.left));
    const isAside = (block: IBlock) => block.right - block.left < ASIDE_MAX_WIDTH_SHARE * pageWidth;
    const body = blocks.filter(block => !isAside(block));
    const regions: IDocumentTextRegion[] = [];
    const aside = blocks.filter(isAside);
    if (body.length > 0) {
        // The text's extent, from blocks of several lines: specks and page
        // edges Tesseract read as one line would move the gutter.
        const columns = body.filter(block => block.lines.length >= EXTENT_MIN_LINES);
        const extent = columns.length > 0 ? columns : body;
        const left = Math.min(...extent.map(block => block.left));
        const right = Math.max(...extent.map(block => block.right));
        const gutter = (left + right) / 2;
        const slack = GUTTER_SLACK_SHARE * (right - left);
        const sideOf = (block: IBlock): TSide | null => block.right <= gutter + slack
            ? 'left'
            : block.left >= gutter - slack ? 'right' : null;
        let open: Map<TSide, IBlock[]> | null = null;
        const close = () => {
            if (!open) return;
            const sides = [...open.values()];
            const overlap = sides.length === 2 && Math.min(...sides.map(side => Math.max(...side.map(block => block.top))))
                > Math.max(...sides.map(side => Math.min(...side.map(block => block.bottom))));
            regions.push(overlap
                ? {columns: sides.map(paragraphsOf)}
                : {columns: [paragraphsOf(sides.flat().sort((a, b) => b.top - a.top))]});
            open = null;
        };
        for (const block of body) {
            const side = sideOf(block);
            if (side === null && letterCount(block) < FULL_WIDTH_MIN_LETTERS) {
                aside.push(block);
                continue;
            }
            if (side === null) {
                close();
                regions.push({columns: [paragraphsOf([block])]});
                continue;
            }
            open ??= new Map();
            open.set(side, [
                ...(open.get(side) ?? []),
                block,
            ]);
        }
        close();
    }
    if (aside.length > 0) regions.push({columns: [paragraphsOf(aside)]});
    // Consecutive single-column regions read as one run.
    const merged: IDocumentTextRegion[] = [];
    for (const region of regions.filter(entry => entry.columns.some(column => column.length > 0))) {
        const previous = merged.at(-1);
        if (previous && previous.columns.length === 1 && region.columns.length === 1) {
            merged[merged.length - 1] = {columns: [[
                ...previous.columns[0]!,
                ...region.columns[0]!,
            ]]};
        } else {
            merged.push(region);
        }
    }
    return {regions: merged};
}
