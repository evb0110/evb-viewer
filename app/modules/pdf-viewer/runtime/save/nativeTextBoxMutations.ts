import type {
    IPdfDocument, IPdfPage, IPdfAnnotation,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    IPdfNativeTextBoxMutation, IPdfNativeTextBoxAppearanceRequest,
} from '@contracts/electronApiDocuments';
import {PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS} from '@contracts/nativePdfMutations';
import type {
    IPdfAnnotationParseResult, TPdfAnnotationParseEntity,
} from '@contracts/pdfAnnotationParseTypes';
import type {IPdfAnnotationRenderInput} from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import {getPageOpsCapability} from '@app/utils/platformDocuments';
import {readPdfDocumentOriginalAnnotations} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentLoadedRevision';
import {mapPdfAnnotationParseEntity} from '@app/modules/pdf-viewer/runtime/sessions/mapPdfAnnotationParseEntity';
import { requirePageIndex } from '@contracts/pageNumbers';
import {
    semanticEntityFingerprint, type AnnotationEntity, type ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { toPdfRectFromMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toPdfRectFromMarkerRect';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import { parseCssRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/parseCssRgbColor';
import type { ISerializationPlan } from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    formatPdfJsAnnotationRef,
    parsePdfAnnotationRef,
    normalizePdfJsAnnotationId,
} from '@app/utils/pdfAnnotationRefs';

interface IPdfTextBoxPageReader {getPage(pageNumber: number): Promise<Pick<IPdfPage, 'rotate' | 'view'>>;}

export function isReplayableCanonicalTextBox(comment: IAnnotationCommentSummary) {
    const markerRect = normalizeMarkerRect(comment.markerRect);
    return comment.source === 'editor'
        && Boolean(comment.appAnnotationId)
        && comment.annotationId === null
        && comment.subtype?.trim().toLowerCase() === 'freetext'
        && Boolean(markerRect);
}

function isChangedTextBox(entity: ISerializationPlan['expected'][number]): entity is ITextBoxEntity {
    return entity.kind === 'text-box'
        && !entity.deleted
        && entity.revision !== entity.persistedRevision;
}

export function toNativeTextBox(
    entity: ITextBoxEntity,
    pageView: readonly number[],
    pageRotation: TPageRotation,
): IPdfNativeTextBoxMutation | null {
    const rect = toPdfRectFromMarkerRect(entity.rect, [...pageView], pageRotation, {preserveUnrotatedBounds: true});
    const color = entity.color === null
        ? {
            r: 0,
            g: 0,
            b: 0,
        }
        : parseCssRgbColor(entity.color);
    if (!rect || !color) {
        return null;
    }
    const parsedPdfRef = entity.identity.pdfRef
        ? parsePdfAnnotationRef(entity.identity.pdfRef)
        : null;
    if (entity.identity.pdfRef && !parsedPdfRef) {
        return null;
    }

    return {
        pageIndex: requirePageIndex(entity.pageIndex),
        // New native text boxes use the canonical id as /NM so the writer's
        // identity binding can be acknowledged by the annotation store.
        stableKey: entity.identity.id,
        ...(parsedPdfRef ? {annotationId: formatPdfJsAnnotationRef(parsedPdfRef)} : {}),
        text: entity.text,
        rect,
        rotation: entity.rotation,
        fontSize: entity.fontSize,
        color: [
            Math.round(color.r),
            Math.round(color.g),
            Math.round(color.b),
        ],
        author: entity.author,
        createdAt: entity.createdAt,
        modifiedAt: entity.modifiedAt,
    };
}

/** Native parse identity is bound to its captured revision, never a clean-state guess. */
export function parsedAnnotationForEntity(entity: AnnotationEntity, parsed: IPdfAnnotationParseResult | null) {
    return parsed?.entities.find(entry => entry.name === entity.identity.id)
        ?? parsed?.entities.find(entry => normalizePdfJsAnnotationId(`${entry.objectNumber} ${entry.generationNumber} R`)
            === normalizePdfJsAnnotationId(entity.identity.pdfRef));
}

export function originalAnnotationPaintRef(document: IPdfDocument | null, entity: AnnotationEntity) {
    const entry = document && parsedAnnotationForEntity(entity, readPdfDocumentOriginalAnnotations(document));
    return entry ? normalizePdfJsAnnotationId(`${entry.objectNumber} ${entry.generationNumber} R`) : null;
}

function matchesParsed(entity: AnnotationEntity, parsed: TPdfAnnotationParseEntity | undefined) {
    return parsed !== undefined && semanticEntityFingerprint(entity) === semanticEntityFingerprint(mapPdfAnnotationParseEntity(parsed));
}

function appearanceInput(entity: ITextBoxEntity, page: IPdfPage, parsed: IPdfAnnotationParseResult | null, preserveSavedAppearance: boolean, original?: IPdfAnnotationParseResult | null) {
    const textBox = toNativeTextBox(entity, page.view, normalizePageRotation(page.rotate));
    if (!textBox) throw new Error('Text appearance page geometry is unavailable');
    const entry = parsedAnnotationForEntity(entity, parsed) ?? parsedAnnotationForEntity(entity, original ?? null);
    const source = entry?.kind === 'text-box' ? entry.source : undefined;
    if (preserveSavedAppearance && entry?.kind === 'text-box' && entry.recoveryData && matchesParsed(entity, entry)) {
        textBox.originalAppearance = {recoveryData: entry.recoveryData};
    }
    return {
        textBox,
        ...(source ? {source} : {}),
    };
}

function appearancePage(page: IPdfPage): IPdfNativeTextBoxAppearanceRequest['page'] {
    if (page.view.length !== 4) throw new Error('Text appearance page bounds are unavailable');
    return {
        view: [
            page.view[0]!,
            page.view[1]!,
            page.view[2]!,
            page.view[3]!,
        ],
        rotation: normalizePageRotation(page.rotate),
        userUnit: page.getViewport({scale: 1}).userUnit,
    };
}

export async function fitNativeTextBox(
    entity: ITextBoxEntity,
    page: IPdfPage,
    parsed: IPdfAnnotationParseResult | null,
    workingCopyPath: string | null,
    signal?: AbortSignal,
) {
    const result = await getPageOpsCapability().renderTextBoxAppearance(workingCopyPath, {
        page: appearancePage(page),
        textBoxes: [appearanceInput(entity, page, parsed, false)],
    }, signal ? {signal} : {});
    return {
        rect: entity.rect,
        fontSize: result.textBoxes[0]!.fittedFontSize,
    };
}

/**
 * What one page's annotation pixels depend on: each entity's saved-semantic
 * fingerprint (images by digest), plus the identity, exact geometry and
 * frame it omits, and the page's editor. A page without entities has none.
 */
export function nativeAnnotationPaintIdentity(entities: readonly AnnotationEntity[], editingId: string | null, revision: string | null, editingDraft: boolean) {
    if (!entities.length) return '';
    return JSON.stringify([
        revision,
        entities.map(entity => [
            entity.identity,
            semanticEntityFingerprint(entity),
            entity.kind === 'note' ? entity.position : entity.kind === 'text-markup' ? entity.quadPoints : entity.rect,
            entity.kind === 'shape' ? [
                entity.points,
                entity.strokes,
            ] : entity.kind === 'text-box' ? [
                entity.frame,
                entity.readOnly,
            ] : null,
        ]),
        entities.some(entity => entity.identity.id === editingId) ? [
            editingId,
            editingDraft,
        ] : null,
    ]);
}

/** One captured page demand, using only the current committed render as a reusable derived result. */
export async function prepareNativeTextBoxPagePaint(options: {
    document: IPdfDocument;
    page: IPdfPage;
    annotations: readonly IPdfAnnotation[];
    /** The page's paint inputs; an accepted text box is already in them and no longer the editor. */
    entities: readonly AnnotationEntity[];
    excludedIds: ReadonlySet<string>;
    editingId: string | null;
    editingDraft: boolean;
    writerParse: IPdfAnnotationParseResult | null;
    workingCopyPath: string | null;
    currentInput?: IPdfAnnotationRenderInput | undefined;
    signature: string;
    signal?: AbortSignal | undefined;
    reserveAppearanceBytes?: ((bytes: number) => void) | undefined;
}): Promise<IPdfAnnotationRenderInput> {
    const {
        document, page, annotations, entities, writerParse, signal,
    } = options;
    const original = readPdfDocumentOriginalAnnotations(document);
    const excludedIds = new Set(options.excludedIds);
    const loadedIds = new Set(annotations.flatMap(annotation => normalizePdfJsAnnotationId(annotation.id) ?? []));
    const originalEntries = original?.entities.filter(entry => entry.pageIndex + 1 === page.pageNumber) ?? [];
    originalEntries.forEach(entry => {
        if (entry.kind !== 'text-box' || !entry.readOnly) excludedIds.add(normalizePdfJsAnnotationId(`${entry.objectNumber} ${entry.generationNumber} R`)!);
    });
    const originalById = new Map(originalEntries.flatMap(entry => entry.name ? [[
        entry.name,
        entry,
    ] as const] : []));
    const originalByRef = new Map(originalEntries.map(entry => [
        normalizePdfJsAnnotationId(`${entry.objectNumber} ${entry.generationNumber} R`),
        entry,
    ]));
    const entryFor = (entity: AnnotationEntity) => originalById.get(entity.identity.id) ?? originalByRef.get(normalizePdfJsAnnotationId(entity.identity.pdfRef));
    const sourceId = (entity: AnnotationEntity) => {
        const entry = entryFor(entity);
        const ref = entry && normalizePdfJsAnnotationId(`${entry.objectNumber} ${entry.generationNumber} R`);
        return ref && loadedIds.has(ref) ? ref : null;
    };
    const retained = entities.filter(entity => entity.kind !== 'note' && sourceId(entity)
        && !(entity.identity.id === options.editingId && options.editingDraft)
        && matchesParsed(entity, entryFor(entity)));
    // Flatten unchanged source siblings with text boxes so PDF order/blending stays in one canvas.
    if (entities.some(entity => entity.kind === 'text-box')) retained.forEach(entity => excludedIds.delete(sourceId(entity)!));
    const derived = entities.filter((entity): entity is ITextBoxEntity => entity.kind === 'text-box' && !entity.readOnly
        && !retained.includes(entity) && entity.identity.id !== options.editingId);
    const pageInput = appearancePage(page);
    const requests = derived.map(entity => {
        const input = appearanceInput(entity, page, writerParse, true, original);
        return {
            id: entity.identity.id,
            input,
            key: JSON.stringify([
                writerParse?.documentRevisionToken ?? null,
                pageInput,
                input,
            ]),
        };
    });
    const previous = options.currentInput?.nativeAnnotationAppearance?.pdf;
    const reusable = requests.map(request => options.currentInput?.nativeTextBoxInputs?.find(input => input.id === request.id && input.key === request.key));
    let pdfs: readonly Uint8Array[] = [];
    let nativeTextBoxInputs: NonNullable<IPdfAnnotationRenderInput['nativeTextBoxInputs']> = [];
    if (requests.length && previous && reusable.every(input => input !== undefined)) {
        pdfs = previous instanceof Uint8Array ? [previous] : previous;
        options.reserveAppearanceBytes?.(pdfs.reduce((sum, pdf) => sum + pdf.byteLength, 0));
        nativeTextBoxInputs = reusable.filter(input => input !== undefined);
    } else if (requests.length) {
        const output: Uint8Array[] = [];
        let outputBytes = 0;
        const inputs: Array<NonNullable<IPdfAnnotationRenderInput['nativeTextBoxInputs']>[number]> = [];
        const batches: Array<typeof requests> = [];
        let batch: typeof requests = [];
        let textBytes = 0;
        let requestBytes = 1024;
        const encoder = new TextEncoder();
        for (const request of requests) {
            const text = encoder.encode(request.input.textBox.text).byteLength;
            const bytes = encoder.encode(JSON.stringify(request.input)).byteLength;
            if (batch.length && (batch.length === PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS.textBoxes
                || textBytes + text > PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS.totalTextBytes
                || requestBytes + bytes > PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS.requestBytes)) {
                batches.push(batch); batch = []; textBytes = 0; requestBytes = 1024;
            }
            batch.push(request); textBytes += text; requestBytes += bytes;
        }
        if (batch.length) batches.push(batch);
        for (const chunk of batches) {
            signal?.throwIfAborted();
            const result = await getPageOpsCapability().renderTextBoxAppearance(options.workingCopyPath, {
                page: pageInput,
                textBoxes: chunk.map(request => request.input),
            }, signal ? {signal} : {});
            signal?.throwIfAborted();
            if (result.textBoxes.length !== chunk.length || result.textBoxes.some((entry, index) => entry.stableKey !== chunk[index]!.id)) {
                throw new Error('Native text appearance identities do not match the captured page');
            }
            const appearanceDocument = output.length;
            outputBytes += result.data.byteLength;
            options.reserveAppearanceBytes?.(outputBytes);
            output.push(result.data);
            chunk.forEach((request, appearanceIndex) => inputs.push({
                id: request.id,
                key: request.key,
                appearanceDocument,
                appearanceIndex,
            }));
        }
        pdfs = output; nativeTextBoxInputs = inputs;
    }
    const derivedById = new Map<string, ITextBoxEntity>(derived.map(entity => [
        entity.identity.id,
        entity,
    ]));
    const projected = nativeTextBoxInputs.map(input => ({
        action: sourceId(derivedById.get(input.id)!) ? 'replace' as const : 'append' as const,
        id: sourceId(derivedById.get(input.id)!) ?? input.id,
        appearanceDocument: input.appearanceDocument,
        appearanceIndex: input.appearanceIndex,
    }));
    projected.forEach(entry => excludedIds.delete(entry.id));
    const actions = [
        ...projected,
        ...[...excludedIds].filter(id => loadedIds.has(id)).map(id => ({
            action: 'delete' as const,
            id,
        })),
    ];
    const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())), byte => byte.toString(16).padStart(2, '0')).join('');
    const pdfDigests: string[] = [];
    for (const pdf of pdfs) pdfDigests.push(await hash(pdf));
    const digest = await hash(new TextEncoder().encode(JSON.stringify([
        original?.documentRevisionToken ?? null,
        page.pageNumber,
        actions,
        requests.map(request => request.key),
        pdfDigests,
    ])));
    signal?.throwIfAborted();
    return Object.freeze({
        document,
        original,
        annotations: Object.freeze([...annotations]),
        excludedIds,
        semanticInputs: Object.freeze(entities.map(entity => Object.freeze({
            id: entity.identity.id,
            ref: sourceId(entity),
            fingerprint: semanticEntityFingerprint(entity),
        }))),
        signature: options.signature,
        nativeTextBoxInputs: Object.freeze([...nativeTextBoxInputs]),
        nativeAnnotationAppearance: Object.freeze({
            digest,
            pdf: pdfs.length ? pdfs : null,
            annotations: Object.freeze(actions),
        }),
    });
}

/**
 * Collect the native payload for changed canonical text boxes. Returning
 * `undefined` means this save has no canonical text-box work. Returning null
 * means the work exists but its page geometry could not be collected, so the
 * classifier must fail closed instead of falling back to a legacy note shape.
 */
export async function collectNativeTextBoxMutationsForSave(
    document: IPdfTextBoxPageReader | null,
    plan: ISerializationPlan,
    original?: IPdfAnnotationParseResult | null,
): Promise<IPdfNativeTextBoxMutation[] | null | undefined> {
    const changedTextBoxes = plan.expected.filter(isChangedTextBox);
    if (changedTextBoxes.length === 0) {
        return undefined;
    }
    if (!document) {
        return null;
    }

    const pages = new Map<number, Promise<Pick<IPdfPage, 'rotate' | 'view'> | null>>();
    const getPage = (pageIndex: number) => {
        const cached = pages.get(pageIndex);
        if (cached) {
            return cached;
        }
        const loading = document.getPage(pageIndex + 1).catch(() => null);
        pages.set(pageIndex, loading);
        return loading;
    };

    const mutations: IPdfNativeTextBoxMutation[] = [];
    for (const entity of changedTextBoxes) {
        const page = await getPage(entity.pageIndex);
        const mutation = page && Array.isArray(page.view)
            ? toNativeTextBox(entity, page.view, normalizePageRotation(page.rotate))
            : null;
        if (!mutation) {
            return null;
        }
        const entry = parsedAnnotationForEntity(entity, original ?? null);
        if (entry?.kind === 'text-box' && matchesParsed(entity, entry)) {
            mutation.originalAppearance = entry.recoveryData
                ? {recoveryData: entry.recoveryData}
                : {sourceAnnotationId: `${entry.objectNumber} ${entry.generationNumber} R`};
        }
        mutations.push(mutation);
    }
    return mutations;
}
