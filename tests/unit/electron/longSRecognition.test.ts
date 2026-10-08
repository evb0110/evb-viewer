import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    canRecognizeLongS,
    hasLongSSignature,
    planLongSWordEdits,
} from '@electron/features/ocr/pipeline/longSRecognition';
import {
    parseTsvOcrData,
    readTesseractWords,
} from '@electron/features/ocr/pipeline/tesseractRunner';

const TSV_HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

function readFixtureTsv(name: string) {
    return readFileSync(join(process.cwd(), 'tests/fixtures/electron/early-print', name), 'utf8').trim();
}

function tsvOfLines(lines: string[], confidence = 95) {
    return [
        TSV_HEADER,
        ...lines.flatMap((line, lineIndex) => line.split(' ').map((word, wordIndex) => (
            `5\t1\t1\t1\t${lineIndex + 1}\t${wordIndex + 1}\t${wordIndex * 60}\t${lineIndex * 30}\t50\t20\t${confidence}\t${word}`
        ))),
    ].join('\n');
}

describe('long-s recognition of early printed pages', () => {
    // The 1677 breviary page a user reported: `lat` reads every long s as f.
    const modernTsv = readFixtureTsv('breviary-1677-rubrics.lat.tsv');
    const longSTsv = readFixtureTsv('breviary-1677-rubrics.long-s.tsv');

    it('writes the long s where the long-s models saw it and keeps every real f', () => {
        const words = readTesseractWords(modernTsv);
        expect(hasLongSSignature(words)).toBe(true);
        const before = parseTsvOcrData(modernTsv).text;
        const after = parseTsvOcrData(modernTsv, {}, planLongSWordEdits(words, readTesseractWords(longSTsv))).text;

        for (const word of [
            'feſto',
            'Chriſti',
            'uſque',
            'ſequentibus',
            'Feſtum',
        ]) {
            expect(before).not.toContain(word);
            expect(after).toContain(word);
        }
        expect(after).not.toMatch(/\b(?:fefto|Chrifti|ufque|fequentibus|Feftum)\b/u);
        // "Officium fit Duplex" and "Officium fit de Duplici" print a real f.
        expect(after.match(/\bOfficium fit\b/gu)).toHaveLength(2);
        expect(after.replaceAll('ſ', 'f')).toBe(before);
    });

    it('leaves a modern page as its own model read it', () => {
        const modern = tsvOfLines([
            'The first sessions of the society were held after the harvest,',
            'so the minutes list its founders, their offices and the subjects',
            'discussed: soft soils, fast streams, fishing rights and seasonal fairs.',
            'Several members asked for a fuller survey of these questions first.',
        ]);
        const words = readTesseractWords(modern);
        expect(hasLongSSignature(words)).toBe(false);
    });

    it('ignores a few stray long s the long-s models read on a page that only looked like long-s print', () => {
        const words = readTesseractWords(modernTsv);
        const historical = readTesseractWords(modernTsv).map(word => (
            word.text === 'Trinitatis,' ? {
                ...word,
                text: 'Trinitatiſ,',
            } : word
        ));
        expect(planLongSWordEdits(words, historical)).toEqual([]);
    });

    it('numbers words as Tesseract writes them, low-confidence words included', () => {
        const tsv = [
            TSV_HEADER,
            '5\t1\t1\t1\t1\t1\t0\t0\t40\t20\t95\tin',
            '5\t1\t1\t1\t1\t2\t50\t0\t40\t20\t10\t~',
            '5\t1\t1\t1\t1\t3\t100\t0\t40\t20\t-1\t',
            '5\t1\t1\t1\t1\t4\t150\t0\t60\t20\t95\tfefto',
        ].join('\n');
        expect(readTesseractWords(tsv).map(word => [
            word.ordinal,
            word.text,
        ])).toEqual([
            [
                0,
                'in',
            ],
            [
                1,
                '~',
            ],
            [
                2,
                'fefto',
            ],
        ]);
        expect(parseTsvOcrData(tsv, {}, [{
            word: 2,
            from: 'fefto',
            to: 'feſto',
        }]).text).toBe('in ~ feſto');
    });

    it('runs only for Latin-script languages', () => {
        expect(canRecognizeLongS(['lat'])).toBe(true);
        expect(canRecognizeLongS([
            'eng',
            'deu',
        ])).toBe(true);
        expect(canRecognizeLongS([
            'eng',
            'rus',
        ])).toBe(false);
        expect(canRecognizeLongS(['ell'])).toBe(false);
        expect(canRecognizeLongS([])).toBe(false);
    });
});
