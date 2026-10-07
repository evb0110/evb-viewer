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
import {parsePageIndex} from '@contracts/pageNumbers';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import {PDF_PAGE_LABEL_STYLE_VALUES} from '@contracts/pdfPageLabels';

const editRevisionSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const bookmarkRecoveryEntrySchema: v.GenericSchema<unknown, IPdfBookmarkEntry> = v.lazy(() => v.object({
    title: v.string(),
    pageIndex: v.nullable(v.pipe(v.number(), v.check(value => parsePageIndex(value) !== null), v.transform(value => parsePageIndex(value)!))),
    pageYRatio: v.exactOptional(v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)))),
    namedDest: v.nullable(v.string()),
    bold: v.boolean(),
    italic: v.boolean(),
    color: v.nullable(v.string()),
    items: v.array(bookmarkRecoveryEntrySchema),
}));

/** Metadata travels in the existing identity-bound document recovery artifact. */
export const workspaceMetadataRecoverySchema = v.object({
    bookmarks: v.optional(v.object({
        revision: editRevisionSchema,
        dirty: v.literal(true),
        items: v.array(bookmarkRecoveryEntrySchema),
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
export function readWorkspaceRecoveryMetadata(value: unknown) {
    return v.parse(documentRecoveryMetadataSchema, value).metadata;
}

const MAX_CHECKPOINT_TABS = 128;
const paneIdSchema = v.pipe(v.string(), v.check(value => parsePaneId(value) !== null), v.transform(value => parsePaneId(value)!));
const tabIdSchema = v.pipe(v.string(), v.check(value => parseTabId(value) !== null), v.transform(value => parseTabId(value)!));
const documentRefSchema = v.pipe(v.string(), v.check(value => parseDocumentRef(value) !== null), v.transform(value => parseDocumentRef(value)!));
const nullablePaneIdSchema = v.nullable(paneIdSchema);
const nullableTabIdSchema = v.nullable(tabIdSchema);
const nullableDocumentRefSchema = v.nullable(documentRefSchema);
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

const annotationRecoverySchema = v.object({
    artifactId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/u)),
    documentInstanceId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    workingCopyRef: nullableDocumentRefSchema,
    workingByteRevision: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    annotationMutationGeneration: v.pipe(v.number(), v.check(value => Number.isSafeInteger(value)), v.minValue(0)),
    payload: v.optional(v.unknown()),
});

const paneSchema = v.object({
    paneId: paneIdSchema,
    tabIds: v.pipe(v.array(tabIdSchema), v.maxLength(MAX_CHECKPOINT_TABS)),
    activeTabId: nullableTabIdSchema,
});

const checkpointTabSchema = v.object({
    tabId: tabIdSchema,
    paneId: nullablePaneIdSchema,
    fileName: v.nullable(v.string()),
    sourceRef: nullableDocumentRefSchema,
    workingCopyRef: nullableDocumentRefSchema,
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
    activePaneId: nullablePaneIdSchema,
    activeTabId: nullableTabIdSchema,
    layout: layoutSchema,
    panes: v.pipe(v.array(paneSchema), v.maxLength(32)),
    tabs: v.pipe(v.array(checkpointTabSchema), v.maxLength(MAX_CHECKPOINT_TABS)),
});

export type TWorkspaceCheckpointSurfaceMode = 'reader' | 'scan-cleanup';
export type IWorkspaceCheckpointAnnotationRecovery = v.InferOutput<typeof annotationRecoverySchema>;
export type IWorkspaceCheckpointTab = v.InferOutput<typeof checkpointTabSchema>;
export type IWorkspaceCheckpointPane = v.InferOutput<typeof paneSchema>;
export type IWorkspaceCheckpoint = v.InferOutput<typeof workspaceCheckpointSchema>;

export const workspaceCheckpointRecordSchema = workspaceCheckpointSchema;

export function decodeWorkspaceCheckpoint(value: unknown): IWorkspaceCheckpoint | null {
    const result = v.safeParse(workspaceCheckpointRecordSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}
