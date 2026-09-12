import { readFileSync } from 'fs';
import { join } from 'path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { AVAILABLE_OCR_LANGUAGES } from '@contracts/ocrLanguages';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const OCR_BENCHMARK_SCRIPT = 'scripts/devkit/ocr-profile-benchmark.py';
const OCR_LANGUAGE_PAGE = 'docs/user/formats-and-languages.md';

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

function getDocumentedOcrLanguageSection(page: string) {
    const match = /### OCR Languages\n\n([\s\S]*?)(?:\n### |\n## |$)/u.exec(page);
    if (!match?.[1]) {
        throw new Error(`OCR Languages section was not found in ${OCR_LANGUAGE_PAGE}`);
    }
    return match[1];
}

function getDisplayName(code: string) {
    if (!(code in OCR_LANGUAGE_DISPLAY_NAMES)) {
        throw new Error(`Missing README display-name expectation for OCR language ${code}`);
    }
    return OCR_LANGUAGE_DISPLAY_NAMES[code];
}

// The benchmark's default matrix is the source of truth for which profile names a
// reader can pass, so the notes are checked against it instead of against a list
// copied out of the prose.
function getBenchmarkDefaultProfiles() {
    const script = readFileSync(join(REPO_ROOT, OCR_BENCHMARK_SCRIPT), 'utf-8');
    const match = /^DEFAULT_PROFILES\s*=\s*\(([^)]*)\)/mu.exec(script);
    if (!match?.[1]) {
        throw new Error(`DEFAULT_PROFILES was not found in ${OCR_BENCHMARK_SCRIPT}`);
    }
    const profiles = [...match[1].matchAll(/"([^"]+)"/gu)].map(quoted => quoted[1]);
    if (profiles.length === 0) {
        throw new Error(`DEFAULT_PROFILES in ${OCR_BENCHMARK_SCRIPT} lists no profile`);
    }
    return profiles;
}

describe('OCR documentation', () => {
    it('keeps the documented OCR language list aligned with the registry', () => {
        const page = readFileSync(join(REPO_ROOT, OCR_LANGUAGE_PAGE), 'utf-8');
        const section = getDocumentedOcrLanguageSection(page);

        for (const language of AVAILABLE_OCR_LANGUAGES) {
            expect(section).toContain(`- ${getDisplayName(language.code)}`);
        }
    });

    it('documents every profile the benchmark runs by default', () => {
        const ocrNotes = readFileSync(join(REPO_ROOT, 'docs/architecture/ocr.md'), 'utf-8');

        for (const profile of getBenchmarkDefaultProfiles()) {
            expect(ocrNotes, `docs/architecture/ocr.md does not document the \`${profile}\` profile`)
                .toContain(`\`${profile}\``);
        }
    });
});
