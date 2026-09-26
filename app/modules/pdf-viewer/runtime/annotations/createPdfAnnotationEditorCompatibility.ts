import type {ComputedRef} from 'vue';
import type {
    IAnnotationSettings,
    TMarkupSubtype,
} from '@app/types/annotations';

interface ICreatePdfAnnotationEditorCompatibilityOptions {
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    canonicalMarkupSubtypeHints: Map<string, TMarkupSubtype>;
    commitPendingFreeTextDraftsForSave?: () => void;
}

export function createPdfAnnotationEditorCompatibility(
    options: ICreatePdfAnnotationEditorCompatibilityOptions,
) {
    const editor = {
        getMarkupSubtypeOverrides: () => new Map(options.canonicalMarkupSubtypeHints),
        getMarkupSubtypeHints: () => [],
        commitPendingFreeTextDraftsForSave: () => {
            options.commitPendingFreeTextDraftsForSave?.();
        },
    };

    function selectionMarkupStyle(subtype: TMarkupSubtype) {
        const settings = options.annotationSettings.value;
        if (!settings) {
            return {
                color: null,
                opacity: null,
            };
        }
        switch (subtype) {
            case 'Underline':
                return {
                    color: settings.underlineColor,
                    opacity: settings.underlineOpacity,
                };
            case 'StrikeOut':
                return {
                    color: settings.strikethroughColor,
                    opacity: settings.strikethroughOpacity,
                };
            case 'Squiggly':
                return {
                    color: settings.squigglyColor,
                    opacity: settings.squigglyOpacity,
                };
            case 'Highlight':
                return {
                    color: settings.highlightColor,
                    opacity: settings.highlightOpacity,
                };
        }
    }

    return {
        editor,
        selectionMarkupStyle,
    };
}
