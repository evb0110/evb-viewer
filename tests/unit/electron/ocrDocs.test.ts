import { readFileSync } from 'fs';
import { join } from 'path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { AVAILABLE_OCR_LANGUAGES } from '@contracts/ocrLanguages';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const OCR_LANGUAGE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
    eng: 'English',
    fra: 'French',
    spa: 'Spanish',
    por: 'Portuguese',
    ita: 'Italian',
    nld: 'Dutch',
    deu: 'German',
    pol: 'Polish',
    ces: 'Czech',
    slk: 'Slovak',
    hun: 'Hungarian',
    ron: 'Romanian',
    swe: 'Swedish',
    dan: 'Danish',
    nor: 'Norwegian',
    fin: 'Finnish',
    hrv: 'Croatian',
    ind: 'Indonesian',
    vie: 'Vietnamese',
    tur: 'Turkish',
    ell: 'Greek',
    grc: 'Ancient Greek',
    kmr: 'Kurdish (Kurmanji)',
    rus: 'Russian',
    ukr: 'Ukrainian',
    bul: 'Bulgarian',
    srp: 'Serbian (Cyrillic)',
    ara: 'Arabic',
    heb: 'Hebrew',
    syr: 'Syriac',
};

const OCR_LANGUAGE_DOC = 'docs/user/formats-and-languages.md';

function getOcrLanguageSection(doc: string) {
    const match = /### OCR Languages\n\n([\s\S]*?)(?:\n### |\n## )/u.exec(doc);
    if (!match?.[1]) {
        throw new Error(`OCR Languages section was not found in ${OCR_LANGUAGE_DOC}`);
    }
    return match[1];
}

function getDisplayName(code: string) {
    if (!(code in OCR_LANGUAGE_DISPLAY_NAMES)) {
        throw new Error(`Missing display-name expectation for OCR language ${code}`);
    }
    return OCR_LANGUAGE_DISPLAY_NAMES[code];
}

describe('OCR documentation', () => {
    it('keeps the published OCR language list aligned with the registry', () => {
        const doc = readFileSync(join(REPO_ROOT, OCR_LANGUAGE_DOC), 'utf-8');
        const section = getOcrLanguageSection(doc);

        for (const language of AVAILABLE_OCR_LANGUAGES) {
            expect(section).toContain(`- ${getDisplayName(language.code)}`);
        }
    });

});
