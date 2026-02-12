import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
} from 'pdf-lib';
import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfPageLabelRange } from '@app/types/pdf';
import { markerRectIoU } from '@app/composables/pdf/pdfAnnotationUtils';
import {
    getPdfStringValue,
    getPdfDictSubtype,
    getPdfDictContents,
    normalizeMarkerRectFromDict,
} from '@app/utils/pdf-dict';
import {
    normalizeAnnotationSubtypeToken,
    normalizeComparableText,
} from '@app/utils/text-normalization';
import { parseHexColor } from '@app/utils/color';
import { toPdfDateString } from '@app/utils/pdf-date';
import {
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdf-page-labels';

const MARKUP_SUBTYPE_TO_PDF_NAME: Record<TMarkupSubtype, string> = {
    Highlight: 'Highlight',
    Underline: 'Underline',
    StrikeOut: 'StrikeOut',
    Squiggly: 'Squiggly',
};

function getPdfDictAuthor(dict: PDFDict | null) {
    if (!dict) {
        return '';
    }
    return getPdfStringValue(dict.get(PDFName.of('T')));
}

function getPdfPopupDict(doc: PDFDocument, dict: PDFDict | null) {
    if (!dict) {
        return null;
    }
    const popupValue = dict.get(PDFName.of('Popup'));
    if (popupValue instanceof PDFDict) {
        return popupValue;
    }
    if (popupValue instanceof PDFRef) {
        return doc.context.lookupMaybe(popupValue, PDFDict) ?? null;
    }
    return null;
}

function parsePdfJsAnnotationRef(annotationId: string | null | undefined) {
    if (!annotationId) {
        return null;
    }
    const match = annotationId.trim().match(/^(\d+)R(?:(\d+))?$/i);
    if (!match) {
        return null;
    }

    const objectNumber = Number(match[1]);
    const generationNumber = match[2] ? Number(match[2]) : 0;
    if (
        !Number.isInteger(objectNumber)
        || objectNumber <= 0
        || !Number.isInteger(generationNumber)
        || generationNumber < 0
    ) {
        return null;
    }

    return PDFRef.of(objectNumber, generationNumber);
}

function parseAnnotationRefFromStableKey(stableKey: string | null | undefined) {
    if (!stableKey) {
        return null;
    }
    const match = stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/i);
    if (!match?.[1]) {
        return null;
    }
    return parsePdfJsAnnotationRef(match[1]);
}

function resolveCommentPdfRef(comment: IAnnotationCommentSummary) {
    return (
        parsePdfJsAnnotationRef(comment.annotationId ?? comment.id)
        ?? parseAnnotationRefFromStableKey(comment.stableKey)
    );
}

function findCommentRefByGeneratedId(doc: PDFDocument, comment: IAnnotationCommentSummary) {
    const generated = comment.id.match(/^pdf-(\d+)-(\d+)$/);
    if (!generated) {
        return null;
    }
    const pageNumber = Number(generated[1]);
    const annotationIndex = Number(generated[2]);
    if (!Number.isInteger(pageNumber) || !Number.isInteger(annotationIndex)) {
        return null;
    }
    if (pageNumber !== comment.pageNumber || annotationIndex < 0) {
        return null;
    }

    const pageIndex = Math.max(0, Math.min(pageNumber - 1, doc.getPageCount() - 1));
    const page = doc.getPages()[pageIndex];
    if (!page) {
        return null;
    }
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray) || annotationIndex >= annots.size()) {
        return null;
    }
    const value = annots.get(annotationIndex);
    return value instanceof PDFRef ? value : null;
}

function resolveCommentPdfRefInDocument(doc: PDFDocument, comment: IAnnotationCommentSummary) {
    const explicitRef = resolveCommentPdfRef(comment);
    if (explicitRef) {
        return explicitRef;
    }

    const byGeneratedId = findCommentRefByGeneratedId(doc, comment);
    if (byGeneratedId) {
        return byGeneratedId;
    }

    const pageIndex = Math.max(0, Math.min(comment.pageIndex, doc.getPageCount() - 1));
    const page = doc.getPages()[pageIndex];
    if (!page) {
        return null;
    }

    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray) || annots.size() === 0) {
        return null;
    }

    const pageSize = page.getSize();
    const pageWidth = pageSize.width;
    const pageHeight = pageSize.height;
    const commentSubtype = normalizeAnnotationSubtypeToken(comment.subtype);
    const commentText = normalizeComparableText(comment.text);
    const commentAuthor = normalizeComparableText(comment.author);
    const commentRect = comment.markerRect
        ? {
            left: Math.max(0, Math.min(1, comment.markerRect.left)),
            top: Math.max(0, Math.min(1, comment.markerRect.top)),
            width: Math.max(0, Math.min(1, comment.markerRect.width)),
            height: Math.max(0, Math.min(1, comment.markerRect.height)),
        }
        : null;

    let bestMatch: {
        ref: PDFRef;
        score: number;
    } | null = null;

    for (let index = 0; index < annots.size(); index += 1) {
        const value = annots.get(index);
        if (!(value instanceof PDFRef)) {
            continue;
        }

        const dict = doc.context.lookupMaybe(value, PDFDict);
        if (!dict) {
            continue;
        }

        const subtype = normalizeAnnotationSubtypeToken(getPdfDictSubtype(dict));
        if (subtype === 'popup') {
            continue;
        }

        const popupDict = getPdfPopupDict(doc, dict);
        const candidateText = normalizeComparableText(
            getPdfDictContents(dict) || getPdfDictContents(popupDict),
        );
        const candidateAuthor = normalizeComparableText(
            getPdfDictAuthor(dict) || getPdfDictAuthor(popupDict),
        );
        const candidateRect = normalizeMarkerRectFromDict(dict, pageWidth, pageHeight);

        let score = 0;
        if (commentSubtype) {
            if (commentSubtype === subtype) {
                score += 5;
            } else if (
                (commentSubtype === 'text' && subtype === 'freetext')
                || (commentSubtype === 'freetext' && subtype === 'text')
            ) {
                score += 2;
            } else {
                score -= 1.5;
            }
        }

        if (commentText) {
            if (candidateText === commentText) {
                score += 6;
            } else if (
                candidateText.length > 0
                && (candidateText.includes(commentText) || commentText.includes(candidateText))
            ) {
                score += 3;
            } else {
                score -= 1;
            }
        } else if (!candidateText) {
            score += 0.5;
        }

        if (commentAuthor && candidateAuthor && commentAuthor === candidateAuthor) {
            score += 1;
        }

        const rectIoU = markerRectIoU(commentRect, candidateRect);
        if (rectIoU > 0) {
            score += rectIoU * 8;
        } else if (commentRect) {
            score -= 0.2;
        }

        if (!bestMatch || score > bestMatch.score) {
            bestMatch = {
                ref: value,
                score,
            };
        }
    }

    return bestMatch && bestMatch.score >= 2 ? bestMatch.ref : null;
}

function setAnnotationDictContents(
    dict: PDFDict | null,
    text: string,
    modifiedAt: string,
) {
    if (!dict) {
        return false;
    }

    dict.set(PDFName.of('Contents'), PDFHexString.fromText(text));
    dict.set(PDFName.of('M'), PDFString.of(modifiedAt));
    return true;
}

function updateAnnotationTextByRef(
    doc: PDFDocument,
    targetRef: PDFRef,
    text: string,
) {
    const targetDict = doc.context.lookupMaybe(targetRef, PDFDict);
    if (!targetDict) {
        return false;
    }

    const modifiedAt = toPdfDateString(new Date());
    let updated = setAnnotationDictContents(targetDict, text, modifiedAt);

    const targetSubtype = normalizeAnnotationSubtypeToken(getPdfDictSubtype(targetDict));
    const popupValue = targetDict.get(PDFName.of('Popup'));
    if (popupValue instanceof PDFRef) {
        updated = setAnnotationDictContents(doc.context.lookupMaybe(popupValue, PDFDict) ?? null, text, modifiedAt) || updated;
    } else if (popupValue instanceof PDFDict) {
        updated = setAnnotationDictContents(popupValue, text, modifiedAt) || updated;
    }

    if (targetSubtype === 'popup') {
        const parentValue = targetDict.get(PDFName.of('Parent'));
        if (parentValue instanceof PDFRef) {
            updated = setAnnotationDictContents(doc.context.lookupMaybe(parentValue, PDFDict) ?? null, text, modifiedAt) || updated;
        } else if (parentValue instanceof PDFDict) {
            updated = setAnnotationDictContents(parentValue, text, modifiedAt) || updated;
        }
    }

    return updated;
}

function collectAnnotationRefsToDelete(doc: PDFDocument, targetRef: PDFRef) {
    const refs = new Map<string, PDFRef>();
    const enqueueRef = (ref: PDFRef | null) => {
        if (!ref) {
            return false;
        }
        const key = ref.toString();
        if (refs.has(key)) {
            return false;
        }
        refs.set(key, ref);
        return true;
    };

    enqueueRef(targetRef);

    let pending = [targetRef];
    while (pending.length > 0) {
        const currentBatch = pending;
        pending = [];
        currentBatch.forEach((ref) => {
            const dict = doc.context.lookupMaybe(ref, PDFDict);
            if (!dict) {
                return;
            }

            const popupValue = dict.get(PDFName.of('Popup'));
            if (popupValue instanceof PDFRef && enqueueRef(popupValue)) {
                pending.push(popupValue);
            }

            const parentValue = dict.get(PDFName.of('Parent'));
            if (parentValue instanceof PDFRef && enqueueRef(parentValue)) {
                pending.push(parentValue);
            }
        });
    }

    return Array.from(refs.values());
}

function removeAnnotationRefsFromPages(doc: PDFDocument, refsToRemove: PDFRef[]) {
    if (refsToRemove.length === 0) {
        return false;
    }

    const refTags = new Set(refsToRemove.map(ref => ref.toString()));
    let removed = false;

    doc.getPages().forEach((page) => {
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            return;
        }

        for (let index = annots.size() - 1; index >= 0; index -= 1) {
            const value = annots.get(index);
            if (!(value instanceof PDFRef)) {
                continue;
            }
            if (!refTags.has(value.toString())) {
                continue;
            }
            annots.remove(index);
            removed = true;
        }
    });

    return removed;
}

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

    async function getSourcePdfData() {
        let sourceData = pdfData.value ? pdfData.value.slice() : null;
        if (!sourceData && workingCopyPath.value && window.electronAPI) {
            try {
                const buffer = await window.electronAPI.readFile(workingCopyPath.value);
                sourceData = new Uint8Array(buffer);
            } catch {
                sourceData = null;
            }
        }
        return sourceData;
    }

    async function rewriteMarkupSubtypes(data: Uint8Array): Promise<Uint8Array> {
        const overrides = getMarkupSubtypeOverrides();
        const subtypeHints = annotationComments.value
            .filter(comment => (
                comment.source === 'editor'
                && (comment.subtype === 'Underline' || comment.subtype === 'StrikeOut')
                && comment.markerRect
            ))
            .map(comment => ({
                subtype: comment.subtype as TMarkupSubtype,
                pageIndex: comment.pageIndex,
                markerRect: comment.markerRect as {
                    left: number;
                    top: number;
                    width: number;
                    height: number;
                },
                consumed: false,
            }));

        if ((!overrides || overrides.size === 0) && subtypeHints.length === 0) {
            return data;
        }

        let doc: PDFDocument;
        try {
            doc = await PDFDocument.load(data, { updateMetadata: false });
        } catch {
            return data;
        }

        const subtypeName = PDFName.of('Subtype');
        const highlightName = PDFName.of('Highlight');
        let rewritten = false;

        const pages = doc.getPages();
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            const pageHints = subtypeHints.filter(hint => !hint.consumed && hint.pageIndex === pageIndex);
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
        const shapes = getAllShapes();
        if (shapes.length === 0) {
            return data;
        }

        let doc: PDFDocument;
        try {
            doc = await PDFDocument.load(data, { updateMetadata: false });
        } catch {
            return data;
        }

        const pages = doc.getPages();

        for (const shape of shapes) {
            const page = pages[shape.pageIndex];
            if (!page) continue;

            const {
                width: pageWidth,
                height: pageHeight,
            } = page.getSize();
            const [
                r,
                g,
                b,
            ] = parseHexColor(shape.color);
            const lineWidth = shape.strokeWidth;

            if (shape.type === 'rectangle') {
                const x = shape.x * pageWidth;
                const y = (1 - shape.y - shape.height) * pageHeight;
                const w = shape.width * pageWidth;
                const h = shape.height * pageHeight;

                const rect = doc.context.obj([
                    x,
                    y,
                    x + w,
                    y + h,
                ]);
                const annotDict = doc.context.obj({
                    Type: 'Annot',
                    Subtype: 'Square',
                    Rect: rect,
                    C: [
                        r,
                        g,
                        b,
                    ],
                    CA: shape.opacity,
                    Border: [
                        0,
                        0,
                        lineWidth,
                    ],
                });

                if (shape.fillColor) {
                    const [
                        fr,
                        fg,
                        fb,
                    ] = parseHexColor(shape.fillColor);
                    (annotDict as PDFDict).set(PDFName.of('IC'), doc.context.obj([
                        fr,
                        fg,
                        fb,
                    ]));
                }

                const annotRef = doc.context.register(annotDict);
                const annots = page.node.Annots() ?? doc.context.obj([]);
                if (annots instanceof PDFArray) {
                    annots.push(annotRef);
                }
                page.node.set(PDFName.of('Annots'), annots instanceof PDFArray ? annots : doc.context.obj([annotRef]));
            } else if (shape.type === 'circle') {
                const x = shape.x * pageWidth;
                const y = (1 - shape.y - shape.height) * pageHeight;
                const w = shape.width * pageWidth;
                const h = shape.height * pageHeight;

                const rect = doc.context.obj([
                    x,
                    y,
                    x + w,
                    y + h,
                ]);
                const annotDict = doc.context.obj({
                    Type: 'Annot',
                    Subtype: 'Circle',
                    Rect: rect,
                    C: [
                        r,
                        g,
                        b,
                    ],
                    CA: shape.opacity,
                    Border: [
                        0,
                        0,
                        lineWidth,
                    ],
                });

                if (shape.fillColor) {
                    const [
                        fr,
                        fg,
                        fb,
                    ] = parseHexColor(shape.fillColor);
                    (annotDict as PDFDict).set(PDFName.of('IC'), doc.context.obj([
                        fr,
                        fg,
                        fb,
                    ]));
                }

                const annotRef = doc.context.register(annotDict);
                const annots = page.node.Annots() ?? doc.context.obj([]);
                if (annots instanceof PDFArray) {
                    annots.push(annotRef);
                }
                page.node.set(PDFName.of('Annots'), annots instanceof PDFArray ? annots : doc.context.obj([annotRef]));
            } else if (shape.type === 'line' || shape.type === 'arrow') {
                const x1 = shape.x * pageWidth;
                const y1 = (1 - shape.y) * pageHeight;
                const x2 = (shape.x2 ?? shape.x) * pageWidth;
                const y2 = (1 - (shape.y2 ?? shape.y)) * pageHeight;

                const minX = Math.min(x1, x2) - lineWidth;
                const minY = Math.min(y1, y2) - lineWidth;
                const maxX = Math.max(x1, x2) + lineWidth;
                const maxY = Math.max(y1, y2) + lineWidth;

                const rect = doc.context.obj([
                    minX,
                    minY,
                    maxX,
                    maxY,
                ]);
                const l = doc.context.obj([
                    x1,
                    y1,
                    x2,
                    y2,
                ]);

                const annotDict = doc.context.obj({
                    Type: 'Annot',
                    Subtype: 'Line',
                    Rect: rect,
                    L: l,
                    C: [
                        r,
                        g,
                        b,
                    ],
                    CA: shape.opacity,
                    Border: [
                        0,
                        0,
                        lineWidth,
                    ],
                });

                if (shape.type === 'arrow') {
                    const leStyle = shape.lineEndStyle === 'openArrow' ? 'OpenArrow' : 'ClosedArrow';
                    (annotDict as PDFDict).set(PDFName.of('LE'), doc.context.obj([
                        PDFName.of('None'),
                        PDFName.of(leStyle),
                    ]));
                }

                const annotRef = doc.context.register(annotDict);
                const annots = page.node.Annots() ?? doc.context.obj([]);
                if (annots instanceof PDFArray) {
                    annots.push(annotRef);
                }
                page.node.set(PDFName.of('Annots'), annots instanceof PDFArray ? annots : doc.context.obj([annotRef]));
            }
        }

        return new Uint8Array(await doc.save());
    }

    async function updateEmbeddedAnnotationByRef(comment: IAnnotationCommentSummary, text: string) {
        const sourceData = await getSourcePdfData();
        if (!sourceData) {
            return false;
        }

        let document: PDFDocument;
        try {
            document = await PDFDocument.load(sourceData, { updateMetadata: false });
        } catch {
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

        let document: PDFDocument;
        try {
            document = await PDFDocument.load(sourceData, { updateMetadata: false });
        } catch {
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

        let doc: PDFDocument;
        try {
            doc = await PDFDocument.load(data, { updateMetadata: false });
        } catch {
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
