import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
} from 'pdf-lib';
import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfPageLabelRange } from '@app/types/pdf';
import { markerRectIoU } from '@app/composables/pdf/pdfAnnotationUtils';
import { normalizeMarkerRectFromDict } from '@app/utils/pdf-dict';
import {
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdf-page-labels';
import { resolveCommentPdfRefInDocument } from '@app/composables/pdf/pdfSerializationRefs';
import {
    updateAnnotationTextByRef,
    collectAnnotationRefsToDelete,
    removeAnnotationRefsFromPages,
} from '@app/composables/pdf/pdfSerializationComments';
import { serializeShapeAnnotationsToDoc } from '@app/composables/pdf/pdfSerializationShapes';
import {
    collectMarkupSubtypeHints,
    groupMarkupSubtypeHintsByPage,
} from '@app/composables/pdf/pdfSerializationSubtypeHints';
import { BrowserLogger } from '@app/utils/browser-logger';

export {
    getPdfPopupDict, parsePdfJsAnnotationRef, resolveCommentPdfRefInDocument,
} from '@app/composables/pdf/pdfSerializationRefs';
export {
    setAnnotationDictContents, updateAnnotationTextByRef, collectAnnotationRefsToDelete, removeAnnotationRefsFromPages,
} from '@app/composables/pdf/pdfSerializationComments';
export { serializeShapeAnnotationsToDoc } from '@app/composables/pdf/pdfSerializationShapes';

const MARKUP_SUBTYPE_TO_PDF_NAME: Record<TMarkupSubtype, string> = {
    Highlight: 'Highlight',
    Underline: 'Underline',
    StrikeOut: 'StrikeOut',
    Squiggly: 'Squiggly',
};

const PDF_SERIALIZATION_LOG_SECTION = 'pdf-serialization';

export interface IPdfSerializationDeps {
    pdfData: Ref<Uint8Array | null>;
    workingCopyPath: Ref<string | null>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    totalPages: Ref<number>;
    pageLabelsDirty: Ref<boolean>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype> | undefined;
    getAllShapes: () => IShapeAnnotation[];
}

export const usePdfSerialization = (deps: IPdfSerializationDeps) => {
    const {
        pdfData,
        workingCopyPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        getMarkupSubtypeOverrides,
        getAllShapes,
    } = deps;

    async function loadPdfDocument(
        data: Uint8Array,
        operation: string,
    ): Promise<PDFDocument | null> {
        try {
            return await PDFDocument.load(data, { updateMetadata: false });
        } catch (error) {
            BrowserLogger.warn(PDF_SERIALIZATION_LOG_SECTION, `Failed to load PDF while ${operation}`, error);
            return null;
        }
    }

    async function getSourcePdfData() {
        let sourceData = pdfData.value ? pdfData.value.slice() : null;
        if (!sourceData && workingCopyPath.value && window.electronAPI) {
            try {
                const buffer = await window.electronAPI.readFile(workingCopyPath.value);
                sourceData = new Uint8Array(buffer);
            } catch (error) {
                BrowserLogger.debug(PDF_SERIALIZATION_LOG_SECTION, 'Failed to read working copy for serialization', {
                    path: workingCopyPath.value,
                    error,
                });
                sourceData = null;
            }
        }
        return sourceData;
    }

    async function rewriteMarkupSubtypes(data: Uint8Array): Promise<Uint8Array> {
        const overrides = getMarkupSubtypeOverrides();
        const subtypeHints = collectMarkupSubtypeHints(annotationComments.value);

        if ((!overrides || overrides.size === 0) && subtypeHints.length === 0) {
            return data;
        }

        const doc = await loadPdfDocument(data, 'rewriting annotation subtypes');
        if (!doc) {
            return data;
        }
        const subtypeHintsByPage = groupMarkupSubtypeHintsByPage(subtypeHints);

        const subtypeName = PDFName.of('Subtype');
        const highlightName = PDFName.of('Highlight');
        let rewritten = false;

        const pages = doc.getPages();
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            const pageHints = subtypeHintsByPage.get(pageIndex) ?? [];
            const {
                width: pageWidth,
                height: pageHeight,
            } = page.getSize();
            const annots = page.node.Annots();
            if (!(annots instanceof PDFArray)) {
                continue;
            }

            for (let i = 0; i < annots.size(); i++) {
                const value = annots.get(i);
                const ref = value instanceof PDFRef ? value : null;
                if (!ref) {
                    continue;
                }

                const dict = doc.context.lookupMaybe(ref, PDFDict);
                if (!dict) {
                    continue;
                }

                const currentSubtype = dict.get(subtypeName);
                if (!(currentSubtype instanceof PDFName) || currentSubtype !== highlightName) {
                    continue;
                }

                const refTag = `${ref.objectNumber}R${ref.generationNumber}`;
                let targetSubtype = overrides?.get(refTag) ?? null;
                if (!targetSubtype && pageHints.length > 0) {
                    const markerRect = normalizeMarkerRectFromDict(dict, pageWidth, pageHeight);
                    let bestMatch: {
                        score: number;
                        hint: (typeof pageHints)[number];
                    } | null = null;
                    // Hints originate from editor-space rectangles; IoU matching
                    // tolerates small coordinate drift after save/restore.
                    for (const hint of pageHints) {
                        if (hint.consumed) {
                            continue;
                        }
                        const score = markerRectIoU(markerRect, hint.markerRect);
                        if (score <= 0) {
                            continue;
                        }
                        if (!bestMatch || score > bestMatch.score) {
                            bestMatch = {
                                score,
                                hint,
                            };
                        }
                    }
                    if (bestMatch && bestMatch.score >= 0.2) {
                        targetSubtype = bestMatch.hint.subtype;
                        bestMatch.hint.consumed = true;
                    }
                }
                if (!targetSubtype) {
                    continue;
                }

                const pdfSubtypeName = MARKUP_SUBTYPE_TO_PDF_NAME[targetSubtype];
                if (pdfSubtypeName && pdfSubtypeName !== 'Highlight') {
                    dict.set(subtypeName, PDFName.of(pdfSubtypeName));
                    rewritten = true;
                }
            }
        }

        if (!rewritten) {
            return data;
        }

        return new Uint8Array(await doc.save());
    }

    async function serializeShapeAnnotations(data: Uint8Array): Promise<Uint8Array> {
        return serializeShapeAnnotationsToDoc(data, getAllShapes());
    }

    async function updateEmbeddedAnnotationByRef(comment: IAnnotationCommentSummary, text: string) {
        const sourceData = await getSourcePdfData();
        if (!sourceData) {
            return false;
        }

        const document = await loadPdfDocument(sourceData, 'updating embedded annotation');
        if (!document) {
            return false;
        }

        const targetRef = resolveCommentPdfRefInDocument(document, comment);
        if (!targetRef) {
            return false;
        }

        const updated = updateAnnotationTextByRef(document, targetRef, text);
        if (!updated) {
            return false;
        }

        return new Uint8Array(await document.save());
    }

    async function deleteEmbeddedAnnotationByRef(comment: IAnnotationCommentSummary) {
        const sourceData = await getSourcePdfData();
        if (!sourceData) {
            return null;
        }

        const document = await loadPdfDocument(sourceData, 'deleting embedded annotation');
        if (!document) {
            return null;
        }

        const targetRef = resolveCommentPdfRefInDocument(document, comment);
        if (!targetRef) {
            return null;
        }

        const refsToDelete = collectAnnotationRefsToDelete(document, targetRef);
        const removed = removeAnnotationRefsFromPages(document, refsToDelete);
        if (!removed) {
            return null;
        }

        return new Uint8Array(await document.save());
    }

    async function rewritePageLabels(data: Uint8Array): Promise<Uint8Array> {
        if (!pageLabelsDirty.value || totalPages.value <= 0) {
            return data;
        }

        const doc = await loadPdfDocument(data, 'rewriting page labels');
        if (!doc) {
            return data;
        }

        const normalizedRanges = normalizePageLabelRanges(pageLabelRanges.value, totalPages.value);
        const pageLabelsName = PDFName.of('PageLabels');

        if (isImplicitDefaultPageLabels(normalizedRanges, totalPages.value)) {
            doc.catalog.delete(pageLabelsName);
            return new Uint8Array(await doc.save());
        }

        const nums = doc.context.obj([]) as PDFArray;
        const styleName = PDFName.of('S');
        const prefixName = PDFName.of('P');
        const startName = PDFName.of('St');
        const typeName = PDFName.of('Type');
        const pageLabelName = PDFName.of('PageLabel');

        for (const range of normalizedRanges) {
            nums.push(PDFNumber.of(range.startPage - 1));

            const labelDict = doc.context.obj({}) as PDFDict;
            labelDict.set(typeName, pageLabelName);
            if (range.style) {
                labelDict.set(styleName, PDFName.of(range.style));
            }
            if (range.prefix.length > 0) {
                labelDict.set(prefixName, PDFHexString.fromText(range.prefix));
            }
            if (range.style && range.startNumber > 1) {
                labelDict.set(startName, PDFNumber.of(range.startNumber));
            }

            nums.push(labelDict);
        }

        const pageLabelsDict = doc.context.obj({Nums: nums}) as PDFDict;

        doc.catalog.set(pageLabelsName, pageLabelsDict);
        return new Uint8Array(await doc.save());
    }

    return {
        getSourcePdfData,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        updateEmbeddedAnnotationByRef,
        deleteEmbeddedAnnotationByRef,
        rewritePageLabels,
    };
};
