import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createEarlyPrintDictionary} from '@electron/features/ocr/pipeline/earlyPrintReading';

// TessdataManager component numbers (tessdatamanager.h).
const LSTM_SYSTEM_DAWG = 19;
const LSTM_UNICHARSET = 21;
const DAWG_MAGIC = 42;
const DAWG_FLAG_BITS = 3n;
const MARKER_FLAG = 1n;
const BACKWARD_FLAG = 2n;
const WORD_END_FLAG = 4n;
const MAX_TRAINEDDATA_BYTES = 256 * 1024 * 1024;
const MAX_WORDS = 2_000_000;
// A corrupt dictionary can point an edge back up its own path.
const MAX_WORD_LENGTH = 256;
const MAX_EDGE_VISITS = 64_000_000;

function component(data: Buffer, index: number) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const entries = view.getInt32(0, true);
    if (entries <= index || 4 + 8 * entries > data.byteLength) return null;
    const offsets = Array.from({length: entries}, (_, entry) => Number(view.getBigInt64(4 + 8 * entry, true)));
    const start = offsets[index]!;
    if (start < 0) return null;
    const end = offsets.slice(index + 1).find(offset => offset >= 0) ?? data.byteLength;
    if (start > end || end > data.byteLength) throw new Error('Corrupt traineddata component table');
    return data.subarray(start, end);
}

/**
 * The words of a model's LSTM dictionary, as Tesseract's `dawg2wordlist`
 * prints them: a SquishedDawg over the model's LSTM unicharset. Null when the
 * model carries no dictionary.
 */
export async function readTraineddataWordList(path: string): Promise<string[] | null> {
    const data = await readFile(path);
    if (data.byteLength > MAX_TRAINEDDATA_BYTES) throw new Error('traineddata file exceeds the size limit');
    const unicharsetBytes = component(data, LSTM_UNICHARSET);
    const dawgBytes = component(data, LSTM_SYSTEM_DAWG);
    if (!unicharsetBytes || !dawgBytes || dawgBytes.byteLength < 10) return null;

    const unicharsetLines = unicharsetBytes.toString('utf8').split('\n');
    const unichars = unicharsetLines.slice(1, 1 + Number(unicharsetLines[0])).map((line) => {
        const unichar = line.split(' ')[0] ?? '';
        return unichar === 'NULL' ? ' ' : unichar;
    });
    const view = new DataView(dawgBytes.buffer, dawgBytes.byteOffset, dawgBytes.byteLength);
    if (view.getInt16(0, true) !== DAWG_MAGIC) throw new Error('traineddata dictionary has a bad magic number');
    const unicharsetSize = view.getInt32(2, true);
    const edgeCount = view.getInt32(6, true);
    if (unicharsetSize <= 0 || edgeCount <= 0 || 10 + 8 * edgeCount > dawgBytes.byteLength) {
        throw new Error('traineddata dictionary is truncated');
    }
    const flagStart = BigInt(Math.ceil(Math.log2(unicharsetSize + 1)));
    const letterMask = (1n << flagStart) - 1n;
    const nextNodeShift = flagStart + DAWG_FLAG_BITS;
    const edge = (index: number) => view.getBigUint64(10 + 8 * index, true);

    // Each node's forward edges are contiguous and the last one carries the marker.
    const words: string[] = [];
    const stack: Array<{
        edge: number;
        depth: number
    }> = [{
        edge: 0,
        depth: 0,
    }];
    const prefix: string[] = [];
    let visits = 0;
    while (stack.length > 0) {
        const {
            edge: index, depth,
        } = stack.pop()!;
        if (index >= edgeCount) continue;
        if (depth >= MAX_WORD_LENGTH || ++visits > MAX_EDGE_VISITS) {
            throw new Error('traineddata dictionary is corrupt: its words do not end');
        }
        const record = edge(index);
        if ((record & MARKER_FLAG << flagStart) === 0n) stack.push({
            edge: index + 1,
            depth,
        });
        if ((record & BACKWARD_FLAG << flagStart) !== 0n) continue;
        prefix.length = depth;
        prefix.push(unichars[Number(record & letterMask)] ?? '');
        if ((record & WORD_END_FLAG << flagStart) !== 0n) {
            words.push(prefix.join(''));
            if (words.length > MAX_WORDS) throw new Error('traineddata dictionary exceeds the word limit');
        }
        const next = Number(record >> nextNodeShift);
        if (next !== 0) stack.push({
            edge: next,
            depth: depth + 1,
        });
    }
    return words;
}

const dictionaries = new Map<string, Promise<ReadonlySet<string>>>();
const MAX_CACHED_DICTIONARIES = 2;

/**
 * The early-print dictionary of the selected languages: the union of their
 * models' word lists, loaded once per set of languages.
 */
export function loadEarlyPrintDictionary(tessdataPath: string, languages: readonly string[]) {
    const codes = [...new Set(languages)].sort();
    const key = `${tessdataPath}\0${codes.join('+')}`;
    let dictionary = dictionaries.get(key);
    if (!dictionary) {
        dictionary = (async () => {
            const lists = await Promise.all(codes.map(code => readTraineddataWordList(join(tessdataPath, `${code}.traineddata`))));
            return createEarlyPrintDictionary(lists.flatMap(list => list ?? []), codes.includes('lat'));
        })();
        dictionary.catch(() => dictionaries.delete(key));
        dictionaries.set(key, dictionary);
        while (dictionaries.size > MAX_CACHED_DICTIONARIES) dictionaries.delete(dictionaries.keys().next().value!);
    }
    return dictionary;
}
