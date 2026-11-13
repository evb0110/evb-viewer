import * as v from 'valibot';
import {parsePaneId} from '@contracts/editorPanes';
import type {TEditorLayoutNode} from '@contracts/editorPanes';
import {parseDocumentRef} from '@contracts/documentRef';
import {parseTabId} from '@contracts/windowTabs';
import {
    VIEW_MODE_SCHEMA as viewModeSchema,
    VIEW_ROTATION_SCHEMA as viewRotationSchema,
    ZOOM_MODE_SCHEMA as zoomModeSchema,
} from '@contracts/recentReadingView';
import {parseEpochMs} from '@contracts/timestamps';
import {PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA} from '@contracts/pdfBookmarkEntry';
import {PDF_PAGE_LABEL_STYLE_VALUES} from '@contracts/pdfPageLabels';
import {isRecord} from '@contracts/runtimeGuards';

export const ANNOTATION_RASTER_MAX_BYTES = 128 * 1024 * 1024;
const recoveryRasterSchema = v.object({
    kind: v.literal('raster'),
    mimeType: v.picklist([
        'image/png',
        'image/jpeg',
    ]),
    dataBase64: v.pipe(v.string(), v.maxLength(Math.ceil(ANNOTATION_RASTER_MAX_BYTES / 3) * 4)),
    byteLength: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(ANNOTATION_RASTER_MAX_BYTES)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
    width: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(32_768)),
    height: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(32_768)),
});
export type IWorkspaceRecoveryRaster = v.InferOutput<typeof recoveryRasterSchema>;

/** Raster bytes have their own durable storage; only their metadata consumes the JSON budget. */
export function mapWorkspaceRecoveryRasters(
    payload: unknown,
    transform: (image: IWorkspaceRecoveryRaster, entityIndex: number) => IWorkspaceRecoveryRaster,
): unknown {
    if (!isRecord(payload) || !Array.isArray(payload.entities)) return payload;
    return {
        ...payload,
        entities: payload.entities.map((entity: unknown, index: number) => {
            if (!isRecord(entity) || entity.kind !== 'placed-image'
                || !isRecord(entity.image) || entity.image.kind !== 'raster') return entity;
            return {
                ...entity,
                image: transform(v.parse(recoveryRasterSchema, entity.image), index),
            };
        }),
    };
}

const editRevisionSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** Metadata travels in the existing identity-bound document recovery artifact. */
export const workspaceMetadataRecoverySchema = v.object({
    bookmarks: v.optional(v.object({
        revision: editRevisionSchema,
        dirty: v.literal(true),
        items: v.array(PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA),
    })),
    pageLabels: v.optional(v.object({
        revision: editRevisionSchema,
        dirty: v.literal(true),
        ranges: v.array(v.object({
            startPage: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
            style: v.nullable(v.picklist(PDF_PAGE_LABEL_STYLE_VALUES)),
            prefix: v.string(),
            startNumber: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        })),
    })),
});
export type IWorkspaceMetadataRecovery = v.InferOutput<typeof workspaceMetadataRecoverySchema>;

const documentRecoveryMetadataSchema = v.object({metadata: v.optional(workspaceMetadataRecoverySchema)});
export const readWorkspaceRecoveryMetadata = (value: unknown) => v.parse(documentRecoveryMetadataSchema, value).metadata;

const paneIdSchema = v.pipe(v.string(), v.check(value => parsePaneId(value) !== null), v.transform(value => parsePaneId(value)!));
const tabIdSchema = v.pipe(v.string(), v.check(value => parseTabId(value) !== null), v.transform(value => parseTabId(value)!));
const documentRefSchema = v.pipe(v.string(), v.check(value => parseDocumentRef(value) !== null), v.transform(value => parseDocumentRef(value)!));
const epochMsSchema = v.pipe(v.number(), v.check(value => parseEpochMs(value) !== null), v.transform(value => parseEpochMs(value)!));
function createLayoutNodeSchema(depth: number): v.GenericSchema<unknown, TEditorLayoutNode> {
    const leafSchema = v.object({
        type: v.literal('leaf'),
        paneId: paneIdSchema,
    });
    if (depth === 16) {
        return v.lazy(() => leafSchema);
    }
    return v.lazy(() => v.union([
        leafSchema,
        v.object({
            type: v.literal('split'),
            id: v.string(),
            orientation: v.picklist([
                'horizontal',
                'vertical',
            ]),
            ratio: v.pipe(v.number(), v.finite()),
            first: createLayoutNodeSchema(depth + 1),
            second: createLayoutNodeSchema(depth + 1),
        }),
    ]));
}
const layoutSchema: v.GenericSchema<unknown, TEditorLayoutNode | null> = v.lazy(() => v.nullable(createLayoutNodeSchema(0)));

export const workspaceAnnotationRecoveryRefSchema = v.object({
    artifactId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/u)),
    documentInstanceId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    workingCopyRef: v.nullable(documentRefSchema),
    workingByteRevision: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    annotationMutationGeneration: v.pipe(v.number(), v.check(value => Number.isSafeInteger(value)), v.minValue(0)),
});
const annotationRecoverySchema = v.object({
    ...workspaceAnnotationRecoveryRefSchema.entries,
    payload: v.optional(v.unknown()),
});

const paneSchema = v.object({
    paneId: paneIdSchema,
    tabIds: v.array(tabIdSchema),
    activeTabId: v.nullable(tabIdSchema),
});

const checkpointTabSchema = v.object({
    tabId: tabIdSchema,
    paneId: v.nullable(paneIdSchema),
    fileName: v.nullable(v.string()),
    sourceRef: v.nullable(documentRefSchema),
    workingCopyRef: v.nullable(documentRefSchema),
    // A later view of the document an earlier tab holds, so it comes back
    // linked even when no working copy is retained for a clean document.
    linkedToTabId: v.optional(tabIdSchema),
    // Set by a claim: the file a rolled-back save kept beside the PDF, named when the tab reopens its working copy.
    keptOriginalPath: v.optional(documentRefSchema),
    requiresSaveAsOnFirstSave: v.optional(v.boolean()),
    isDirty: v.boolean(),
    isDjvu: v.boolean(),
    currentPage: v.nullable(v.pipe(v.number(), v.check(value => Number.isSafeInteger(value)), v.minValue(1))),
    zoom: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(Number.MIN_VALUE))),
    zoomMode: v.nullable(zoomModeSchema),
    continuousScroll: v.optional(v.nullable(v.boolean())),
    viewMode: v.optional(v.nullable(viewModeSchema)),
    viewRotation: v.optional(v.nullable(viewRotationSchema)),
    annotationRecovery: v.optional(annotationRecoverySchema),
    workingCopyLost: v.optional(v.literal(true)),
    annotationRecoveryFailure: v.optional(v.object({
        reason: v.literal('capture-rejected'),
        message: v.pipe(v.string(), v.maxLength(4096)),
    })),
    surfaceMode: v.optional(v.picklist([
        'reader',
        'scan-cleanup',
    ])),
});

export const workspaceCheckpointSchema = v.object({
    version: v.literal(1),
    capturedAt: epochMsSchema,
    activePaneId: v.nullable(paneIdSchema),
    activeTabId: v.nullable(tabIdSchema),
    layout: layoutSchema,
    panes: v.pipe(v.array(paneSchema), v.maxLength(32)),
    tabs: v.array(checkpointTabSchema),
    notReopened: v.optional(v.array(v.object({
        fileName: v.nullable(v.string()),
        sourceRef: v.nullable(documentRefSchema),
    }))),
});

export type IWorkspaceCheckpointAnnotationRecovery = v.InferOutput<typeof annotationRecoverySchema>;
export type IWorkspaceCheckpointTab = v.InferOutput<typeof checkpointTabSchema>;
export type IWorkspaceCheckpoint = v.InferOutput<typeof workspaceCheckpointSchema>;

export function decodeWorkspaceCheckpoint(value: unknown): IWorkspaceCheckpoint | null {
    const result = v.safeParse(workspaceCheckpointSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

/**
 * The checkpoint as the document store keeps it: tabs, panes, views and document references. Whether a tab holds
 * unsaved work and its drafts are its document's manifest's; failures are the live window's.
 */
export function toStoredWorkspaceCheckpoint(checkpoint: IWorkspaceCheckpoint) {
    return {
        ...checkpoint,
        tabs: checkpoint.tabs.map(({
            isDirty: _dirty,
            keptOriginalPath: _kept,
            annotationRecovery: _drafts,
            annotationRecoveryFailure: _failure,
            workingCopyLost: _lost,
            ...tab
        }) => tab),
    };
}

/** A stored checkpoint read back. Its tabs read as clean until their manifests are consulted. */
export function decodeStoredWorkspaceCheckpoint(value: unknown) {
    return isRecord(value) && Array.isArray(value.tabs)
        ? decodeWorkspaceCheckpoint({...value, tabs: value.tabs.map((tab: unknown) => (isRecord(tab) ? {...tab, isDirty: false} : tab))})
        : null;
}
