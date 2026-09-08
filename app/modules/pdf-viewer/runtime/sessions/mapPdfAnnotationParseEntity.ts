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
import { createEpochMs } from '@contracts/timestamps';

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
        createdAt: entry.createdAt === null ? null : createEpochMs(entry.createdAt),
        modifiedAt: entry.modifiedAt === null ? null : createEpochMs(entry.modifiedAt),
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
                ...(entry.recoveryData === undefined ? {} : {recoveryData: entry.recoveryData}),
                replies: entry.replies.map(reply => ({
                    ...reply,
                    createdAt: reply.createdAt === null ? null : createEpochMs(reply.createdAt),
                    modifiedAt: reply.modifiedAt === null ? null : createEpochMs(reply.modifiedAt),
                })),
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
        case 'shape': {
            // The native shape parser reports ordered /L endpoints separately
            // from absolute width/height. Retain their direction before taking
            // the bounding rect used by selection and resizing.
            const linePoints = entry.type === 'line' || entry.type === 'arrow'
                ? [
                    {
                        x: entry.x,
                        y: entry.y,
                    },
                    {
                        x: entry.x2 ?? entry.x + entry.width,
                        y: entry.y2 ?? entry.y + entry.height,
                    },
                ]
                : null;
            return {
                ...parsedEntityBase(entry),
                kind: 'shape',
                tool: entry.type === 'polyline' || entry.type === 'polygon'
                    ? 'draw'
                    : entry.type,
                pdfSubtype: entry.pdfSubtype,
                ...(entry.lineStartStyle === null ? {} : {lineStartStyle: entry.lineStartStyle}),
                ...(entry.lineEndStyle === null ? {} : {lineEndStyle: entry.lineEndStyle}),
                rect: {
                    left: linePoints ? Math.min(linePoints[0]!.x, linePoints[1]!.x) : entry.x,
                    top: linePoints ? Math.min(linePoints[0]!.y, linePoints[1]!.y) : entry.y,
                    width: entry.width,
                    height: entry.height,
                },
                ...(linePoints
                    ? {points: linePoints}
                    : entry.points === null ? {} : {points: entry.points.map(point => ({...point}))}),
                ...(entry.strokes === null ? {} : {strokes: entry.strokes.map(stroke => stroke.map(point => ({...point})))}),
                strokeColor: entry.color,
                strokeWidth: entry.strokeWidth,
                fill: entry.fillColor,
                opacity: entry.opacity,
            };
        }
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
