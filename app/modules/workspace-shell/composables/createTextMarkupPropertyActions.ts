import type { Ref } from 'vue';
import type {
    IAnnotationSettings,
    ITextMarkupAnnotationProperties,
} from '@app/types/annotations';
import type { TPageAnnotationActionsPdfViewer } from '@app/modules/workspace-shell/composables/pageAnnotationActionsPdfViewer';

interface ITextMarkupPropertyActionsOptions {
    readonly pdfViewerRef: Ref<TPageAnnotationActionsPdfViewer | null>;
    readonly annotationSettings: Ref<IAnnotationSettings>;
    readonly selectedTextMarkupForProperties: Ref<ITextMarkupAnnotationProperties | null>;
    readonly closeTextMarkupProperties: () => void;
}

function normalizeTextMarkupOpacityValue(opacity: number | null | undefined) {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity)) {
        return null;
    }
    return Math.min(1, Math.max(0, opacity));
}

const textMarkupSettingsKeys = {
    Highlight: {
        color: 'highlightColor',
        opacity: 'highlightOpacity',
    },
    StrikeOut: {
        color: 'strikethroughColor',
        opacity: 'strikethroughOpacity',
    },
    Squiggly: {
        color: 'squigglyColor',
        opacity: 'squigglyOpacity',
    },
    Underline: {
        color: 'underlineColor',
        opacity: 'underlineOpacity',
    },
} as const;

export function settingsKeysForTextMarkup(subtype: string | null | undefined) {
    const normalized = subtype?.trim().toLowerCase();
    const canonicalSubtype = normalized === 'strikeout' || normalized === 'strikethrough'
        ? 'StrikeOut'
        : normalized === 'underline'
            ? 'Underline'
            : normalized === 'squiggly'
                ? 'Squiggly'
                : normalized === 'highlight'
                    ? 'Highlight'
                    : null;
    return canonicalSubtype ? textMarkupSettingsKeys[canonicalSubtype] : null;
}

function updateTextMarkupDefaultOpacity(
    annotationSettings: Ref<IAnnotationSettings>,
    comment: ITextMarkupAnnotationProperties,
    opacity: number,
) {
    const nextSettings: IAnnotationSettings = {...annotationSettings.value};
    const settingsKeys = settingsKeysForTextMarkup(comment.subtype);
    if (!settingsKeys) {
        return;
    }
    nextSettings[settingsKeys.opacity] = opacity;
    annotationSettings.value = nextSettings;
}

export function createTextMarkupPropertyActions(
    options: ITextMarkupPropertyActionsOptions,
) {
    const {
        pdfViewerRef,
        annotationSettings,
        selectedTextMarkupForProperties,
        closeTextMarkupProperties,
    } = options;

    function applySelectedTextMarkupOpacityUpdate(
        opacity: number,
        selectedMarkup = selectedTextMarkupForProperties.value,
    ) {
        const normalizedOpacity = normalizeTextMarkupOpacityValue(opacity);
        const didUpdate = Boolean(
            selectedMarkup
            && normalizedOpacity !== null
            && pdfViewerRef.value?.updateSelectedTextMarkupAnnotationProperties?.(
                {opacity: normalizedOpacity},
                selectedMarkup,
            ) === true,
        );
        if (!didUpdate || !selectedMarkup || normalizedOpacity === null) {
            return false;
        }
        updateTextMarkupDefaultOpacity(annotationSettings, selectedMarkup, normalizedOpacity);
        selectedTextMarkupForProperties.value = pdfViewerRef.value?.getSelectedTextMarkupAnnotationProperties?.()
            ?? selectedTextMarkupForProperties.value;
        return true;
    }

    function handleTextMarkupOpacityUpdate(opacity: number) {
        const selectedMarkup = selectedTextMarkupForProperties.value;
        const normalizedOpacity = normalizeTextMarkupOpacityValue(opacity);
        if (
            normalizedOpacity === null
            || !applySelectedTextMarkupOpacityUpdate(normalizedOpacity, selectedMarkup)
        ) {
            return;
        }
        closeTextMarkupProperties();
    }

    return {handleTextMarkupOpacityUpdate};
}
