import {isRtlOcrLanguage} from '@contracts/ocrLanguages';

export function hasRtlOcrLanguage(languages: readonly string[]) {
    return languages.some(isRtlOcrLanguage);
}
