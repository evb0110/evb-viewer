import type { IOcrWord } from '@contracts/shared';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';

export type TPdfjsTextOps = Partial<Record<
    | 'save'
    | 'restore'
    | 'transform'
    | 'beginText'
    | 'endText'
    | 'setCharSpacing'
    | 'setWordSpacing'
    | 'setHScale'
    | 'setLeading'
    | 'setFont'
    | 'setTextRise'
    | 'setTextMatrix'
    | 'moveText'
    | 'setLeadingMoveText'
    | 'nextLine'
    | 'showText'
    | 'showSpacedText'
    | 'nextLineShowText'
    | 'nextLineSetSpacingShowText',
    number
>>;

type TMatrix = [number, number, number, number, number, number];

type TTypedArray =
    | Int8Array
    | Uint8Array
    | Uint8ClampedArray
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array;

interface ITextState {
    textMatrix: TMatrix;
    lineMatrix: TMatrix;
    fontSize: number;
    hScale: number;
    charSpacing: number;
    wordSpacing: number;
    leading: number;
    textRise: number;
    /** The text position moved by an operator since the last glyph was shown. */
    repositioned: boolean;
}

interface IIndexedGlyphBox extends IOcrWord {
    startOffset: number;
    endOffset: number;
}

interface IActiveWord {
    text: string;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    chars: IIndexedGlyphBox[];
    /** Where the pen stood after the word's last glyph, in page space. */
    penX: number;
    penY: number;
    /** The last glyph's font size in page space. */
    emSize: number;
}

/**
 * A positioning operator ends a word only when the next glyph does not start
 * where the previous one ended. OCR layers, EVB's among them, place every glyph
 * with its own text matrix; reading each as a word would index "a m e r l i".
 * Below this fraction of the font size the gap is letter spacing, as in
 * Poppler's word segmentation.
 */
const MAX_WORD_GLYPH_GAP_EM = 0.15;

export interface IPdfjsPageViewBox {
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
    pageWidth: number;
    pageHeight: number;
    rotation: TOcrIndexRotation;
}

export interface IPdfjsOperatorListLike {
    fnArray: ArrayLike<number>;
    argsArray: ArrayLike<unknown>;
}

export interface IExtractPdfjsWordBoxOptions {throwIfAborted?: () => void;}

function identityMatrix(): TMatrix {
    return [
        1,
        0,
        0,
        1,
        0,
        0,
    ];
}

function cloneMatrix(matrix: TMatrix): TMatrix {
    return [...matrix] as TMatrix;
}

function finiteNumber(value: unknown, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
}

function normalizePageRotation(value: unknown): TOcrIndexRotation {
    const finiteValue = finiteNumber(value, 0);
    const normalized = ((finiteValue % 360) + 360) % 360;
    return normalized === 90 || normalized === 180 || normalized === 270
        ? normalized
        : 0;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
    return Array.isArray(value);
}

function isTypedArray(value: unknown): value is TTypedArray {
    return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function arrayFromUnknownArrayLike(value: unknown): unknown[] | null {
    if (isUnknownArray(value)) {
        return [...value];
    }
    if (isTypedArray(value)) {
        return Array.from(value);
    }
    return null;
}

function matrixFromArgs(args: unknown): TMatrix | null {
    let values = arrayFromUnknownArrayLike(args);
    if (values?.length === 1) {
        values = arrayFromUnknownArrayLike(values[0]) ?? values;
    }

    if (!values || values.length < 6) {
        return null;
    }

    return [
        finiteNumber(values[0], 1),
        finiteNumber(values[1], 0),
        finiteNumber(values[2], 0),
        finiteNumber(values[3], 1),
        finiteNumber(values[4], 0),
        finiteNumber(values[5], 0),
    ];
}

function multiplyMatrices(left: TMatrix, right: TMatrix): TMatrix {
    const [
        a1,
        b1,
        c1,
        d1,
        e1,
        f1,
    ] = left;
    const [
        a2,
        b2,
        c2,
        d2,
        e2,
        f2,
    ] = right;

    return [
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    ];
}

function transformPoint(
    matrix: TMatrix,
    x: number,
    y: number,
) {
    return {
        x: matrix[0] * x + matrix[2] * y + matrix[4],
        y: matrix[1] * x + matrix[3] * y + matrix[5],
    };
}

function translateTextMatrix(
    matrix: TMatrix,
    x: number,
    y: number,
): TMatrix {
    return [
        matrix[0],
        matrix[1],
        matrix[2],
        matrix[3],
        matrix[4] + x * matrix[0] + y * matrix[2],
        matrix[5] + x * matrix[1] + y * matrix[3],
    ];
}

function createInitialTextState(): ITextState {
    const matrix = identityMatrix();
    return {
        textMatrix: cloneMatrix(matrix),
        lineMatrix: cloneMatrix(matrix),
        fontSize: 0,
        hScale: 1,
        charSpacing: 0,
        wordSpacing: 0,
        leading: 0,
        textRise: 0,
        repositioned: false,
    };
}

export function getPdfjsPageViewBox(page: {
    view?: unknown;
    rotate?: unknown;
}): IPdfjsPageViewBox {
    const view = Array.isArray(page.view) || ArrayBuffer.isView(page.view)
        ? Array.from(page.view as ArrayLike<unknown>)
        : [];
    const xMin = finiteNumber(view[0], 0);
    const yMin = finiteNumber(view[1], 0);
    const xMax = finiteNumber(view[2], 0);
    const yMax = finiteNumber(view[3], 0);
    const pageWidth = Math.max(0, xMax - xMin);
    const pageHeight = Math.max(0, yMax - yMin);

    return {
        xMin,
        yMin,
        xMax,
        yMax,
        pageWidth,
        pageHeight,
        rotation: normalizePageRotation(page.rotate),
    };
}

function createPageSpaceBox(
    state: ITextState,
    ctm: TMatrix,
    glyphWidth: number,
    glyphHeight: number,
    pageBox: IPdfjsPageViewBox,
) {
    const textToPage = multiplyMatrices(ctm, state.textMatrix);
    // PDF text rise (Ts) shifts the glyph vertically in unscaled text space, so
    // superscripts/subscripts paint above/below the baseline. Offset the glyph's
    // text-space y before mapping to page space, or the box lands on the baseline.
    const riseBottom = state.textRise;
    const riseTop = state.textRise + glyphHeight;
    const corners = [
        transformPoint(textToPage, 0, riseBottom),
        transformPoint(textToPage, glyphWidth, riseBottom),
        transformPoint(textToPage, glyphWidth, riseTop),
        transformPoint(textToPage, 0, riseTop),
    ];
    const minX = Math.min(...corners.map(point => point.x));
    const maxX = Math.max(...corners.map(point => point.x));
    const minY = Math.min(...corners.map(point => point.y));
    const maxY = Math.max(...corners.map(point => point.y));

    const x = minX - pageBox.xMin;
    const y = pageBox.yMax - maxY;
    const width = maxX - minX;
    const height = maxY - minY;

    if (
        !Number.isFinite(x)
        || !Number.isFinite(y)
        || !Number.isFinite(width)
        || !Number.isFinite(height)
        || width <= 0
        || height <= 0
    ) {
        return null;
    }

    return {
        x,
        y,
        width,
        height,
    };
}

function extendActiveWord(
    activeWord: IActiveWord | null,
    glyph: IIndexedGlyphBox,
) {
    const word = activeWord ?? {
        text: '',
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
        chars: [],
        penX: 0,
        penY: 0,
        emSize: 0,
    };

    word.text += glyph.text;
    word.minX = Math.min(word.minX, glyph.x);
    word.minY = Math.min(word.minY, glyph.y);
    word.maxX = Math.max(word.maxX, glyph.x + glyph.width);
    word.maxY = Math.max(word.maxY, glyph.y + glyph.height);
    word.chars.push(glyph);
    return word;
}

function flushActiveWord(
    words: IOcrWord[],
    activeWord: IActiveWord | null,
) {
    if (
        !activeWord
        || activeWord.text.trim().length === 0
        || activeWord.maxX <= activeWord.minX
        || activeWord.maxY <= activeWord.minY
    ) {
        return null;
    }

    words.push({
        text: activeWord.text,
        x: activeWord.minX,
        y: activeWord.minY,
        width: activeWord.maxX - activeWord.minX,
        height: activeWord.maxY - activeWord.minY,
        chars: activeWord.chars,
    } as IOcrWord);

    return null;
}

function getGlyphText(glyph: unknown) {
    if (!glyph || typeof glyph !== 'object') {
        return '';
    }
    const record = glyph as Record<string, unknown>;
    if (typeof record.unicode === 'string') {
        return record.unicode;
    }
    if (typeof record.fontChar === 'string') {
        return record.fontChar;
    }
    return '';
}

function getGlyphWidth(glyph: unknown) {
    if (!glyph || typeof glyph !== 'object') {
        return 0;
    }
    return finiteNumber((glyph as Record<string, unknown>).width, 0);
}

function isGlyphSpace(
    glyph: unknown,
    text: string,
) {
    if (glyph && typeof glyph === 'object' && (glyph as Record<string, unknown>).isSpace === true) {
        return true;
    }
    return text.length > 0 && text.trim().length === 0;
}

function advanceText(
    state: ITextState,
    amount: number,
) {
    state.textMatrix = translateTextMatrix(state.textMatrix, amount, 0);
}

function showGlyphArray(
    glyphs: readonly unknown[],
    state: ITextState,
    ctm: TMatrix,
    pageBox: IPdfjsPageViewBox,
    words: IOcrWord[],
    activeWord: IActiveWord | null,
) {
    let nextActiveWord = activeWord;
    const fontSize = Math.max(0, state.fontSize);
    const hScale = state.hScale || 1;
    const glyphHeight = fontSize;

    for (const glyph of glyphs) {
        if (typeof glyph === 'number') {
            advanceText(state, -glyph / 1000 * fontSize * hScale);
            continue;
        }
        if (!glyph || typeof glyph !== 'object') {
            continue;
        }

        const text = getGlyphText(glyph);
        const glyphWidth = getGlyphWidth(glyph) / 1000 * fontSize * hScale;
        const spaceGlyph = isGlyphSpace(glyph, text);
        const textToPage = multiplyMatrices(ctm, state.textMatrix);
        if (state.repositioned && nextActiveWord) {
            const origin = transformPoint(textToPage, 0, 0);
            if (Math.hypot(origin.x - nextActiveWord.penX, origin.y - nextActiveWord.penY)
                > MAX_WORD_GLYPH_GAP_EM * nextActiveWord.emSize) {
                nextActiveWord = flushActiveWord(words, nextActiveWord);
            }
        }
        state.repositioned = false;
        if (spaceGlyph) {
            nextActiveWord = flushActiveWord(words, nextActiveWord);
        } else if (text.length > 0) {
            const box = createPageSpaceBox(state, ctm, glyphWidth, glyphHeight, pageBox);
            if (box) {
                const startOffset = nextActiveWord?.text.length ?? 0;
                nextActiveWord = extendActiveWord(nextActiveWord, {
                    text,
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                    startOffset,
                    endOffset: startOffset + text.length,
                });
                const pen = transformPoint(textToPage, glyphWidth, 0);
                const emTop = transformPoint(textToPage, 0, fontSize);
                const emOrigin = transformPoint(textToPage, 0, 0);
                nextActiveWord.penX = pen.x;
                nextActiveWord.penY = pen.y;
                nextActiveWord.emSize = Math.hypot(emTop.x - emOrigin.x, emTop.y - emOrigin.y);
            }
        }

        const spacing = state.charSpacing + (spaceGlyph ? state.wordSpacing : 0);
        advanceText(state, glyphWidth + spacing * hScale);
    }

    return nextActiveWord;
}

function showTextArgument(
    value: unknown,
    state: ITextState,
    ctm: TMatrix,
    pageBox: IPdfjsPageViewBox,
    words: IOcrWord[],
    activeWord: IActiveWord | null,
) {
    if (!Array.isArray(value)) {
        return activeWord;
    }
    return showGlyphArray(value, state, ctm, pageBox, words, activeWord);
}

function setTextMatrixFromArgs(
    state: ITextState,
    args: readonly unknown[],
) {
    const matrix = matrixFromArgs(args);
    if (!matrix) {
        return;
    }
    state.textMatrix = matrix;
    state.lineMatrix = cloneMatrix(matrix);
}

function moveText(
    state: ITextState,
    x: number,
    y: number,
) {
    state.lineMatrix = translateTextMatrix(state.lineMatrix, x, y);
    state.textMatrix = cloneMatrix(state.lineMatrix);
}

function nextLine(state: ITextState) {
    moveText(state, 0, -state.leading);
}

export function extractPdfjsWordBoxesFromOperatorList(
    operatorList: IPdfjsOperatorListLike,
    pageBox: IPdfjsPageViewBox,
    ops: TPdfjsTextOps,
    options: IExtractPdfjsWordBoxOptions = {},
) {
    const words: IOcrWord[] = [];
    const state = createInitialTextState();
    let ctm = identityMatrix();
    const ctmStack: TMatrix[] = [];
    let activeWord: IActiveWord | null = null;

    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
        options.throwIfAborted?.();
        const op = operatorList.fnArray[index];
        const rawArgs = operatorList.argsArray[index];
        const args = arrayFromUnknownArrayLike(rawArgs) ?? [];

        switch (op) {
            case ops.save:
                ctmStack.push(cloneMatrix(ctm));
                break;
            case ops.restore:
                activeWord = flushActiveWord(words, activeWord);
                ctm = ctmStack.pop() ?? identityMatrix();
                break;
            case ops.transform: {
                const matrix = matrixFromArgs(args);
                if (matrix) {
                    activeWord = flushActiveWord(words, activeWord);
                    ctm = multiplyMatrices(ctm, matrix);
                }
                break;
            }
            case ops.beginText:
                activeWord = flushActiveWord(words, activeWord);
                state.textMatrix = identityMatrix();
                state.lineMatrix = identityMatrix();
                break;
            case ops.endText:
                activeWord = flushActiveWord(words, activeWord);
                break;
            case ops.setCharSpacing:
                state.charSpacing = finiteNumber(args[0], state.charSpacing);
                break;
            case ops.setWordSpacing:
                state.wordSpacing = finiteNumber(args[0], state.wordSpacing);
                break;
            case ops.setHScale:
                state.hScale = finiteNumber(args[0], 100) / 100;
                break;
            case ops.setLeading:
                state.leading = finiteNumber(args[0], state.leading);
                break;
            case ops.setFont:
                state.fontSize = Math.abs(finiteNumber(args[1], state.fontSize));
                break;
            case ops.setTextRise:
                state.textRise = finiteNumber(args[0], state.textRise);
                break;
            case ops.setTextMatrix:
                setTextMatrixFromArgs(state, args);
                state.repositioned = true;
                break;
            case ops.moveText:
                moveText(state, finiteNumber(args[0], 0), finiteNumber(args[1], 0));
                state.repositioned = true;
                break;
            case ops.setLeadingMoveText: {
                const y = finiteNumber(args[1], 0);
                state.leading = -y;
                moveText(state, finiteNumber(args[0], 0), y);
                state.repositioned = true;
                break;
            }
            case ops.nextLine:
                nextLine(state);
                state.repositioned = true;
                break;
            case ops.showText:
            case ops.showSpacedText:
                activeWord = showTextArgument(args[0], state, ctm, pageBox, words, activeWord);
                break;
            case ops.nextLineShowText:
                activeWord = flushActiveWord(words, activeWord);
                nextLine(state);
                activeWord = showTextArgument(args[0], state, ctm, pageBox, words, activeWord);
                break;
            case ops.nextLineSetSpacingShowText:
                activeWord = flushActiveWord(words, activeWord);
                state.wordSpacing = finiteNumber(args[0], state.wordSpacing);
                state.charSpacing = finiteNumber(args[1], state.charSpacing);
                nextLine(state);
                activeWord = showTextArgument(args[2], state, ctm, pageBox, words, activeWord);
                break;
            case undefined:
                break;
            default:
                break;
        }
    }

    flushActiveWord(words, activeWord);
    return words;
}
