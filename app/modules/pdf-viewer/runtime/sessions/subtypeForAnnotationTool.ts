import type {
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';

export const markupSubtypeByAnnotationTool: Partial<Record<TAnnotationTool, TMarkupSubtype>> = {
    highlight: 'Highlight',
    underline: 'Underline',
    strikethrough: 'StrikeOut',
    squiggly: 'Squiggly',
};

export function subtypeForAnnotationTool(tool: TAnnotationTool): TMarkupSubtype {
    return markupSubtypeByAnnotationTool[tool] ?? 'Highlight';
}
