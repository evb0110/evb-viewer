export interface IPdfAnnotationRef {
    objectNumber: number;
    generationNumber: number;
}

const PDF_JS_ANNOTATION_REF_PATTERN = /^(\d+)R(?:(\d+))?$/iu;
const PDF_NATIVE_ANNOTATION_REF_PATTERN = /^(\d+)\s+(\d+)\s+R$/iu;

function parsePdfAnnotationRefParts(
    objectNumberText: string,
    generationNumberText: string | undefined,
) {
    const objectNumber = Number(objectNumberText);
    const generationNumber = Number(generationNumberText ?? '0');
    if (
        !Number.isSafeInteger(objectNumber)
        || objectNumber <= 0
        || !Number.isSafeInteger(generationNumber)
        || generationNumber < 0
        || generationNumber > 65_535
    ) {
        return null;
    }
    return {
        objectNumber,
        generationNumber,
    };
}

/** Parse the compact PDF.js annotation reference form, such as `42R0`. */
export function parsePdfJsAnnotationRef(annotationId: string | null | undefined) {
    if (!annotationId) {
        return null;
    }
    const match = annotationId.trim().match(PDF_JS_ANNOTATION_REF_PATTERN);
    if (!match) {
        return null;
    }

    return parsePdfAnnotationRefParts(match[1]!, match[2]);
}

/** Parse the native PDF object reference form, such as `42 0 R`. */
export function parsePdfNativeAnnotationRef(annotationId: string | null | undefined) {
    if (!annotationId) {
        return null;
    }
    const match = annotationId.trim().match(PDF_NATIVE_ANNOTATION_REF_PATTERN);
    if (!match) {
        return null;
    }

    return parsePdfAnnotationRefParts(match[1]!, match[2]);
}

/** Parse either the compact PDF.js or native PDF object reference form. */
export function parsePdfAnnotationRef(annotationId: string | null | undefined) {
    return parsePdfJsAnnotationRef(annotationId) ?? parsePdfNativeAnnotationRef(annotationId);
}

export function formatPdfJsAnnotationRef(
    ref: IPdfAnnotationRef,
) {
    return ref.generationNumber === 0
        ? `${ref.objectNumber}R`
        : `${ref.objectNumber}R${ref.generationNumber}`;
}

export function normalizePdfJsAnnotationId(annotationId: string | null | undefined) {
    const ref = parsePdfAnnotationRef(annotationId);
    if (ref) {
        return formatPdfJsAnnotationRef(ref);
    }

    const trimmed = annotationId?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
}
