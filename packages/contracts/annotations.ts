export const ANNOTATION_TOOLS = [
    'none',
    'select',
    'highlight',
    'underline',
    'strikethrough',
    'squiggly',
    'text',
    'note',
    'draw',
    'rectangle',
    'circle',
    'line',
    'arrow',
    'stamp',
] as const;

export const DRAWABLE_SHAPE_TOOLS = [
    'draw',
    'rectangle',
    'circle',
    'line',
    'arrow',
] as const satisfies ReadonlyArray<typeof ANNOTATION_TOOLS[number]>;

export const PDF_ANNOTATION_MARKUP_SUBTYPES = [
    'Highlight',
    'Underline',
    'StrikeOut',
    'Squiggly',
] as const;

export const PDF_ANNOTATION_SHAPE_TYPES = [
    'rectangle',
    'circle',
    'line',
    'arrow',
    'polyline',
    'polygon',
] as const;

export const PDF_ANNOTATION_SHAPE_PDF_SUBTYPES = [
    'Square',
    'Circle',
    'Line',
    'PolyLine',
    'Polygon',
    'Ink',
] as const;

export const PDF_ANNOTATION_LINE_END_STYLES = [
    'none',
    'openArrow',
    'closedArrow',
] as const;

export type TAnnotationTool = typeof ANNOTATION_TOOLS[number];
export type TDrawableShapeTool = typeof DRAWABLE_SHAPE_TOOLS[number];
export type TPdfAnnotationMarkupSubtype = typeof PDF_ANNOTATION_MARKUP_SUBTYPES[number];
export type TPdfAnnotationShapeType = typeof PDF_ANNOTATION_SHAPE_TYPES[number];
export type TPdfAnnotationShapePdfSubtype = typeof PDF_ANNOTATION_SHAPE_PDF_SUBTYPES[number];
export type TPdfAnnotationLineEndStyle = typeof PDF_ANNOTATION_LINE_END_STYLES[number];

const MARKUP_SUBTYPE_ALIASES = {
    highlight: 'Highlight',
    underline: 'Underline',
    strikeout: 'StrikeOut',
    strikethrough: 'StrikeOut',
    squiggly: 'Squiggly',
} as const satisfies Record<string, TPdfAnnotationMarkupSubtype>;

export function parseMarkupSubtype(value: unknown): TPdfAnnotationMarkupSubtype | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    return Object.hasOwn(MARKUP_SUBTYPE_ALIASES, normalized)
        ? MARKUP_SUBTYPE_ALIASES[normalized as keyof typeof MARKUP_SUBTYPE_ALIASES]
        : null;
}
