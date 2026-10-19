/** One recognized character with the alternatives Tesseract weighed for it. */
export interface IHocrChar {
    text: string;
    confidence: number;
    left: number;
    right: number;
    /** Alternative characters and their confidence, 0 to 100. */
    choices: ReadonlyMap<string, number>;
}

export interface IHocrWord {chars: IHocrChar[];}

export interface IHocrLine {
    box: readonly [number, number, number, number];
    /** Tesseract's estimate of the line's letter height, in pixels. */
    letterHeight: number;
    words: IHocrWord[];
}

const LINE_START = /<span class='ocr_(?:line|header|textfloat|caption)' id='[^']*' title="([^"]*)"/gu;
const CHAR = /<span class='ocrx_cinfo' title='x_bboxes (\d+) (\d+) (\d+) (\d+); x_conf ([\d.]+)'>([^<]*)<\/span>(\s*<span class='ocrx_cinfo' id='lstm_choices[^']*'>(?:\s*<span class='ocrx_cinfo' id='choice[^']*' title='x_confs [\d.]+'>[^<]*<\/span>)*\s*<\/span>)?/gu;
const CHOICE = /x_confs ([\d.]+)'>([^<]*)</gu;
const BOX = /bbox (\d+) (\d+) (\d+) (\d+)/u;
const LETTER_HEIGHT = /x_size ([\d.]+)/u;

const ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': '\'',
};

function unescapeHocr(text: string) {
    return text.replace(/&(?:amp|lt|gt|quot|#39);/gu, entity => ENTITIES[entity]!).normalize('NFC');
}

/**
 * Reads the lines of Tesseract's hOCR written with `hocr_char_boxes` and,
 * optionally, `lstm_choice_mode=2`. Words come in Tesseract's order, the order
 * of the TSV's non-empty words.
 */
export function readHocrLines(hocr: string): IHocrLine[] {
    const starts = [...hocr.matchAll(LINE_START)];
    const lines: IHocrLine[] = [];
    starts.forEach((start, index) => {
        const title = start[1]!;
        const box = title.match(BOX);
        if (!box) return;
        const chunk = hocr.slice(start.index, starts[index + 1]?.index ?? hocr.length);
        const words: IHocrWord[] = [];
        for (const wordChunk of chunk.split('<span class=\'ocrx_word\'').slice(1)) {
            const chars: IHocrChar[] = [];
            for (const match of wordChunk.matchAll(CHAR)) {
                const choices = new Map<string, number>();
                for (const choice of (match[7] ?? '').matchAll(CHOICE)) {
                    const text = unescapeHocr(choice[2]!);
                    choices.set(text, Math.max(choices.get(text) ?? 0, Number(choice[1])));
                }
                // A character Tesseract composed from several code points keeps one slot each.
                [...unescapeHocr(match[6]!)].forEach((text, part) => chars.push({
                    text,
                    confidence: Number(match[5]),
                    left: Number(match[1]),
                    right: Number(match[3]),
                    choices: part === 0 ? choices : new Map(),
                }));
            }
            if (chars.length > 0) words.push({chars});
        }
        if (words.length === 0) return;
        lines.push({
            box: [
                Number(box[1]),
                Number(box[2]),
                Number(box[3]),
                Number(box[4]),
            ],
            letterHeight: Number(title.match(LETTER_HEIGHT)?.[1] ?? Number(box[4]) - Number(box[2])),
            words,
        });
    });
    return lines;
}

export function hocrWordText(word: IHocrWord) {
    return word.chars.map(char => char.text).join('');
}
