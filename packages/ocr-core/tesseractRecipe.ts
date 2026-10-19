import type { IOcrSearchablePdfOptions } from '@contracts/electronApiOcr';
import {
    AGENT_OCR_PAGE_SEGMENTATION_MODES,
    isSupportedPageSegmentationMode,
} from '@contracts/agentOcr';
import { isGreekOcrLanguage } from '@contracts/ocrLanguages';
import { resolveTesseractLanguageConfig } from '@ocr-core/resolveTesseractLanguageConfig';

/**
 * The Tesseract command line every OCR pass runs, on desktop (the native
 * binary) and in the browser (the same program compiled to WebAssembly). Both
 * hosts build it here so they recognize with identical settings: Tesseract's
 * library defaults differ from its command line's, so a host that configured
 * the engine itself would read differently.
 */

export interface ITesseractOutputs {
    pdf?: boolean;
    tsv?: boolean;
    /** hOCR with each character's box and the alternatives Tesseract weighed. */
    hocr?: boolean;
}

export interface ITesseractPass {
    imagePath: string;
    /** Tesseract writes `<outputBase>.pdf`, `.tsv` and `.hocr`. */
    outputBase: string;
    languages: readonly string[];
    tessdataPath: string;
    dpi: number;
    options?: IOcrSearchablePdfOptions | undefined;
    outputs: ITesseractOutputs;
}

function shouldPreserveDictionaries(options: IOcrSearchablePdfOptions | undefined) {
    return options?.qualityProfile === 'accurate';
}

export function shouldNormalizeGreekMicroSign(languages: readonly string[]) {
    return languages.some(isGreekOcrLanguage);
}

function buildTesseractProfileArgs(options: IOcrSearchablePdfOptions | undefined) {
    const args: string[] = [];
    if (typeof options?.pageSegmentationMode === 'number') {
        if (!isSupportedPageSegmentationMode(options.pageSegmentationMode)) {
            throw new Error(
                `Tesseract page segmentation mode must be one of: ${AGENT_OCR_PAGE_SEGMENTATION_MODES.join(', ')}`,
            );
        }
        args.push('--psm', String(options.pageSegmentationMode));
    }
    if (options?.qualityProfile === 'poor-scan') {
        args.push('-c', 'thresholding_method=2');
    }
    return args;
}

export function buildTesseractArgs(pass: ITesseractPass) {
    const languageConfig = resolveTesseractLanguageConfig([...pass.languages], {preserveDictionaries: shouldPreserveDictionaries(pass.options)});
    return [
        pass.imagePath,
        pass.outputBase,
        '-l',
        languageConfig.orderedLanguages.join('+'),
        '--tessdata-dir',
        pass.tessdataPath,
        '--dpi',
        String(pass.dpi),
        ...languageConfig.extraConfigArgs,
        ...buildTesseractProfileArgs(pass.options),
        ...(pass.outputs.tsv ? [
            '-c',
            'tessedit_create_tsv=1',
        ] : []),
        ...(pass.outputs.pdf ? [
            '-c',
            'tessedit_create_pdf=1',
            '-c',
            'textonly_pdf=1',
        ] : []),
        ...(pass.outputs.hocr ? [
            '-c',
            'tessedit_create_hocr=1',
            '-c',
            'hocr_char_boxes=1',
            '-c',
            'lstm_choice_mode=2',
        ] : []),
    ];
}

// Tesseract exits 0 when it rejects a -c parameter, so a profile whose option
// the engine does not know would otherwise run silently without it.
export function findUnsupportedTesseractOptions(stderrText: string) {
    return [...stderrText.matchAll(/^Could not set option: (.+)$/gmu)].map(match => match[1]!.trim());
}
