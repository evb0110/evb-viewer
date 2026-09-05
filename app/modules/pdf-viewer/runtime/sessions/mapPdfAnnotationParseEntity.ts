import type {IPdfForeignAnnotationRecord} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    normalizeAnnotationText,
    type AnnotationEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {
    IPdfAnnotationParseEntry,
    TPdfAnnotationParseEntity,
} from '@contracts/pdfAnnotationParseTypes';

export function pdfAnnotationRefKey(objectNumber: number, generationNumber: number) {
    return `${objectNumber} ${generationNumber} R`;
}

function parsedPdfRef(entry: {
    objectNumber: number;
    generationNumber: number
}) {
    return pdfAnnotationRefKey(entry.objectNumber, entry.generationNumber);
}

function parsedEntityBase(entry: TPdfAnnotationParseEntity) {
    return {
        identity: {
            id: asAnnotationId(entry.name),
            pdfRef: parsedPdfRef(entry),
        },
        pageIndex: entry.pageIndex,
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: entry.createdAt,
        modifiedAt: entry.modifiedAt,
        author: entry.author,
    };
}

export function mapPdfAnnotationParseEntity(
    entry: TPdfAnnotationParseEntity,
    selectedText?: string | null,
): AnnotationEntity {
    switch (entry.kind) {
        case 'text-box':
            return {
                ...parsedEntityBase(entry),
                kind: 'text-box',
                text: normalizeAnnotationText(entry.text),
                rect: {...entry.rect},
                rotation: entry.rotation,
                fontSize: entry.fontSize,
                color: entry.color,
            };
        case 'note':
            return {
                ...parsedEntityBase(entry),
                kind: 'note',
                contents: normalizeAnnotationText(entry.contents),
                position: {...entry.position},
                color: entry.color,
                open: entry.open,
                replies: entry.replies.map(reply => ({...reply})),
            };
        case 'highlight':
            return {
                ...parsedEntityBase(entry),
                kind: 'text-markup',
                subtype: entry.subtype,
                contents: normalizeAnnotationText(entry.contents),
                quadPoints: entry.quadPoints.map(rect => ({...rect})),
                color: entry.color,
                opacity: entry.opacity,
                ...(selectedText === undefined ? {} : {selectedText}),
            };
        case 'stamp':
            return {
                ...parsedEntityBase(entry),
                kind: 'placed-image',
                rect: {...entry.rect},
                rotation: entry.rotation,
                image: {...entry.image},
            };
        case 'shape':
            return {
                ...parsedEntityBase(entry),
                kind: 'shape',
                tool: entry.type === 'polyline' || entry.type === 'polygon'
                    ? 'draw'
                    : entry.type,
                rect: {
                    left: entry.x,
                    top: entry.y,
                    width: entry.width,
                    height: entry.height,
                },
                ...(entry.points === null ? {} : {points: entry.points.map(point => ({...point}))}),
                ...(entry.strokes === null ? {} : {strokes: entry.strokes.map(stroke => stroke.map(point => ({...point})))}),
                strokeColor: entry.color,
                strokeWidth: entry.strokeWidth,
                fill: entry.fillColor,
                opacity: entry.opacity,
            };
    }
}

export function mapPdfAnnotationParseForeign(
    entry: Extract<IPdfAnnotationParseEntry, {kind: 'foreign'}>,
): IPdfForeignAnnotationRecord {
    return {
        kind: 'foreign',
        pageIndex: entry.pageIndex,
        subtype: entry.subtype,
        name: entry.name,
        objectNumber: entry.objectNumber,
        generationNumber: entry.generationNumber,
        reason: entry.reason,
    };
}
