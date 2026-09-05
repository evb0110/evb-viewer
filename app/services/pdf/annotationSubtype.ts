import type { TTranslationKey } from '@i18n-app';

type TAnnotationLabelKey = Extract<TTranslationKey,
    | 'annotations.annotationLabel'
    | 'annotations.highlightLabel'
    | 'annotations.underlineLabel'
    | 'annotations.squiggleLabel'
    | 'annotations.strikeOutLabel'
    | 'annotations.popUpNoteLabel'
    | 'annotations.inlineNoteLabel'
    | 'annotations.freehandLineLabel'
    | 'annotations.lineLabel'
    | 'annotations.arrowLabel'
    | 'annotations.rectangleLabel'
    | 'annotations.circleLabel'
    | 'annotations.polygonLabel'
    | 'annotations.stamp'
    | 'annotations.imageLabel'
>;

export interface IAnnotationKindLabelDescriptor {
    key: TAnnotationLabelKey;
    fallback: string;
}

function createAnnotationKindLabelDescriptor(
    key: TAnnotationLabelKey,
    fallback: string,
): IAnnotationKindLabelDescriptor {
    return {
        key,
        fallback,
    };
}

function normalizeAnnotationSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase();
}

const annotationKindLabelBySubtype = new Map<string, IAnnotationKindLabelDescriptor>([
    [
        'highlight',
        createAnnotationKindLabelDescriptor('annotations.highlightLabel', 'Highlight'),
    ],
    [
        'underline',
        createAnnotationKindLabelDescriptor('annotations.underlineLabel', 'Underline'),
    ],
    [
        'squiggly',
        createAnnotationKindLabelDescriptor('annotations.squiggleLabel', 'Squiggle'),
    ],
    [
        'strikeout',
        createAnnotationKindLabelDescriptor('annotations.strikeOutLabel', 'Strike Out'),
    ],
    [
        'text',
        createAnnotationKindLabelDescriptor('annotations.popUpNoteLabel', 'Pop-up Note'),
    ],
    [
        'note-linked',
        createAnnotationKindLabelDescriptor('annotations.popUpNoteLabel', 'Pop-up Note'),
    ],
    [
        'freetext',
        createAnnotationKindLabelDescriptor('annotations.inlineNoteLabel', 'Inline Note'),
    ],
    [
        'typewriter',
        createAnnotationKindLabelDescriptor('annotations.inlineNoteLabel', 'Inline Note'),
    ],
    [
        'note-inline',
        createAnnotationKindLabelDescriptor('annotations.inlineNoteLabel', 'Inline Note'),
    ],
    [
        'ink',
        createAnnotationKindLabelDescriptor('annotations.freehandLineLabel', 'Freehand Line'),
    ],
    [
        'line',
        createAnnotationKindLabelDescriptor('annotations.lineLabel', 'Line'),
    ],
    [
        'arrow',
        createAnnotationKindLabelDescriptor('annotations.arrowLabel', 'Arrow'),
    ],
    [
        'straight-line',
        createAnnotationKindLabelDescriptor('annotations.lineLabel', 'Line'),
    ],
    [
        'square',
        createAnnotationKindLabelDescriptor('annotations.rectangleLabel', 'Rectangle'),
    ],
    [
        'geomsquare',
        createAnnotationKindLabelDescriptor('annotations.rectangleLabel', 'Rectangle'),
    ],
    [
        'rectangle',
        createAnnotationKindLabelDescriptor('annotations.rectangleLabel', 'Rectangle'),
    ],
    [
        'circle',
        createAnnotationKindLabelDescriptor('annotations.circleLabel', 'Circle'),
    ],
    [
        'geomcircle',
        createAnnotationKindLabelDescriptor('annotations.circleLabel', 'Circle'),
    ],
    [
        'ellipse',
        createAnnotationKindLabelDescriptor('annotations.circleLabel', 'Circle'),
    ],
    [
        'polygon',
        createAnnotationKindLabelDescriptor('annotations.polygonLabel', 'Polygon'),
    ],
    [
        'polyline',
        createAnnotationKindLabelDescriptor('annotations.freehandLineLabel', 'Freehand Line'),
    ],
    [
        'stamp',
        createAnnotationKindLabelDescriptor('annotations.imageLabel', 'Image'),
    ],
]);

const fallbackAnnotationKindLabel = createAnnotationKindLabelDescriptor('annotations.annotationLabel', 'Annotation');

const textMarkupSubtypes = new Set([
    'highlight',
    'underline',
    'squiggly',
    'strikeout',
]);

export function annotationKindLabelFromSubtype(
    subtype: string | null | undefined,
): IAnnotationKindLabelDescriptor {
    return annotationKindLabelBySubtype.get(normalizeAnnotationSubtype(subtype)) ?? fallbackAnnotationKindLabel;
}

export function isTextMarkupSubtype(subtype: string | null | undefined) {
    return textMarkupSubtypes.has(normalizeAnnotationSubtype(subtype));
}
