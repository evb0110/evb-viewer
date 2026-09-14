import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

type TOcrLanguageScript = 'latin' | 'cyrillic' | 'greek' | 'rtl';

export interface IOcrLanguage {
    code: TOcrLanguageCode;
    script: TOcrLanguageScript;
    modelState?: 'installed' | 'downloading' | 'missing';
}

const OCR_LANGUAGE_SCRIPTS = [
    'latin',
    'cyrillic',
    'greek',
    'rtl',
] as const satisfies readonly TOcrLanguageScript[];
const OCR_LANGUAGE_MAX_COUNT = 128;
const OCR_LANGUAGE_CODE_MAX_LENGTH = 32;
const OCR_LANGUAGE_MODEL_STATES = [
    'installed',
    'downloading',
    'missing',
] as const;

export function decodeOcrLanguages(value: unknown): IOcrLanguage[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.length > OCR_LANGUAGE_MAX_COUNT) {
        return null;
    }
    const languages: IOcrLanguage[] = [];
    const codes = new Set<string>();
    for (const candidate of value) {
        if (
            !isRecord(candidate)
            || typeof candidate.code !== 'string'
            || candidate.code.length > OCR_LANGUAGE_CODE_MAX_LENGTH
            || !/^[a-z][a-z0-9_]*$/u.test(candidate.code)
            || !isAvailableOcrLanguageCode(candidate.code)
            || typeof candidate.script !== 'string'
            || !isOneOf(OCR_LANGUAGE_SCRIPTS, candidate.script)
            || (candidate.modelState !== undefined && !isOneOf(OCR_LANGUAGE_MODEL_STATES, candidate.modelState))
            || codes.has(candidate.code)
        ) {
            return null;
        }
        codes.add(candidate.code);
        languages.push({
            code: candidate.code,
            script: candidate.script,
            ...(candidate.modelState === undefined ? {} : {modelState: candidate.modelState}),
        });
    }
    return languages;
}

export const AVAILABLE_OCR_LANGUAGES = [
    {
        code: 'eng',
        script: 'latin',
    },
    {
        code: 'fra',
        script: 'latin',
    },
    {
        code: 'spa',
        script: 'latin',
    },
    {
        code: 'por',
        script: 'latin',
    },
    {
        code: 'ita',
        script: 'latin',
    },
    {
        code: 'nld',
        script: 'latin',
    },
    {
        code: 'deu',
        script: 'latin',
    },
    {
        code: 'pol',
        script: 'latin',
    },
    {
        code: 'ces',
        script: 'latin',
    },
    {
        code: 'slk',
        script: 'latin',
    },
    {
        code: 'hun',
        script: 'latin',
    },
    {
        code: 'ron',
        script: 'latin',
    },
    {
        code: 'swe',
        script: 'latin',
    },
    {
        code: 'dan',
        script: 'latin',
    },
    {
        code: 'nor',
        script: 'latin',
    },
    {
        code: 'fin',
        script: 'latin',
    },
    {
        code: 'hrv',
        script: 'latin',
    },
    {
        code: 'ind',
        script: 'latin',
    },
    {
        code: 'vie',
        script: 'latin',
    },
    {
        code: 'tur',
        script: 'latin',
    },
    {
        code: 'ell',
        script: 'greek',
    },
    {
        code: 'grc',
        script: 'greek',
    },
    {
        code: 'kmr',
        script: 'latin',
    },
    {
        code: 'rus',
        script: 'cyrillic',
    },
    {
        code: 'ukr',
        script: 'cyrillic',
    },
    {
        code: 'bul',
        script: 'cyrillic',
    },
    {
        code: 'srp',
        script: 'cyrillic',
    },
    {
        code: 'ara',
        script: 'rtl',
    },
    {
        code: 'heb',
        script: 'rtl',
    },
    {
        code: 'syr',
        script: 'rtl',
    },
] as const satisfies ReadonlyArray<{
    code: string;
    script: TOcrLanguageScript;
}>;

export type TOcrLanguageCode = (typeof AVAILABLE_OCR_LANGUAGES)[number]['code'];

// isAvailableOcrLanguageCode narrows to TOcrLanguageCode, so a caller able to
// add to this set could mint that type for any string.
export const AVAILABLE_OCR_LANGUAGE_CODES: ReadonlySet<string> = new Set<string>(
    AVAILABLE_OCR_LANGUAGES.map(language => language.code),
);

export function isAvailableOcrLanguageCode(value: unknown): value is TOcrLanguageCode {
    return typeof value === 'string' && AVAILABLE_OCR_LANGUAGE_CODES.has(value);
}

/** SHA-256 digests for the exact tessdata_best commit used by runtime downloads. */
export const OCR_LANGUAGE_MODEL_SHA256 = {
    ara: 'ab9d157d8e38ca00e7e39c7d5363a5239e053f5b0dbdb3167dde9d8124335896',
    bul: '87322f07ae023d0f61d3c12507f6f1ed22411c00f1b2e722d2e13b723584fad1',
    ces: 'd821773116d3c4e0360ea750066436c60ae45af02c39da3a840a543d761b3f41',
    dan: '28901bf4b58a657b511fddafce4ce245a1f21c5ee075734b479d01ab8d4cb6a5',
    deu: '8407331d6aa0229dc927685c01a7938fc5a641d1a9524f74838cdac599f0d06e',
    ell: '288b4ea00bab450cf39893d22f04a2835a8469b673b5b20dcb39b159d1bbc9b8',
    eng: '8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba',
    fin: '96745dd0900fe997541516863d859616df6120430db546424feae72923828423',
    fra: '907743d98915c91a3906dfbf6e48b97598346698fe53aaa797e1a064ffcac913',
    grc: 'dfc9bda286cd9d8755b1832e5731a5425d1cf0803393a5fa6dee078466178cf1',
    heb: 'dbaa827aea6bc21215638447f17783a1004987c2d0bf5573d111fee397abdae5',
    hrv: 'a46566f0a1442502028bc0c35f043bc1780cc80e8567ec1b1df13d685c47215e',
    hun: '08786ad5fe25d502d1cfcdf606ba215f320409a1630109582fa1a38d93b3e32d',
    ind: '1f6596041ffb4cd5094e5f98764db43cfde04edb8f02b988f90ebc1353ac73b8',
    ita: '8df9c89176fb93f56bf4b2d4ede04c01c1f31d4b7697fbd76cc336df700f3f38',
    kmr: '6017f6284e6771419f85a72218a2e84c5c6c19a4ed0ef27286cd637981293b76',
    nld: '92e7a1ad4bf8082e268de57c7823316ec024935702c6ed2a1e473b3a071aa733',
    nor: '451d52ba1559aa1aecf163ccbfdeced2b9605fbd49480f5e8a53ace29b9eb0e7',
    pol: 'e80cc4cefbdface06e9223f43f089556b9dcf104020fbc0a200f6863c57d4405',
    por: '711de9dbb8052067bd42f16b9119967f30bada80d57e2ef24f65d09f531adb04',
    ron: '93588d7e59a28fad7920db07767345438ee5eeefa3c5f20541dfb9ad083a6d2e',
    rus: 'b617eb6830ffabaaa795dd87ea7fd251adfe9cf0efe05eb9a2e8128b7728d6b6',
    slk: '3553e335f64408412c8741fec19e443b5fda81d88abe59aa1401cba4e8825bed',
    spa: 'e2c1ffdad8b30f26c45d4017a9183d3a7f9aa69e59918be4f88b126fac99ab2c',
    srp: 'b090f9bb22366d9b4b0cb6baa2136c4f75e992ddba01ecb78240896e359e4072',
    swe: '360303308aa5d4a912ac3b3637691152b7532d9bd6e960639db1affb83db7ea9',
    syr: '7642168b7731866d0ec4c74c67780913db4a04583874fcff0078daa8430bd887',
    tur: 'e0c3338dc17503dc7d335a507c9ae01b2b46cfd07561171e1e1ac55d85e8e438',
    ukr: '1277f6e3b6f707063a92d40e7678e7f57154e8414e328e340be9ee9275eea9c8',
    vie: 'b6b49293d95d0b6dbd8780174627e82c75be957b6f4ed9862155540d6b00bb45',
} as const satisfies Record<TOcrLanguageCode, string>;

/** Models seeded into an offline installation; every other supported model is downloaded on demand. */
export const BUNDLED_OCR_LANGUAGE_CODES = [
    'eng',
    'rus',
] as const satisfies readonly TOcrLanguageCode[];

export const BUNDLED_OCR_LANGUAGE_CODE_SET = new Set<string>(BUNDLED_OCR_LANGUAGE_CODES);

export const RTL_OCR_LANGUAGE_CODES = new Set<string>(
    AVAILABLE_OCR_LANGUAGES
        .filter(language => language.script === 'rtl')
        .map(language => language.code),
);

export const GREEK_OCR_LANGUAGE_CODES = new Set<string>(
    AVAILABLE_OCR_LANGUAGES
        .filter(language => language.script === 'greek')
        .map(language => language.code),
);

export function isRtlOcrLanguage(code: string) {
    return RTL_OCR_LANGUAGE_CODES.has(code);
}

export function isGreekOcrLanguage(code: string) {
    return GREEK_OCR_LANGUAGE_CODES.has(code);
}
