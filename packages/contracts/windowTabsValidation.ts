import {parseDocumentInstanceId} from '@contracts/documentInstanceId';
import {parseDocumentRef} from '@contracts/documentRef';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {parseSessionId} from '@contracts/shared';
import {parseTabId} from '@contracts/windowTabs';
import * as v from 'valibot';

export const windowTabDocumentRefSchema = v.pipe(
    v.string('invalid window tab transfer'),
    v.check(value => parseDocumentRef(value) !== null, 'invalid window tab transfer'),
    v.transform(value => parseDocumentRef(value)!),
);
const documentBackendSchema = v.picklist([
    'browser',
    'electron',
], 'invalid window tab transfer');
const positivePageSchema = v.pipe(
    v.number('invalid window tab transfer'),
    v.check(value => Number.isSafeInteger(value) && value > 0, 'invalid window tab transfer'),
);
const transferredTabStateSchema = v.pipe(
    v.object({
        fileName: v.nullable(v.string('invalid window tab transfer')),
        originalPath: v.nullable(windowTabDocumentRefSchema),
        originalBackend: v.optional(documentBackendSchema),
        documentInstanceId: v.optional(v.nullable(v.pipe(
            v.string('invalid window tab transfer'),
            v.check(value => parseDocumentInstanceId(value) !== null, 'invalid window tab transfer'),
            v.transform(value => parseDocumentInstanceId(value)!),
        ))),
        isDirty: v.boolean('invalid window tab transfer'),
        isDjvu: v.boolean('invalid window tab transfer'),
    }, 'invalid window tab transfer'),
    v.transform(value => ({
        fileName: value.fileName,
        originalPath: value.originalPath,
        ...(value.originalBackend === undefined ? {} : {originalBackend: value.originalBackend}),
        ...(value.documentInstanceId === undefined ? {} : {documentInstanceId: value.documentInstanceId}),
        isDirty: value.isDirty,
        isDjvu: value.isDjvu,
    })),
);
export type ITransferredTabState = v.InferOutput<typeof transferredTabStateSchema>;
export type ITabMetadataCore = ITransferredTabState;

const emptySplitPayloadSchema = v.object({kind: v.literal('empty')}, 'invalid window tab transfer');
const djvuSplitPayloadSchema = v.pipe(
    v.object({
        kind: v.literal('djvu'),
        sourcePath: windowTabDocumentRefSchema,
        sourceBackend: v.optional(documentBackendSchema),
        currentPage: v.optional(positivePageSchema),
        totalPages: v.optional(positivePageSchema),
    }, 'invalid window tab transfer'),
    v.transform(value => ({
        kind: value.kind,
        sourcePath: value.sourcePath,
        ...(value.sourceBackend === undefined ? {} : {sourceBackend: value.sourceBackend}),
        ...(value.currentPage === undefined ? {} : {currentPage: value.currentPage}),
        ...(value.totalPages === undefined ? {} : {totalPages: value.totalPages}),
    })),
);
const pdfSnapshotSplitPayloadSchema = v.pipe(
    v.object({
        kind: v.literal('pdfSnapshot'),
        fileName: v.string('invalid window tab transfer'),
        originalPath: v.nullable(windowTabDocumentRefSchema),
        originalBackend: v.optional(documentBackendSchema),
        snapshotPath: windowTabDocumentRefSchema,
        snapshotBackend: v.optional(documentBackendSchema),
        isDirty: v.boolean('invalid window tab transfer'),
        isGenerated: v.optional(v.boolean('invalid window tab transfer')),
        currentPage: v.optional(positivePageSchema),
        totalPages: v.optional(positivePageSchema),
    }, 'invalid window tab transfer'),
    v.transform(value => ({
        kind: value.kind,
        fileName: value.fileName,
        originalPath: value.originalPath,
        ...(value.originalBackend === undefined ? {} : {originalBackend: value.originalBackend}),
        snapshotPath: value.snapshotPath,
        ...(value.snapshotBackend === undefined ? {} : {snapshotBackend: value.snapshotBackend}),
        isDirty: value.isDirty,
        ...(value.isGenerated === undefined ? {} : {isGenerated: value.isGenerated}),
        ...(value.currentPage === undefined ? {} : {currentPage: value.currentPage}),
        ...(value.totalPages === undefined ? {} : {totalPages: value.totalPages}),
    })),
);
export const splitPayloadSchema = v.union([
    emptySplitPayloadSchema,
    djvuSplitPayloadSchema,
    pdfSnapshotSplitPayloadSchema,
], 'invalid window tab transfer');
export type TSplitPayload = v.InferOutput<typeof splitPayloadSchema>;
export type IEmptySplitPayload = v.InferOutput<typeof emptySplitPayloadSchema>;
export type IDjvuSplitPayload = v.InferOutput<typeof djvuSplitPayloadSchema>;
export type IPdfSnapshotSplitPayload = v.InferOutput<typeof pdfSnapshotSplitPayloadSchema>;

const transferTargetSchema = v.union([
    v.object({kind: v.literal('new-window')}, 'invalid window tab transfer request'),
    v.object({
        kind: v.literal('window'),
        windowId: v.pipe(
            v.number('invalid window tab transfer request'),
            v.check(value => Number.isSafeInteger(value) && value > 0, 'invalid window tab transfer request'),
        ),
    }, 'invalid window tab transfer request'),
], 'invalid window tab transfer request');
export type TWindowTabTransferTarget = v.InferOutput<typeof transferTargetSchema>;
const transferSessionSchema = v.pipe(
    v.object({
        sessionId: v.pipe(
            v.string('invalid window tab transfer request'),
            v.check(value => parseSessionId(value) !== null, 'invalid window tab transfer request'),
            v.transform(value => parseSessionId(value)!),
        ),
        sessionRevision: v.pipe(
            v.number('invalid window tab transfer request'),
            v.check(value => Number.isSafeInteger(value) && value >= 0, 'invalid window tab transfer request'),
        ),
        documentRef: v.nullable(windowTabDocumentRefSchema),
        documentBackend: v.optional(v.picklist([
            'browser',
            'electron',
        ], 'invalid window tab transfer request')),
        documentInstanceId: v.optional(v.nullable(v.pipe(
            v.string('invalid window tab transfer request'),
            v.check(value => parseDocumentInstanceId(value) !== null, 'invalid window tab transfer request'),
            v.transform(value => parseDocumentInstanceId(value)!),
        ))),
        documentRevisionToken: v.optional(v.pipe(
            v.string('invalid window tab transfer request'),
            v.check(value => parseDocumentRevisionToken(value) !== null, 'invalid window tab transfer request'),
            v.transform(value => parseDocumentRevisionToken(value)!),
        )),
    }, 'invalid window tab transfer request'),
    v.transform(value => ({
        sessionId: value.sessionId,
        sessionRevision: value.sessionRevision,
        documentRef: value.documentRef,
        ...(value.documentBackend === undefined ? {} : {documentBackend: value.documentBackend}),
        ...(value.documentInstanceId === undefined ? {} : {documentInstanceId: value.documentInstanceId}),
        ...(value.documentRevisionToken === undefined ? {} : {documentRevisionToken: value.documentRevisionToken}),
    })),
);
export type IWindowTabTransferSessionState = v.InferOutput<typeof transferSessionSchema>;

export const windowTabTransferRequestSchema = v.pipe(
    v.object({
        target: transferTargetSchema,
        tab: transferredTabStateSchema,
        payload: splitPayloadSchema,
        session: v.optional(transferSessionSchema),
        timeoutMs: v.optional(v.pipe(
            v.number('invalid window tab transfer request'),
            v.finite('invalid window tab transfer request'),
            v.check(value => value > 0, 'invalid window tab transfer request'),
        )),
    }, 'invalid window tab transfer request'),
    v.transform(value => ({
        target: value.target,
        tab: value.tab,
        payload: value.payload,
        ...(value.session === undefined ? {} : {session: value.session}),
        ...(value.timeoutMs === undefined ? {} : {timeoutMs: value.timeoutMs}),
    })),
);
export type IWindowTabTransferRequest = v.InferOutput<typeof windowTabTransferRequestSchema>;

export const windowTabIncomingTransferSchema = v.pipe(
    v.object({
        transferId: v.pipe(
            v.string('invalid window tab incoming transfer'),
            v.check(value => value.trim().length > 0, 'invalid window tab incoming transfer'),
            v.transform(value => value.trim()),
        ),
        sourceWindowId: v.pipe(
            v.number('invalid window tab incoming transfer'),
            v.check(value => Number.isSafeInteger(value) && value > 0, 'invalid window tab incoming transfer'),
        ),
        targetWindowId: v.pipe(
            v.number('invalid window tab incoming transfer'),
            v.check(value => Number.isSafeInteger(value) && value > 0, 'invalid window tab incoming transfer'),
        ),
        tab: transferredTabStateSchema,
        payload: splitPayloadSchema,
        session: v.optional(transferSessionSchema),
    }, 'invalid window tab incoming transfer'),
    v.transform(value => ({
        transferId: value.transferId,
        sourceWindowId: value.sourceWindowId,
        targetWindowId: value.targetWindowId,
        tab: value.tab,
        payload: value.payload,
        ...(value.session === undefined ? {} : {session: value.session}),
    })),
);
export type IWindowTabIncomingTransfer = v.InferOutput<typeof windowTabIncomingTransferSchema>;

export const windowTabTransferAckSchema = v.pipe(
    v.object({
        transferId: v.pipe(
            v.string('invalid window tab transfer acknowledgement'),
            v.check(value => value.trim().length > 0, 'invalid window tab transfer acknowledgement'),
        ),
        success: v.boolean('invalid window tab transfer acknowledgement'),
        error: v.optional(v.string('invalid window tab transfer acknowledgement')),
    }, 'invalid window tab transfer acknowledgement'),
    v.transform(value => ({
        transferId: value.transferId,
        success: value.success,
        ...(value.error === undefined ? {} : {error: value.error}),
    })),
);
export type IWindowTabTransferAck = v.InferOutput<typeof windowTabTransferAckSchema>;

export const windowTabTransferResultSchema = v.pipe(
    v.object({
        transferId: v.string('invalid window tab transfer result'),
        success: v.boolean('invalid window tab transfer result'),
        targetWindowId: v.pipe(
            v.number('invalid window tab transfer result'),
            v.check(value => Number.isSafeInteger(value), 'invalid window tab transfer result'),
        ),
        error: v.optional(v.string('invalid window tab transfer result')),
    }, 'invalid window tab transfer result'),
    v.transform(value => ({
        transferId: value.transferId,
        success: value.success,
        targetWindowId: value.targetWindowId,
        ...(value.error === undefined ? {} : {error: value.error}),
    })),
);
export type IWindowTabTransferResult = v.InferOutput<typeof windowTabTransferResultSchema>;

export const windowTabTargetWindowsSchema = v.array(v.pipe(
    v.object({
        windowId: v.pipe(
            v.number('invalid window tab target windows'),
            v.check(value => Number.isSafeInteger(value) && value > 0, 'invalid window tab target windows'),
        ),
        label: v.pipe(
            v.string('invalid window tab target windows'),
            v.check(value => value.trim().length > 0, 'invalid window tab target windows'),
        ),
    }, 'invalid window tab target windows'),
), 'invalid window tab target windows');
export type IWindowTabTargetWindow = v.InferOutput<typeof windowTabTargetWindowsSchema>[number];

const tabIdSchema = v.pipe(
    v.string('invalid window tabs action'),
    v.check(value => {
        const tabId = parseTabId(value);
        return tabId !== null && tabId.length <= 512;
    }, 'invalid window tabs action'),
    v.transform(value => parseTabId(value)!),
);
const closeTabActionSchema = v.pipe(
    v.object({
        kind: v.literal('close-tab'),
        tabId: v.optional(tabIdSchema),
    }, 'invalid window tabs action'),
    v.transform(value => ({
        kind: value.kind,
        ...(value.tabId === undefined ? {} : {tabId: value.tabId}),
    })),
);
const moveToNewWindowActionSchema = v.pipe(
    v.object({
        kind: v.literal('move-tab-to-new-window'),
        tabId: v.optional(tabIdSchema),
    }, 'invalid window tabs action'),
    v.transform(value => ({
        kind: value.kind,
        ...(value.tabId === undefined ? {} : {tabId: value.tabId}),
    })),
);
const moveToWindowActionSchema = v.pipe(
    v.object({
        kind: v.literal('move-tab-to-window'),
        targetWindowId: v.pipe(
            v.number('invalid window tabs action'),
            v.check(value => Number.isSafeInteger(value) && value > 0, 'invalid window tabs action'),
        ),
        tabId: v.optional(tabIdSchema),
    }, 'invalid window tabs action'),
    v.transform(value => ({
        kind: value.kind,
        targetWindowId: value.targetWindowId,
        ...(value.tabId === undefined ? {} : {tabId: value.tabId}),
    })),
);
const mergeWindowActionSchema = v.object({
    kind: v.literal('merge-window-into'),
    targetWindowId: v.pipe(
        v.number('invalid window tabs action'),
        v.check(value => Number.isSafeInteger(value) && value > 0, 'invalid window tabs action'),
    ),
}, 'invalid window tabs action');
export const windowTabsActionSchema = v.union([
    closeTabActionSchema,
    moveToNewWindowActionSchema,
    moveToWindowActionSchema,
    mergeWindowActionSchema,
], 'invalid window tabs action');
export type TWindowTabsAction = v.InferOutput<typeof windowTabsActionSchema>;

export const windowTabPaneDirectionSchema = v.picklist(
    [
        'left',
        'right',
        'up',
        'down',
    ],
    'invalid pane direction',
);

export function decodeWindowTabPaneDirection(value: unknown): v.InferOutput<typeof windowTabPaneDirectionSchema> | null {
    const result = v.safeParse(windowTabPaneDirectionSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export function decodeWindowTabTransferRequest(value: unknown): IWindowTabTransferRequest | null {
    const result = v.safeParse(windowTabTransferRequestSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export function decodeWindowTabIncomingTransfer(value: unknown): IWindowTabIncomingTransfer | null {
    const result = v.safeParse(windowTabIncomingTransferSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export function decodeWindowTabsAction(value: unknown): TWindowTabsAction | null {
    const result = v.safeParse(windowTabsActionSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export function decodeWindowTabTransferAck(value: unknown): IWindowTabTransferAck | null {
    const result = v.safeParse(windowTabTransferAckSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export function decodeWindowTabTransferResult(value: unknown): IWindowTabTransferResult | null {
    const result = v.safeParse(windowTabTransferResultSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export function decodeWindowTabTargetWindows(value: unknown): IWindowTabTargetWindow[] | null {
    const result = v.safeParse(windowTabTargetWindowsSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}
