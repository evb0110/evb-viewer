import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TDrawableShapeType,
} from '@app/types/annotations';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import type {
    AnnotationEntity,
    AnnotationId,
    IShapeEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

import {
    asAnnotationId,
    mintAnnotationId,
    toLegacyShapeAnnotation,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    AnnotationStore,
    type IAnnotationSaveFrontier,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import {normalizePdfJsAnnotationId} from '@app/utils/pdfAnnotationRefs';

function normalizedPdfRef(value: string | null | undefined) {
    return normalizePdfJsAnnotationId(value);
}

export interface IAnnotationReadModel {
    readonly annotationId: AnnotationId;
    readonly kind: AnnotationEntity['kind'];
    readonly pageIndex: number;
    readonly text: string;
    readonly deleted: boolean;
}

export interface IAnnotationSaveSession {
    readonly frontier: IAnnotationSaveFrontier;
    readonly plan: ReturnType<typeof buildSerializationPlan>;
}


/**
 * The production boundary for annotation state. Existing pdfjs snapshots enter
 * through the temporary summary adapter; UI and persistence consumers leave
 * through read models and revision-frontier save sessions.
 */

function shapeToolFromLegacyShape(shape: IShapeAnnotation): TDrawableShapeType {
    if (shape.type === 'polyline') {
        return 'draw';
    }
    if (shape.type === 'arrow') {
        return 'arrow';
    }
    if (shape.type === 'line' && shape.lineEndStyle === 'closedArrow') {
        return 'arrow';
    }
    return shape.type === 'rectangle' || shape.type === 'circle' || shape.type === 'line'
        ? shape.type
        : 'draw';
}

export function toCanonicalShapeEntity(
    shape: IShapeAnnotation,
    id: AnnotationId = mintAnnotationId(),
): IShapeEntity {
    const pdfRef = normalizedPdfRef(shape.annotationId);
    const tool = shapeToolFromLegacyShape(shape);
    const linePoints = tool === 'line' || tool === 'arrow'
        ? [
            {
                x: shape.x,
                y: shape.y,
            },
            {
                x: shape.x2 ?? shape.x + shape.width,
                y: shape.y2 ?? shape.y + shape.height,
            },
        ]
        : null;
    const geometryPoints = shape.points ?? linePoints;
    const allGeometryPoints = geometryPoints ?? shape.strokes?.flatMap(stroke => stroke) ?? [];
    const hasPointBounds = allGeometryPoints.length > 0;
    const geometryLeft = hasPointBounds
        ? Math.min(...allGeometryPoints.map(point => point.x))
        : shape.x;
    const geometryTop = hasPointBounds
        ? Math.min(...allGeometryPoints.map(point => point.y))
        : shape.y;
    const geometryRight = hasPointBounds
        ? Math.max(...allGeometryPoints.map(point => point.x))
        : null;
    const geometryBottom = hasPointBounds
        ? Math.max(...allGeometryPoints.map(point => point.y))
        : null;
    return {
        kind: 'shape',
        identity: {
            id,
            ...(pdfRef ? {pdfRef} : {}),
        },
        pageIndex: shape.pageIndex,
        revision: 0,
        persistedRevision: pdfRef ? 0 : -1,
        deleted: false,
        createdAt: shape.createdAt ?? null,
        modifiedAt: shape.modifiedAt ?? null,
        author: null,
        tool,
        rect: {
            left: geometryLeft,
            top: geometryTop,
            width: hasPointBounds ? geometryRight! - geometryLeft : shape.width,
            height: hasPointBounds ? geometryBottom! - geometryTop : shape.height,
        },
        ...(geometryPoints === undefined || geometryPoints === null ? {} : {points: structuredClone(geometryPoints)}),
        ...(shape.strokes === undefined ? {} : {strokes: structuredClone(shape.strokes)}),
        strokeColor: shape.color,
        strokeWidth: shape.strokeWidth,
        fill: shape.fillColor ?? null,
        opacity: shape.opacity,
    };
}

export class AnnotationApplication {
    readonly store: AnnotationStore;

    constructor(readonly documentKey: string, store = new AnnotationStore()) {
        this.store = store;
    }

    listReadModels(): readonly IAnnotationReadModel[] {
        return this.store.list({includeDeleted: true}).map(entity => ({
            annotationId: entity.identity.id,
            kind: entity.kind,
            pageIndex: entity.pageIndex,
            text: entity.kind === 'text-box'
                ? entity.text
                : entity.kind === 'note'
                    ? entity.contents
                    : entity.kind === 'text-markup'
                        ? entity.contents
                        : '',
            deleted: entity.deleted,
        }));
    }

    /**
     * Returns the PDF references of deleted canonical annotations. The
     * suppression set is derived from the store's tombstones, so the UI has no
     * second deletion ledger.
     */
    deletedEmbeddedAnnotationIds(): ReadonlySet<string> {
        const ids = new Set<string>();
        this.store.list({includeDeleted: true}).forEach((entity) => {
            if (!entity.deleted) {
                return;
            }
            const annotationId = normalizePdfJsAnnotationId(entity.identity.pdfRef);
            if (annotationId) {
                ids.add(annotationId);
            }
        });
        return ids;
    }

    listCommentSummaries(): readonly IAnnotationCommentSummary[] {
        return this.store.list().flatMap((entity) => {
            if (entity.kind === 'shape') {
                return [];
            }
            const source = entity.persistedRevision >= 0 ? 'pdf' as const : 'editor' as const;
            const externalId = entity.identity.pdfRef ?? entity.identity.id;
            const stableKey: IAnnotationCommentSummary['stableKey'] = entity.identity.pdfRef
                ? `ann:${entity.pageIndex}:${entity.identity.pdfRef}`
                : `ann:${entity.pageIndex}:${entity.identity.id}`;
            const markerRect = entity.kind === 'text-box'
                ? structuredClone(entity.rect)
                : entity.kind === 'note'
                    ? structuredClone(entity.position)
                    : entity.kind === 'text-markup'
                        ? structuredClone(entity.quadPoints[0] ?? null)
                        : structuredClone(entity.rect);
            const text = entity.kind === 'text-box'
                ? entity.text
                : entity.kind === 'note'
                    ? entity.contents
                    : entity.kind === 'text-markup'
                        ? entity.contents
                        : '';
            const subtype = entity.kind === 'text-markup'
                ? entity.subtype
                : entity.kind === 'note'
                    ? 'Text'
                    : entity.kind === 'text-box'
                        ? 'FreeText'
                        : 'Stamp';
            return [{
                source,
                appAnnotationId: entity.identity.id,
                id: externalId,
                stableKey,
                pageIndex: entity.pageIndex,
                pageNumber: entity.pageIndex + 1,
                text,
                ...(entity.kind === 'text-markup'
                    ? {previewText: entity.selectedText ?? null}
                    : {}),
                subtype,
                author: entity.author,
                createdAt: entity.createdAt,
                modifiedAt: entity.modifiedAt,
                color: entity.kind === 'text-box'
                    || entity.kind === 'note'
                    || entity.kind === 'text-markup'
                    ? entity.color
                    : null,
                ...(entity.kind === 'text-markup' ? {opacity: entity.opacity} : {}),
                uid: null,
                annotationId: entity.identity.pdfRef ?? null,
                annotationName: null,
                hasNote: entity.kind === 'note'
                    || (entity.kind !== 'placed-image' && text.length > 0),
                markerRect,
                ...(entity.kind === 'note' && entity.replies
                    ? {replies: entity.replies.map(reply => ({...reply}))}
                    : {}),
                ...(entity.kind === 'text-markup'
                    ? {markupGeometry: structuredClone(entity.quadPoints)}
                    : {}),
            } satisfies IAnnotationCommentSummary];
        });
    }

    annotationIdForSummary(comment: IAnnotationCommentSummary): AnnotationId | null {
        if (comment.appAnnotationId) {
            const id = asAnnotationId(comment.appAnnotationId);
            if (this.store.get(id)) {
                return id;
            }
        }
        const pdfRef = normalizedPdfRef(comment.annotationId);
        if (!pdfRef) {
            return null;
        }
        return this.store.list({includeDeleted: true})
            .find(entity => normalizedPdfRef(entity.identity.pdfRef) === pdfRef)
            ?.identity.id ?? null;
    }

    annotationIdForShape(shape: Pick<IShapeAnnotation, 'id' | 'annotationId'>): AnnotationId | null {
        const byId = this.store.get(asAnnotationId(shape.id));
        if (byId?.kind === 'shape') {
            return byId.identity.id;
        }
        const pdfRef = normalizedPdfRef(shape.annotationId);
        return pdfRef
            ? this.store.list({includeDeleted: true})
                .find(entity => entity.kind === 'shape'
                    && normalizedPdfRef(entity.identity.pdfRef) === pdfRef)
                ?.identity.id ?? null
            : null;
    }

    toLegacyShape(entity: IShapeEntity): IShapeAnnotation {
        return toLegacyShapeAnnotation(entity);
    }

    remapPages(delta: IPageIdentityDelta) {
        this.store.remapPages(delta);
    }

    beginSave(documentRevisionToken: TDocumentRevisionToken | null = null): IAnnotationSaveSession {
        const frontier = this.store.beginSave(documentRevisionToken);
        const dirty = this.store.dirtyEntities();
        return {
            frontier,
            plan: buildSerializationPlan(
                frontier,
                dirty,
                this.store.list({includeDeleted: true}),
            ),
        };
    }

    acknowledgeSave(
        session: IAnnotationSaveSession,
        currentDocumentRevisionToken: TDocumentRevisionToken | null = session.frontier.documentRevisionToken,
    ) {
        this.store.markPersisted(
            session.frontier,
            [],
            currentDocumentRevisionToken,
        );
    }

    /** Reports whether this authority still owned the failed save's frontier. */
    rollbackSave(session: IAnnotationSaveSession) {
        return this.store.rollbackToSaveFrontier(session.frontier);
    }

    assertSaveCurrent(
        session: IAnnotationSaveSession,
        currentDocumentRevisionToken: TDocumentRevisionToken | null = session.frontier.documentRevisionToken,
    ) {
        this.store.assertSaveFrontierCurrent(session.frontier, currentDocumentRevisionToken);
    }


}
