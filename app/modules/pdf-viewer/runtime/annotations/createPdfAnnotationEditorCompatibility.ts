import type {
    ComputedRef,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationSettings,
    ITextMarkupAnnotationProperties,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type {ITextMarkupEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {isSelectionMarkupTool} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionMarkupTool';
import {markupSubtypeByAnnotationTool} from '@app/modules/pdf-viewer/runtime/sessions/subtypeForAnnotationTool';

interface ICreatePdfAnnotationEditorCompatibilityOptions {
    annotationApplication: ShallowRef<AnnotationApplication>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    canonicalMarkupSubtypeHints: Map<string, TMarkupSubtype>;
}

function selectedTextMarkupEntity(
    annotationApplication: ShallowRef<AnnotationApplication>,
): ITextMarkupEntity | null {
    return [...annotationApplication.value.store.selectedIds]
        .map(id => annotationApplication.value.store.get(id))
        .find((candidate): candidate is ITextMarkupEntity => (
            candidate?.kind === 'text-markup' && !candidate.deleted
        )) ?? null;
}

function selectedTextMarkupProperties(
    annotationApplication: ShallowRef<AnnotationApplication>,
): ITextMarkupAnnotationProperties | null {
    const entity = selectedTextMarkupEntity(annotationApplication);
    if (!entity) {
        return null;
    }
    return {
        id: entity.identity.id,
        pageIndex: entity.pageIndex,
        subtype: entity.subtype,
        color: entity.color ?? '',
        markerRect: entity.quadPoints[0] ?? null,
        opacity: entity.opacity,
        contents: entity.contents,
    };
}

export function createPdfAnnotationEditorCompatibility(
    options: ICreatePdfAnnotationEditorCompatibilityOptions,
) {
    const markupSubtype = {
        toolToMarkupSubtype: markupSubtypeByAnnotationTool,
        isSelectionMarkupTool,
        getSelectedTextMarkupAnnotationProperties: () => selectedTextMarkupProperties(
            options.annotationApplication,
        ),
        rememberMarkupSubtypeColorOverride: () => {},
        updateSelectedTextMarkupAnnotationColor: (color: string) => {
            const selectedEntity = selectedTextMarkupEntity(options.annotationApplication);
            if (!selectedEntity) {
                return false;
            }
            return Boolean(options.annotationApplication.value.store.updateTextMarkup(
                selectedEntity.identity.id,
                {color},
            ));
        },
        updateSelectedTextMarkupAnnotationProperties: (
            updates: Partial<Pick<ITextMarkupAnnotationProperties, 'color' | 'opacity' | 'contents'>>,
            selected: ITextMarkupAnnotationProperties,
        ) => {
            const selectedEntity = selectedTextMarkupEntity(options.annotationApplication);
            if (!selectedEntity || selectedEntity.identity.id !== selected.id) {
                return false;
            }
            const opacity = updates.opacity;
            if (
                opacity !== undefined
                && opacity !== null
                && (typeof opacity !== 'number' || !Number.isFinite(opacity))
            ) {
                return false;
            }
            return Boolean(options.annotationApplication.value.store.updateTextMarkup(
                selectedEntity.identity.id,
                {
                    ...updates,
                    ...(typeof opacity === 'number'
                        ? {opacity: Math.min(1, Math.max(0, opacity))}
                        : {}),
                },
            ));
        },
        updateTextMarkupAnnotationColor: (
            _editor: object,
            _pageIndex: number,
            _subtype: TMarkupSubtype,
            _color: string,
        ) => false,
        getMarkupSubtypeOverrides: () => new Map(options.canonicalMarkupSubtypeHints),
        getMarkupSubtypeHints: () => [],
    };
    const toolManager = {
        setAnnotationTool: () => {},
        applyAnnotationSettings: (_settings: IAnnotationSettings | null | undefined) => {},
        updateModeWithRetry: () => Promise.resolve(null),
        maybeAutoResetAnnotationTool: () => {},
    };
    const freeTextResize = {ensureFreeTextEditorCanResize: (_editor: object) => {}};
    const editor = {
        markupSubtype,
        toolManager,
        freeTextResize,
        setAnnotationTool: toolManager.setAnnotationTool,
        applyAnnotationSettings: toolManager.applyAnnotationSettings,
        updateModeWithRetry: toolManager.updateModeWithRetry,
        getMarkupSubtypeOverrides: markupSubtype.getMarkupSubtypeOverrides,
        getMarkupSubtypeHints: markupSubtype.getMarkupSubtypeHints,
        ensureFreeTextEditorCanResize: freeTextResize.ensureFreeTextEditorCanResize,
        initAnnotationEditor: () => {},
        destroyAnnotationEditor: () => {},
        commitPendingFreeTextDraftsForSave: () => {},
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
