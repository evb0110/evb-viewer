import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    canReadEarlyPrint,
    createEarlyPrintDictionary,
    hasLongSSignature,
    planEarlyPrintWordEdits,
} from '@electron/features/ocr/pipeline/earlyPrintReading';
import {
    hocrWordText,
    readHocrLines,
    type IHocrLine,
} from '@electron/features/ocr/pipeline/hocrReading';
import {readTraineddataWordList} from '@electron/features/ocr/pipeline/traineddataWordList';
import type {IOcrWordEdit} from '@electron/features/ocr/pipeline/types';

const FIXTURES = join(process.cwd(), 'tests/fixtures/electron/early-print');

function readReading(model: string) {
    return readHocrLines(gunzipSync(readFileSync(join(FIXTURES, `breviary-1677-rubrics.${model}.hocr.gz`))).toString('utf8'));
}

function pageText(lines: readonly IHocrLine[], edits: readonly IOcrWordEdit[] = []) {
    const edited = new Map(edits.map(edit => [
        edit.word,
        edit.to,
    ]));
    let ordinal = 0;
    return lines.map(line => line.words.map(word => edited.get(ordinal++) ?? hocrWordText(word)).join(' ')).join('\n');
}

const words = (text: string) => text.replace(/-\n/gu, '').match(/[\p{L}&]+/gu) ?? [];

/** Share of the transcription's words a reading has, in order. */
function wordsReadRight(transcription: string, reading: string) {
    const expected = words(transcription);
    const read = words(reading);
    let previous = new Array<number>(read.length + 1).fill(0);
    for (const word of expected) {
        const current = [0];
        read.forEach((candidate, index) => {
            current.push(candidate === word ? previous[index]! + 1 : Math.max(previous[index + 1]!, current[index]!));
        });
        previous = current;
    }
    return previous[read.length]! / expected.length;
}

describe('early-print reading', () => {
    // The 1677 breviary a user reported, read by `lat`, `ita_old` and `fra`.
    // The dictionary is the part of `lat`'s that these readings look up.
    const transcription = readFileSync(join(FIXTURES, 'breviary-1677-rubrics.gt.txt'), 'utf8');
    const dictionary = createEarlyPrintDictionary(
        readFileSync(join(FIXTURES, 'breviary-1677-rubrics.dictionary.txt'), 'utf8').split('\n'),
        true,
    );
    const readings = () => ({
        base: readReading('lat'),
        longS: readReading('ita_old'),
        ligatures: readReading('fra'),
    });

    it('reads the long s, æ, œ and the ct ligature as the page prints them', () => {
        const {
            base, ...others
        } = readings();
        expect(hasLongSSignature(base.flatMap(line => line.words.map(hocrWordText)))).toBe(true);
        const before = pageText(base);
        const after = pageText(base, planEarlyPrintWordEdits({
            base,
            ...others,
        }, dictionary, {latin: true}));

        for (const word of [
            'uſque',
            'Paſchæ',
            'Cœna',
            'Chriſti',
            'feſto',
            'Eccleſiæ',
            'hæc',
            'Sanctorum',
            'Defunctorum',
            'depoſitionis',
            'prædicta',
        ]) {
            expect(before).not.toContain(word);
            expect(after).toContain(word);
        }
        expect(after).not.toMatch(/ufque|Pafchz|Ecclefix|Defun&torum|San&torum/u);
        // "Officium fit Duplex" and "Officium fit de Duplici" print a real f.
        expect(after.match(/\bOfficium fit\b/gu)).toHaveLength(2);
        // `lat` alone reads 72% of the transcription's words; the three models 94%.
        expect(wordsReadRight(transcription, before)).toBeLessThan(0.75);
        expect(wordsReadRight(transcription, after)).toBeGreaterThan(0.92);
    });

    it('keeps the page as its own model read it when the early-print model finds no long s', () => {
        const {
            base, ligatures,
        } = readings();
        expect(planEarlyPrintWordEdits({
            base,
            longS: base,
            ligatures,
        }, dictionary, {latin: true})).toEqual([]);
    });

    it('sees long-s print only where f outnumbers s inside words', () => {
        expect(hasLongSSignature('The first of these is so set as to suffer the least stress of us all'.repeat(3).split(' '))).toBe(false);
        expect(hasLongSSignature('ufque fefto Chrifti feftum eft nifi fint fed'.repeat(4).split(' '))).toBe(true);
    });

    it('reads early print in Latin-script languages only', () => {
        expect(canReadEarlyPrint(['lat'])).toBe(true);
        expect(canReadEarlyPrint([
            'lat',
            'eng',
        ])).toBe(true);
        expect(canReadEarlyPrint([
            'lat',
            'ell',
        ])).toBe(false);
        expect(canReadEarlyPrint([])).toBe(false);
    });
});

describe('traineddata word lists', () => {
    it('reads the dictionary Tesseract packed into a model', async () => {
        // Built with wordlist2dawg and combine_tessdata from eight words.
        expect((await readTraineddataWordList(join(FIXTURES, 'eight-latin-words.traineddata')))?.sort()).toEqual([
            'Domini',
            'Dominica',
            'Octava',
            'Octavam',
            'Paschae',
            'eodem',
            'festo',
            'à',
        ]);
    });
});
