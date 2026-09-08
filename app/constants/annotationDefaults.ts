import type { IAnnotationSettings } from '@app/types/annotations';

export const DEFAULT_ANNOTATION_SETTINGS = {
    highlightColor: '#ffd400',
    highlightOpacity: 0.35,
    highlightThickness: 12,
    highlightFreehandEnabled: true,
    showAllHighlights: true,
    underlineColor: '#2563eb',
    underlineOpacity: 0.8,
    strikethroughColor: '#dc2626',
    strikethroughOpacity: 0.7,
    squigglyColor: '#16a34a',
    squigglyOpacity: 0.7,
    inkColor: '#e11d48',
    inkOpacity: 0.9,
    inkThickness: 1,
    noteColor: '#f59e0b',
    textColor: '#111827',
    textSize: 22,
    shapeColor: '#2563eb',
    shapeFillColor: 'transparent',
    shapeOpacity: 1,
    shapeStrokeWidth: 2,
} satisfies IAnnotationSettings;

export const ANNOTATION_PROPERTY_RANGES = {
    highlightThickness: {
        min: 4,
        max: 24,
        step: 1, 
    },
    inkThickness: {
        min: 1,
        max: 24,
        step: 1, 
    },
    shapeStrokeWidth: {
        min: 1,
        max: 10,
        step: 0.5, 
    },
    textSize: {
        min: 8,
        max: 72,
        step: 1, 
    },
} as const;
