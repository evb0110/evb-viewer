import type {
    Except,
    LiteralUnion,
} from 'type-fest';
import * as v from 'valibot';

export type TPdfSaveMode = 'incremental' | 'rewrite' | 'save_as_rewrite';

export type TPdfaPart = '1' | '2' | '3' | '4';
export type TPdfaConformance = 'A' | 'B' | 'E' | 'F' | 'U';
export type TPdfaLevel = LiteralUnion<`PDF/A-${TPdfaPart}${TPdfaConformance}`, string>;

export interface IPdfConformanceProfile {
    isSigned: boolean;
    isEncrypted: boolean;
    isTagged: boolean;
    pdfaLevel: TPdfaLevel | null;
    hasAcroForm: boolean;
    hasXfa: boolean;
    canIncrementalSave: boolean;
    saveRestrictions: string[];
}

export interface IPdfConformanceAnalysisOptions {purpose?: 'full' | 'save-restrictions';}

export type TPdfConformanceProfileBase = Except<IPdfConformanceProfile, 'saveRestrictions'>;

export const PDF_VALIDATION_RESULT_SCHEMA = v.object({
    isValid: v.boolean(),
    tool: v.picklist([
        'qpdf',
        'browser',
        'native',
    ]),
    errors: v.pipe(v.array(v.string()), v.readonly()),
    warnings: v.pipe(v.array(v.string()), v.readonly()),
});
export type IPdfValidationResult = v.InferOutput<typeof PDF_VALIDATION_RESULT_SCHEMA>;
