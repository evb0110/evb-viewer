import {
    compact,
    partition,
    uniq,
} from 'es-toolkit/array';
import { isRtlOcrLanguage } from '@contracts/ocrLanguages';

const LATIN_WORD_BOUNDARY_CONFIG = [
    '-c',
    'preserve_interword_spaces=1',
    '-c',
    'textord_words_default_minspace=0.3',
    '-c',
    'textord_words_min_minspace=0.2',
    '-c',
    'tosp_fuzzy_space_factor=0.5',
    '-c',
    'tosp_min_sane_kn_sp=1.2',
    '-c',
    'tosp_kern_gap_factor1=1.5',
    '-c',
    'tosp_kern_gap_factor2=1.0',
] as const satisfies readonly string[];

const LATIN_DICTIONARY_DISABLED_CONFIG = [
    '-c',
    'load_system_dawg=0',
    '-c',
    'load_freq_dawg=0',
] as const satisfies readonly string[];

const RTL_CONFIG = [] as const satisfies readonly string[];

interface ITesseractLanguageConfig {
    orderedLanguages: string[];
    extraConfigArgs: string[];
    hasRtl: boolean;
}

interface ITesseractLanguageConfigOptions { preserveDictionaries?: boolean; }

export function resolveTesseractLanguageConfig(
    languages: string[],
    options: ITesseractLanguageConfigOptions = {},
): ITesseractLanguageConfig {
    const deduped = uniq(compact(languages));
    const hasRtl = deduped.some(isRtlOcrLanguage);

    if (!hasRtl) {
        return {
            orderedLanguages: deduped,
            extraConfigArgs: [
                ...LATIN_WORD_BOUNDARY_CONFIG,
                ...(options.preserveDictionaries ? [] : LATIN_DICTIONARY_DISABLED_CONFIG),
            ],
            hasRtl: false,
        };
    }

    const [
        rtlLanguages,
        nonRtlLanguages,
    ] = partition(deduped, isRtlOcrLanguage);
    const rtlFirst = [
        ...rtlLanguages,
        ...nonRtlLanguages,
    ];

    return {
        orderedLanguages: rtlFirst,
        extraConfigArgs: [...RTL_CONFIG],
        hasRtl: true,
    };
}
