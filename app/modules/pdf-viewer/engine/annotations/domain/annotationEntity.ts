import type { TPageIndex } from '@contracts/pageNumbers';
import type { TEpochMs } from '@contracts/timestamps';

import type {
    IAnnotationMarkerRect,
    IShapeAnnotation,
    IShapePoint,
    TEmbeddedPdfShapeSubtype,
    TShapeType,
    TDrawableShapeType,
    TLineEndStyle,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfAnnotationNoteReply,
    IPdfAnnotationStampImageReference,
} from '@contracts/pdfAnnotationParseTypes';

declare const annotationIdBrand: unique symbol;

// Domain language from the annotation blueprint intentionally omits the T prefix.
export type AnnotationId = string & { readonly [annotationIdBrand]: 'AnnotationId' };

export type TAnnotationRotation = 0 | 90 | 180 | 270;

export interface IAnnotationIdentity {
    readonly id: AnnotationId;
    /** Session-local object reference refreshed by the writer after a save. */
    readonly pdfRef?: string;
}

/** A reply read from a foreign annotation. Replies are derived and never authored here. */
export type IAnnotationReply = IPdfAnnotationNoteReply;

/** The image object reference returned by the writer for a stamp. */
export type IAnnotationImageReference = IPdfAnnotationStampImageReference;

/** Original image bytes retained by canonical commands until and after save. */
export interface IAnnotationRasterImage {
    readonly kind: 'raster';
    readonly mimeType: 'image/png' | 'image/jpeg';
    readonly dataBase64: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
}

export type TAnnotationImage = IAnnotationImageReference | IAnnotationRasterImage;

interface IAnnotationEntityBase {
    readonly identity: IAnnotationIdentity;
    readonly pageIndex: TPageIndex;
    readonly revision: number;
    readonly persistedRevision: number;
    readonly deleted: boolean;
    readonly createdAt: TEpochMs | null;
    readonly modifiedAt: TEpochMs | null;
    readonly author: string | null;
    /** Derived from the document on open. Replies are excluded from equality. */
    readonly replies?: readonly IAnnotationReply[];
}

/** A foreign label's border and background, as its producer drew them. */
export interface ITextBoxFrame {
    /** /RD's insets on the page's upright top, right, bottom and left, in PDF points. */
    readonly insets: readonly [number, number, number, number];
    readonly borderWidth: number;
    readonly borderColor: string | null;
    readonly background: string | null;
}

export interface ITextBoxEntity extends IAnnotationEntityBase {
    readonly kind: 'text-box';
    readonly text: string;
    readonly rect: IAnnotationMarkerRect;
    readonly rotation: TAnnotationRotation;
    readonly fontSize: number;
    readonly color: string | null;
    readonly frame?: ITextBoxFrame;
    /** A label whose border style the editor cannot draw: selectable, never changed (ADR 0002). */
    readonly readOnly?: true;
}

export interface INoteEntity extends IAnnotationEntityBase {
    readonly kind: 'note';
    readonly contents: string;
    readonly position: IAnnotationMarkerRect;
    readonly color: string | null;
    readonly open: boolean;
    /** Bounded native recovery graph, retained for undo after a saved deletion. */
    readonly recoveryData?: string;
}

export interface ITextMarkupEntity extends IAnnotationEntityBase {
    readonly kind: 'text-markup';
    readonly subtype: TMarkupSubtype;
    /** The annotation's own note, not the selected document text. */
    readonly contents: string;
    readonly quadPoints: readonly IAnnotationMarkerRect[];
    readonly color: string | null;
    readonly opacity: number | null;
    /** Derived from renderer text content. It is excluded from equality. */
    readonly selectedText?: string | null;
}

/** A persisted image whose PDF representation is an app-owned Stamp. */
export interface IPlacedImageEntity extends IAnnotationEntityBase {
    readonly kind: 'placed-image';
    readonly rect: IAnnotationMarkerRect;
    readonly rotation: number;
    readonly image: TAnnotationImage;
}

export interface IShapeEntity extends IAnnotationEntityBase {
    readonly kind: 'shape';
    /** The authored stable key has been observed in a committed PDF parse. */
    readonly materialized?: boolean;
    readonly tool: TDrawableShapeType;
    /** Imported shape semantics that the drawing-tool name cannot express. */
    readonly pdfSubtype?: TEmbeddedPdfShapeSubtype;
    readonly lineStartStyle?: TLineEndStyle;
    readonly lineEndStyle?: TLineEndStyle;
    readonly rect: IAnnotationMarkerRect;
    readonly points?: readonly IShapePoint[];
    readonly strokes?: ReadonlyArray<readonly IShapePoint[]>;
    readonly strokeColor: string;
    readonly strokeWidth: number;
    readonly fill: string | null;
    readonly opacity: number;
}

function toLegacyShapeType(tool: TDrawableShapeType): TShapeType {
    return tool === 'draw' ? 'polyline' : tool;
}

function toLegacyShapeSubtype(tool: TDrawableShapeType): TEmbeddedPdfShapeSubtype {
    switch (tool) {
        case 'draw':
            return 'Ink';
        case 'rectangle':
            return 'Square';
        case 'circle':
            return 'Circle';
        case 'line':
        case 'arrow':
            return 'Line';
    }
}

function toLegacyLineEndpoints(entity: IShapeEntity) {
    const firstPoint = entity.points?.[0];
    const lastPoint = entity.points?.[entity.points.length - 1];
    return {
        x: firstPoint?.x ?? entity.rect.left,
        y: firstPoint?.y ?? entity.rect.top,
        x2: lastPoint?.x ?? entity.rect.left + entity.rect.width,
        y2: lastPoint?.y ?? entity.rect.top + entity.rect.height,
    };
}

export function toLegacyShapeStableKey(id: AnnotationId): string {
    return id.startsWith('evb-shape:') ? id : `evb-shape:${id}`;
}

/**
 * Temporary projection for the shape tools and serializers that still accept
 * IShapeAnnotation. Remove it once those consumers read the flat IShapeEntity
 * model and no viewer consumer accepts the legacy record.
 */
export function toLegacyShapeAnnotation(entity: IShapeEntity): IShapeAnnotation {
    const lineEndpoints = entity.tool === 'line' || entity.tool === 'arrow'
        ? toLegacyLineEndpoints(entity)
        : null;
    return {
        id: entity.identity.id,
        author: entity.author,
        type: entity.pdfSubtype === 'Polygon' ? 'polygon' : toLegacyShapeType(entity.tool),
        pageIndex: entity.pageIndex,
        x: lineEndpoints?.x ?? entity.rect.left,
        y: lineEndpoints?.y ?? entity.rect.top,
        width: entity.rect.width,
        height: entity.rect.height,
        ...(lineEndpoints ? {
            x2: lineEndpoints.x2,
            y2: lineEndpoints.y2,
        } : {}),
        color: entity.strokeColor,
        ...(entity.fill === null ? {} : {fillColor: entity.fill}),
        opacity: entity.opacity,
        strokeWidth: entity.strokeWidth,
        points: entity.points?.map(point => ({...point})),
        strokes: entity.strokes?.map(stroke => stroke.map(point => ({...point}))),
        annotationId: entity.identity.pdfRef ?? null,
        pdfSubtype: entity.pdfSubtype ?? toLegacyShapeSubtype(entity.tool),
        lineStartStyle: entity.lineStartStyle ?? 'none',
        lineEndStyle: entity.lineEndStyle ?? (entity.tool === 'arrow' ? 'closedArrow' : 'none'),
        createdAt: entity.createdAt,
        modifiedAt: entity.modifiedAt,
        stableKey: toLegacyShapeStableKey(entity.identity.id),
    };
}

export type AnnotationEntity =
    | ITextBoxEntity
    | INoteEntity
    | ITextMarkupEntity
    | IPlacedImageEntity
    | IShapeEntity;

export interface ISavedSemanticEntry {
    readonly kind: AnnotationEntity['kind'];
    readonly fingerprint: string;
    readonly deleted: boolean;
}

export interface ITextMarkupOverlapCandidate {
    readonly annotationId: AnnotationId;
    readonly observedQuadPoints: readonly IAnnotationMarkerRect[];
}

export interface ITextMarkupSelectionProjection {
    readonly created: ITextMarkupEntity;
    readonly replacements: ReadonlyArray<{
        readonly annotationId: AnnotationId;
        readonly quadPoints: readonly IAnnotationMarkerRect[];
        readonly deleted: boolean;
    }>;
}

interface ITextMarkupReplacement {
    readonly before: ITextMarkupEntity;
    readonly after: ITextMarkupEntity;
}

export function asAnnotationId(value: string): AnnotationId {
    const normalized = value.trim();
    if (!normalized) throw new Error('AnnotationId must not be empty');
    return normalized as AnnotationId;
}

function fnv1a(value: string) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

export function deriveAnnotationId(documentKey: string, persistentIdentity: string): AnnotationId {
    return asAnnotationId(`anno_${fnv1a(`${documentKey}\u0000${persistentIdentity}`)}`);
}

export function mintAnnotationId(randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)): AnnotationId {
    return asAnnotationId(`anno_${randomUuid()}`);
}

/**
 * Removes editor-only placeholder characters and puts authored text in Unicode
 * NFC. The fingerprint applies the same normalization to every text field.
 */
/** A label the person can select and copy but never change: pdf.js, not the editor, draws it. */
export function isReadOnlyAnnotation(entity: AnnotationEntity) {
    return entity.kind === 'text-box' && entity.readOnly === true;
}

export function normalizeAnnotationText(text: string) {
    return text.normalize('NFC').replace(/[\u200B\uFEFF]/gu, '');
}

const GEOMETRY_QUANTIZATION = 1e-4;
const OPACITY_PRECISION = 2;

function roundNumber(value: number, decimals: number) {
    const factor = 10 ** decimals;
    const rounded = Math.round(value * factor) / factor;
    return Object.is(rounded, -0) ? 0 : rounded;
}

function quantizeGeometry(value: number) {
    return roundNumber(Math.round(value / GEOMETRY_QUANTIZATION) * GEOMETRY_QUANTIZATION, 4);
}

function quantizeRect(rect: IAnnotationMarkerRect) {
    return {
        left: quantizeGeometry(rect.left),
        top: quantizeGeometry(rect.top),
        width: quantizeGeometry(rect.width),
        height: quantizeGeometry(rect.height),
    };
}

function quantizePoint(point: IShapePoint) {
    return {
        x: quantizeGeometry(point.x),
        y: quantizeGeometry(point.y),
    };
}

function normalizeOpacity(opacity: number | null) {
    return opacity === null ? null : roundNumber(opacity, OPACITY_PRECISION);
}

const NAMED_COLORS: Readonly<Record<string, string>> = {
    black: '#000000',
    blue: '#0000ff',
    fuchsia: '#ff00ff',
    gray: '#808080',
    green: '#008000',
    lime: '#00ff00',
    maroon: '#800000',
    navy: '#000080',
    olive: '#808000',
    orange: '#ffa500',
    purple: '#800080',
    red: '#ff0000',
    silver: '#c0c0c0',
    teal: '#008080',
    transparent: 'transparent',
    white: '#ffffff',
    yellow: '#ffff00',
};

function clampByte(value: number) {
    return Math.min(255, Math.max(0, Math.round(value)));
}

function parseColorComponent(value: string) {
    const trimmed = value.trim();
    const numeric = Number.parseFloat(trimmed);
    if (!Number.isFinite(numeric)) {
        return null;
    }
    return clampByte(trimmed.endsWith('%') ? numeric * 255 / 100 : numeric);
}

function byteColor(red: number, green: number, blue: number) {
    return `#${[
        red,
        green,
        blue,
    ].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Converts accepted CSS-ish color spellings to the store's 8-bit RGB form.
 * Alpha is intentionally ignored because opacity is a separate canonical
 * property for every annotation kind that supports it.
 */
function normalizeColor(color: string | null | undefined) {
    if (color === null || color === undefined) {
        return null;
    }
    const value = color.trim().toLowerCase();
    if (Object.hasOwn(NAMED_COLORS, value)) {
        return NAMED_COLORS[value]!;
    }
    const hex = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u);
    if (hex) {
        const digits = hex[1]!;
        if (digits.length === 3 || digits.length === 4) {
            return byteColor(
                Number.parseInt(`${digits.charAt(0)}${digits.charAt(0)}`, 16),
                Number.parseInt(`${digits.charAt(1)}${digits.charAt(1)}`, 16),
                Number.parseInt(`${digits.charAt(2)}${digits.charAt(2)}`, 16),
            );
        }
        return byteColor(
            Number.parseInt(digits.slice(0, 2), 16),
            Number.parseInt(digits.slice(2, 4), 16),
            Number.parseInt(digits.slice(4, 6), 16),
        );
    }
    const rgb = value.match(/^rgba?\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,)]+)(?:\s*,[^)]*)?\s*\)$/u);
    if (rgb) {
        const channels = rgb.slice(1, 4).map(parseColorComponent);
        if (channels.every((channel): channel is number => channel !== null)) {
            return byteColor(channels[0]!, channels[1]!, channels[2]!);
        }
    }
    // Canonical writers emit #rrggbb. Retain an invalid value in a stable form
    // so malformed input does not make fingerprinting throw or silently change
    // the entity's authored value.
    return value;
}

function normalizeText(value: string | null) {
    return value === null ? null : normalizeAnnotationText(value);
}

function normalizeImageReference(image: TAnnotationImage) {
    return {
        byteLength: image.byteLength,
        sha256: image.sha256.toLowerCase(),
    };
}

function semanticBase(entity: AnnotationEntity) {
    return {
        kind: entity.kind,
        pageIndex: entity.pageIndex,
        deleted: entity.deleted,
        // Author is a writer-owned, user-visible field. Dates are not: writer
        // timestamps change during a round trip and are excluded below.
        author: normalizeText(entity.author),
    };
}

function canonicalSemanticEntity(entity: AnnotationEntity) {
    switch (entity.kind) {
        case 'text-box':
            return {
                ...semanticBase(entity),
                text: normalizeAnnotationText(entity.text),
                rect: quantizeRect(entity.rect),
                rotation: entity.rotation,
                fontSize: entity.fontSize,
                color: normalizeColor(entity.color),
            };
        case 'note':
            return {
                ...semanticBase(entity),
                contents: normalizeAnnotationText(entity.contents),
                position: quantizeRect(entity.position),
                color: normalizeColor(entity.color),
                open: entity.open,
            };
        case 'text-markup':
            return {
                ...semanticBase(entity),
                subtype: entity.subtype,
                contents: normalizeAnnotationText(entity.contents),
                quadPoints: entity.quadPoints.map(quantizeRect),
                color: normalizeColor(entity.color),
                opacity: normalizeOpacity(entity.opacity),
            };
        case 'placed-image':
            return {
                ...semanticBase(entity),
                rect: quantizeRect(entity.rect),
                rotation: entity.rotation,
                image: normalizeImageReference(entity.image),
            };
        case 'shape':
            return {
                ...semanticBase(entity),
                tool: entity.tool,
                pdfSubtype: entity.pdfSubtype ?? toLegacyShapeSubtype(entity.tool),
                lineStartStyle: entity.lineStartStyle ?? 'none',
                lineEndStyle: entity.lineEndStyle ?? (entity.tool === 'arrow' ? 'closedArrow' : 'none'),
                rect: quantizeRect(entity.rect),
                points: entity.points?.map(quantizePoint) ?? null,
                strokes: entity.strokes?.map(stroke => stroke.map(quantizePoint)) ?? null,
                strokeColor: normalizeColor(entity.strokeColor),
                strokeWidth: entity.strokeWidth,
                fill: normalizeColor(entity.fill),
                opacity: roundNumber(entity.opacity, OPACITY_PRECISION),
            };
    }
}

/**
 * Returns the round-trip oracle for one entity.
 *
 * Identity, revision counters, timestamps and derived values are deliberately
 * not read here. Geometry is quantized only in this fingerprint. Stored
 * geometry remains at authored precision for rendering and subsequent edits.
 */
export function semanticEntityFingerprint(entity: AnnotationEntity) {
    return JSON.stringify(canonicalSemanticEntity(entity));
}

/**
 * The authored fields of `entity` that still hold the value of `fingerprint`,
 * an entry of the same kind, compared at fingerprint precision. Page, deletion
 * and author are not authored fields.
 */
export function semanticFieldsUnchangedSince(entity: AnnotationEntity, fingerprint: string) {
    const base = JSON.parse(fingerprint) as Record<string, unknown>;
    const current: Record<string, unknown> = canonicalSemanticEntity(entity);
    const notAuthored = new Set(Object.keys(semanticBase(entity)));
    return Object.keys(current).filter(key => !notAuthored.has(key) && JSON.stringify(current[key]) === JSON.stringify(base[key]));
}

export function semanticSnapshot(entities: Iterable<AnnotationEntity>) {
    return new Map(Array.from(entities, entity => (
        [
            entity.identity.id,
            {
                kind: entity.kind,
                deleted: entity.deleted,
                fingerprint: semanticEntityFingerprint(entity),
            },
        ] as const
    )));
}

export function snapshotOfKind(
    snapshot: ReadonlyMap<AnnotationId, ISavedSemanticEntry>,
    kind: AnnotationEntity['kind'] | undefined,
) {
    if (!kind) {
        return snapshot;
    }
    return new Map(Array.from(snapshot).filter(([
        , entry,
    ]) => entry.kind === kind));
}

export function saveFrontierEntityBaseline(entities: readonly AnnotationEntity[]) {
    return JSON.stringify(entities.map(entity => [
        entity.identity.id,
        entity.revision,
        entity.deleted,
        entity.pageIndex,
    ]));
}

export function remapSavedSemanticFingerprint(
    fingerprint: string,
    nextPageIndex: number | undefined,
) {
    const saved = JSON.parse(fingerprint) as Record<string, unknown>;
    return JSON.stringify(nextPageIndex === undefined
        ? {
            ...saved,
            deleted: true,
        }
        : {
            ...saved,
            pageIndex: nextPageIndex,
        });
}

export function semanticSnapshotsEqual(
    left: ReadonlyMap<AnnotationId, ISavedSemanticEntry>,
    right: ReadonlyMap<AnnotationId, ISavedSemanticEntry>,
) {
    // Tombstones retain history targets, but contribute no annotation to the
    // saved document. Their presence or former content cannot make it dirty.
    const liveLeft = Array.from(left).filter(([
        , entry,
    ]) => !entry.deleted);
    const liveRight = Array.from(right).filter(([
        , entry,
    ]) => !entry.deleted);
    return liveLeft.length === liveRight.length
        && liveLeft.every(([
            id,
            entry,
        ]) => {
            const other = right.get(id);
            return other !== undefined && !other.deleted && other.fingerprint === entry.fingerprint;
        });
}

function subtractRect(
    source: IAnnotationMarkerRect,
    replacements: readonly IAnnotationMarkerRect[],
) {
    const intervals: Array<[number, number]> = [[
        source.left,
        source.left + source.width,
    ]];
    replacements.forEach((replacement) => {
        if (Math.min(source.top + source.height, replacement.top + replacement.height)
            <= Math.max(source.top, replacement.top)) {
            return;
        }
        const overlapLeft = Math.max(source.left, replacement.left);
        const overlapRight = Math.min(source.left + source.width, replacement.left + replacement.width);
        if (overlapRight <= overlapLeft) {
            return;
        }
        for (let index = intervals.length - 1; index >= 0; index -= 1) {
            const interval = intervals[index];
            if (!interval) {
                continue;
            }
            const [
                left,
                right,
            ] = interval;
            if (overlapRight <= left || overlapLeft >= right) {
                continue;
            }
            intervals.splice(index, 1);
            if (overlapRight < right) intervals.splice(index, 0, [
                overlapRight,
                right,
            ]);
            if (overlapLeft > left) intervals.splice(index, 0, [
                left,
                overlapLeft,
            ]);
        }
    });
    return intervals
        .filter(([
            left,
            right,
        ]) => right - left >= 0.0005)
        .map(([
            left,
            right,
        ]) => ({
            ...source,
            left,
            width: right - left,
        }));
}

function subtractGeometry(
    source: readonly IAnnotationMarkerRect[],
    replacements: readonly IAnnotationMarkerRect[],
) {
    return source.flatMap(rect => subtractRect(rect, replacements));
}

function geometryEqual(
    left: readonly IAnnotationMarkerRect[],
    right: readonly IAnnotationMarkerRect[],
) {
    return left.length === right.length && left.every((rect, index) => {
        const candidate = right[index];
        return candidate?.left === rect.left
            && candidate.top === rect.top
            && candidate.width === rect.width
            && candidate.height === rect.height;
    });
}

function rectBounds(rect: IAnnotationMarkerRect) {
    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    return {
        left: Math.min(rect.left, right),
        top: Math.min(rect.top, bottom),
        right: Math.max(rect.left, right),
        bottom: Math.max(rect.top, bottom),
    };
}

function minHeapPush(heap: number[], value: number) {
    heap.push(value);
    let index = heap.length - 1;
    while (index > 0) {
        const parent = (index - 1) >>> 1;
        if (heap[parent]! <= value) {
            break;
        }
        heap[index] = heap[parent]!;
        index = parent;
    }
    heap[index] = value;
}

function minHeapPop(heap: number[]) {
    const min = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
        let index = 0;
        const length = heap.length;
        while (true) {
            const left = (index << 1) + 1;
            const right = left + 1;
            let smallest = index;
            if (left < length && heap[left]! < last) {
                smallest = left;
            }
            if (right < length && heap[right]! < (smallest === index ? last : heap[smallest]!)) {
                smallest = right;
            }
            if (smallest === index) {
                break;
            }
            heap[index] = heap[smallest]!;
            index = smallest;
        }
        heap[index] = last;
    }
    return min;
}

/**
 * Builds an axis-aligned union whose output rectangles never overlap. PDF
 * viewers apply a highlight's alpha once per QuadPoints rectangle, so leaving
 * intersecting rectangles in the saved annotation would still darken the
 * overlap even when the browser renderer paints one SVG union.
 */
function unionTextMarkupGeometry(
    geometries: ReadonlyArray<readonly IAnnotationMarkerRect[]>,
) {
    const epsilon = 1e-9;
    const sources: Array<{
        left: number;
        right: number;
        top: number;
        bottom: number;
    }> = [];
    for (const geometry of geometries) {
        for (const rect of geometry) {
            const rawBounds = rectBounds(rect);
            // PDF parsing introduces float32 drift. Round shared edges before
            // partitioning, otherwise tiny slabs can become zero-width save quads.
            const left = roundNumber(rawBounds.left, 6);
            const right = roundNumber(rawBounds.right, 6);
            const top = roundNumber(rawBounds.top, 6);
            const bottom = roundNumber(rawBounds.bottom, 6);
            if (right - left > epsilon && bottom - top > epsilon) {
                sources.push({
                    left,
                    right,
                    top,
                    bottom,
                });
            }
        }
    }
    if (sources.length === 0) {
        return [];
    }

    const rawYs = new Array<number>(sources.length * 2);
    for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index]!;
        rawYs[index * 2] = source.top;
        rawYs[index * 2 + 1] = source.bottom;
    }
    rawYs.sort((left, right) => left - right);
    const ys: number[] = [];
    for (const y of rawYs) {
        if (ys.length === 0 || ys[ys.length - 1] !== y) {
            ys.push(y);
        }
    }
    const yIntervalCount = ys.length - 1;
    if (yIntervalCount <= 0) {
        return [];
    }
    const yIndexByValue = new Map<number, number>();
    for (let index = 0; index < ys.length; index += 1) {
        yIndexByValue.set(ys[index]!, index);
    }

    const events: Array<{
        x: number;
        y0: number;
        y1: number;
        delta: 1 | -1;
    }> = [];
    for (const source of sources) {
        const y0 = yIndexByValue.get(source.top)!;
        const y1 = yIndexByValue.get(source.bottom)!;
        events.push(
            {
                x: source.left,
                y0,
                y1,
                delta: 1,
            },
            {
                x: source.right,
                y0,
                y1,
                delta: -1,
            },
        );
    }
    events.sort((left, right) => left.x - right.x);

    const treeSize = Math.max(2, yIntervalCount * 4);
    const coverCount = new Int32Array(treeSize);
    // 0 = uncovered, 1 = partially covered, 2 = completely covered
    const coveredState = new Uint8Array(treeSize);

    const refreshCoveredState = (node: number, lo: number, hi: number) => {
        if (coverCount[node]! > 0) {
            coveredState[node] = 2;
            return;
        }
        if (lo + 1 === hi) {
            coveredState[node] = 0;
            return;
        }
        const leftState = coveredState[node << 1]!;
        const rightState = coveredState[(node << 1) | 1]!;
        if (leftState === 2 && rightState === 2) {
            coveredState[node] = 2;
        } else if (leftState === 0 && rightState === 0) {
            coveredState[node] = 0;
        } else {
            coveredState[node] = 1;
        }
    };

    const updateCoverage = (
        node: number,
        lo: number,
        hi: number,
        qL: number,
        qR: number,
        delta: 1 | -1,
    ) => {
        if (qL <= lo && hi <= qR) {
            coverCount[node] = coverCount[node]! + delta;
            refreshCoveredState(node, lo, hi);
            return;
        }
        const mid = (lo + hi) >>> 1;
        if (qL < mid) {
            updateCoverage(node << 1, lo, mid, qL, qR, delta);
        }
        if (qR > mid) {
            updateCoverage((node << 1) | 1, mid, hi, qL, qR, delta);
        }
        refreshCoveredState(node, lo, hi);
    };

    const result: IAnnotationMarkerRect[] = [];
    const lastRectByBand = new Map<string, IAnnotationMarkerRect>();
    const appendBand = (left: number, right: number, top: number, bottom: number) => {
        const slab: IAnnotationMarkerRect = {
            left: roundNumber(left, 6),
            top: roundNumber(top, 6),
            width: roundNumber(right - left, 6),
            height: roundNumber(bottom - top, 6),
        };
        const band = `${slab.top}:${slab.height}`;
        const previous = lastRectByBand.get(band);
        if (previous && Math.abs(previous.left + previous.width - slab.left) <= epsilon) {
            previous.width = roundNumber(slab.left + slab.width - previous.left, 6);
            return;
        }
        result.push(slab);
        lastRectByBand.set(band, slab);
    };

    let eventIndex = 0;
    while (eventIndex < events.length) {
        const left = events[eventIndex]!.x;
        while (eventIndex < events.length && events[eventIndex]!.x === left) {
            const event = events[eventIndex]!;
            updateCoverage(1, 0, yIntervalCount, event.y0, event.y1, event.delta);
            eventIndex += 1;
        }
        if (eventIndex >= events.length) {
            break;
        }
        const right = events[eventIndex]!.x;
        if (right - left <= epsilon || coveredState[1] === 0) {
            continue;
        }

        let hasOpenBand = false;
        let openTop = 0;
        let openBottom = 0;
        const emitCovered = (node: number, lo: number, hi: number) => {
            const state = coveredState[node]!;
            if (state === 0) {
                return;
            }
            if (state === 2) {
                const bandTop = ys[lo]!;
                const bandBottom = ys[hi]!;
                if (!hasOpenBand) {
                    hasOpenBand = true;
                    openTop = bandTop;
                    openBottom = bandBottom;
                } else if (bandTop <= openBottom + epsilon) {
                    if (bandBottom > openBottom) {
                        openBottom = bandBottom;
                    }
                } else {
                    appendBand(left, right, openTop, openBottom);
                    openTop = bandTop;
                    openBottom = bandBottom;
                }
                return;
            }
            const mid = (lo + hi) >>> 1;
            emitCovered(node << 1, lo, mid);
            emitCovered((node << 1) | 1, mid, hi);
        };
        emitCovered(1, 0, yIntervalCount);
        if (hasOpenBand) {
            appendBand(left, right, openTop, openBottom);
        }
    }

    return result;
}

function firstAuthoredText(entities: readonly ITextMarkupEntity[]) {
    const notes: string[] = [];
    const seen = new Set<string>();
    entities.forEach((entity) => {
        const text = normalizeAnnotationText(entity.contents);
        if (!text || seen.has(text)) {
            return;
        }
        seen.add(text);
        notes.push(text);
    });
    return notes.join('\n\n');
}

function markupGeometryArea(entity: ITextMarkupEntity) {
    return entity.quadPoints.reduce((area, rect) => area + Math.abs(rect.width * rect.height), 0);
}

function firstDerivedSelectedText(entities: readonly ITextMarkupEntity[]) {
    const candidates = entities.filter(entity => (
        entity.selectedText !== undefined
        && entity.selectedText !== null
        && entity.selectedText.trim().length > 0
    ));
    if (candidates.length > 0) {
        // A newly selected range can expand a persisted preview. Keep one
        // derived preview, choosing the text tied to the widest covered area,
        // instead of concatenating overlapping fragments.
        return [...candidates].sort((left, right) => markupGeometryArea(right) - markupGeometryArea(left))[0]!.selectedText!;
    }
    return entities.find(entity => entity.selectedText !== undefined && entity.selectedText !== null)?.selectedText ?? null;
}

function preferredHighlightIdentity(left: ITextMarkupEntity, right: ITextMarkupEntity) {
    const leftPersisted = left.identity.pdfRef !== undefined || left.persistedRevision >= 0;
    const rightPersisted = right.identity.pdfRef !== undefined || right.persistedRevision >= 0;
    if (leftPersisted !== rightPersisted) {
        return leftPersisted ? -1 : 1;
    }
    const leftCreatedAt = left.createdAt ?? Number.POSITIVE_INFINITY;
    const rightCreatedAt = right.createdAt ?? Number.POSITIVE_INFINITY;
    if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
    }
    return left.identity.id.localeCompare(right.identity.id);
}

function connectedHighlightEntities(
    created: ITextMarkupEntity,
    candidates: readonly ITextMarkupEntity[],
) {
    if (candidates.length === 0 || created.quadPoints.length === 0) {
        return [];
    }

    const rects: Array<{
        left: number;
        right: number;
        top: number;
        bottom: number;
        owner: number;
        y0: number;
        y1: number;
    }> = [];
    let hasCreatedRect = false;
    for (const quad of created.quadPoints) {
        const bounds = rectBounds(quad);
        if (bounds.left < bounds.right && bounds.top < bounds.bottom) {
            hasCreatedRect = true;
            rects.push({
                left: bounds.left,
                right: bounds.right,
                top: bounds.top,
                bottom: bounds.bottom,
                owner: 0,
                y0: 0,
                y1: 0,
            });
        }
    }
    if (!hasCreatedRect) {
        return [];
    }
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex]!;
        for (const quad of candidate.quadPoints) {
            const bounds = rectBounds(quad);
            if (bounds.left < bounds.right && bounds.top < bounds.bottom) {
                rects.push({
                    left: bounds.left,
                    right: bounds.right,
                    top: bounds.top,
                    bottom: bounds.bottom,
                    owner: candidateIndex + 1,
                    y0: 0,
                    y1: 0,
                });
            }
        }
    }

    const rawYs = new Array<number>(rects.length * 2);
    for (let index = 0; index < rects.length; index += 1) {
        const rect = rects[index]!;
        rawYs[index * 2] = rect.top;
        rawYs[index * 2 + 1] = rect.bottom;
    }
    rawYs.sort((left, right) => left - right);
    const ys: number[] = [];
    for (const y of rawYs) {
        if (ys.length === 0 || ys[ys.length - 1] !== y) {
            ys.push(y);
        }
    }
    const yIntervalCount = ys.length - 1;
    if (yIntervalCount <= 0) {
        return [];
    }
    const yIndexByValue = new Map<number, number>();
    for (let index = 0; index < ys.length; index += 1) {
        yIndexByValue.set(ys[index]!, index);
    }

    // type 0 = leave (processed before enter at equal x so touching edges do not overlap)
    const events: Array<{
        x: number;
        type: 0 | 1;
        rectIndex: number;
    }> = [];
    for (let index = 0; index < rects.length; index += 1) {
        const rect = rects[index]!;
        rect.y0 = yIndexByValue.get(rect.top)!;
        rect.y1 = yIndexByValue.get(rect.bottom)!;
        events.push(
            {
                x: rect.left,
                type: 1,
                rectIndex: index,
            },
            {
                x: rect.right,
                type: 0,
                rectIndex: index,
            },
        );
    }
    events.sort((left, right) => left.x - right.x || left.type - right.type);

    const treeSize = Math.max(2, yIntervalCount * 4);
    const cover: Array<Set<number> | undefined> = new Array(treeSize);
    const totalCount = new Int32Array(treeSize);
    const ownerCount = candidates.length + 1;
    const adjacency: number[][] = Array.from({length: ownerCount}, () => []);
    const seenOwnerStamp = new Int32Array(ownerCount);
    let currentStamp = 0;

    const insertRect = (
        node: number,
        lo: number,
        hi: number,
        qL: number,
        qR: number,
        rectIndex: number,
    ) => {
        totalCount[node] = totalCount[node]! + 1;
        if (qL <= lo && hi <= qR) {
            let bucket = cover[node];
            if (!bucket) {
                bucket = new Set();
                cover[node] = bucket;
            }
            bucket.add(rectIndex);
            return;
        }
        const mid = (lo + hi) >>> 1;
        if (qL < mid) {
            insertRect(node << 1, lo, mid, qL, qR, rectIndex);
        }
        if (qR > mid) {
            insertRect((node << 1) | 1, mid, hi, qL, qR, rectIndex);
        }
    };

    const removeRect = (
        node: number,
        lo: number,
        hi: number,
        qL: number,
        qR: number,
        rectIndex: number,
    ) => {
        totalCount[node] = totalCount[node]! - 1;
        if (qL <= lo && hi <= qR) {
            cover[node]?.delete(rectIndex);
            return;
        }
        const mid = (lo + hi) >>> 1;
        if (qL < mid) {
            removeRect(node << 1, lo, mid, qL, qR, rectIndex);
        }
        if (qR > mid) {
            removeRect((node << 1) | 1, mid, hi, qL, qR, rectIndex);
        }
    };

    const queryOverlaps = (
        node: number,
        lo: number,
        hi: number,
        qL: number,
        qR: number,
        owner: number,
    ) => {
        if (totalCount[node] === 0) {
            return;
        }
        const bucket = cover[node];
        if (bucket && bucket.size > 0) {
            for (const otherRectIndex of bucket) {
                const otherOwner = rects[otherRectIndex]!.owner;
                if (seenOwnerStamp[otherOwner] !== currentStamp) {
                    seenOwnerStamp[otherOwner] = currentStamp;
                    adjacency[owner]!.push(otherOwner);
                    adjacency[otherOwner]!.push(owner);
                }
            }
        }
        if (lo + 1 === hi) {
            return;
        }
        const mid = (lo + hi) >>> 1;
        if (qL < mid) {
            queryOverlaps(node << 1, lo, mid, qL, qR, owner);
        }
        if (qR > mid) {
            queryOverlaps((node << 1) | 1, mid, hi, qL, qR, owner);
        }
    };

    for (const event of events) {
        const rect = rects[event.rectIndex]!;
        if (event.type === 1) {
            currentStamp += 1;
            seenOwnerStamp[rect.owner] = currentStamp;
            queryOverlaps(1, 0, yIntervalCount, rect.y0, rect.y1, rect.owner);
            insertRect(1, 0, yIntervalCount, rect.y0, rect.y1, event.rectIndex);
        } else {
            removeRect(1, 0, yIntervalCount, rect.y0, rect.y1, event.rectIndex);
        }
    }

    // Two-pass min-heap traversal reproduces the exact discovery order of the
    // fixed-point candidate scan (same-pass forward edges before next-pass
    // backward edges) while visiting each edge at most once.
    const connected: ITextMarkupEntity[] = [];
    const queued = new Uint8Array(candidates.length);
    const visitedIds = new Set<AnnotationId>();
    let currentPass: number[] = [];
    let nextPass: number[] = [];

    for (const neighborOwner of adjacency[0]!) {
        if (neighborOwner > 0) {
            const candidateIndex = neighborOwner - 1;
            if (!queued[candidateIndex]) {
                queued[candidateIndex] = 1;
                minHeapPush(currentPass, candidateIndex);
            }
        }
    }

    while (currentPass.length > 0) {
        while (currentPass.length > 0) {
            const candidateIndex = minHeapPop(currentPass);
            const candidate = candidates[candidateIndex]!;
            if (visitedIds.has(candidate.identity.id)) {
                continue;
            }
            visitedIds.add(candidate.identity.id);
            connected.push(candidate);
            for (const neighborOwner of adjacency[candidateIndex + 1]!) {
                if (neighborOwner === 0) {
                    continue;
                }
                const nextIndex = neighborOwner - 1;
                if (queued[nextIndex] || visitedIds.has(candidates[nextIndex]!.identity.id)) {
                    continue;
                }
                queued[nextIndex] = 1;
                if (nextIndex > candidateIndex) {
                    minHeapPush(currentPass, nextIndex);
                } else {
                    minHeapPush(nextPass, nextIndex);
                }
            }
        }
        currentPass = nextPass;
        nextPass = [];
    }

    return connected;
}

function buildHighlightSelectionPlan(input: {
    created: ITextMarkupEntity;
    entities: readonly AnnotationEntity[];
}) {
    const matching = input.entities.filter((entity): entity is ITextMarkupEntity => (
        !entity.deleted
        && entity.kind === 'text-markup'
        && entity.pageIndex === input.created.pageIndex
        && entity.subtype === 'Highlight'
        && normalizeColor(entity.color) === normalizeColor(input.created.color)
    ));
    const connected = connectedHighlightEntities(input.created, matching);
    const mergedGeometry = unionTextMarkupGeometry([
        ...connected.map(entity => entity.quadPoints),
        input.created.quadPoints,
    ]);
    if (!connected.length) {
        if (geometryEqual(mergedGeometry, input.created.quadPoints)) {
            return null;
        }
        return {
            replacements: [],
            projection: {
                created: {
                    ...input.created,
                    quadPoints: mergedGeometry,
                },
                replacements: [],
            } satisfies ITextMarkupSelectionProjection,
        };
    }
    if (mergedGeometry.length === 0) {
        return null;
    }
    const canonical = [...connected].sort(preferredHighlightIdentity)[0]!;
    const ordered = [
        canonical,
        ...connected.filter(entity => entity.identity.id !== canonical.identity.id),
        input.created,
    ];
    const mergedContents = firstAuthoredText(ordered);
    const mergedSelectedText = firstDerivedSelectedText(ordered);
    const modifiedAt = input.created.modifiedAt ?? canonical.modifiedAt;
    const replacements = connected.map((entity): ITextMarkupReplacement => {
        const after = entity.identity.id === canonical.identity.id
            ? {
                ...entity,
                color: input.created.color,
                opacity: input.created.opacity,
                contents: mergedContents,
                quadPoints: mergedGeometry,
                selectedText: mergedSelectedText,
                revision: entity.revision + 1,
                modifiedAt,
            }
            : {
                ...entity,
                deleted: true,
                revision: entity.revision + 1,
                modifiedAt,
            };
        return {
            before: entity,
            after,
        };
    });
    const changedReplacements = replacements.filter(({
        before, after,
    }) => (
        semanticEntityFingerprint(before) !== semanticEntityFingerprint(after)
        || before.selectedText !== after.selectedText
    ));
    const changedCanonical = changedReplacements.find(replacement => (
        replacement.after.identity.id === canonical.identity.id
    ));
    const afterCanonical = changedCanonical?.after ?? canonical;
    return {
        replacements: changedReplacements,
        projection: {
            created: structuredClone(afterCanonical),
            replacements: changedReplacements.map(({after}) => ({
                annotationId: after.identity.id,
                quadPoints: structuredClone(after.quadPoints),
                deleted: after.deleted,
            })),
        } satisfies ITextMarkupSelectionProjection,
    };
}

export function buildTextMarkupSelectionPlan(input: {
    created: ITextMarkupEntity;
    overlapCandidates: readonly ITextMarkupOverlapCandidate[];
    entities: readonly AnnotationEntity[];
}) {
    const byId = new Map(input.entities.map(entity => [
        entity.identity.id,
        entity,
    ]));
    const seen = new Set<AnnotationId>();
    const replacements: ITextMarkupReplacement[] = [];
    if (input.created.subtype === 'Highlight') {
        const highlightPlan = buildHighlightSelectionPlan(input);
        if (highlightPlan) {
            return highlightPlan;
        }
    }
    if (input.created.subtype !== 'Highlight') {
        input.overlapCandidates.forEach((candidate) => {
            if (seen.has(candidate.annotationId)) {
                return;
            }
            seen.add(candidate.annotationId);
            const current = byId.get(candidate.annotationId);
            if (!current
                || current.deleted
                || current.kind !== 'text-markup'
                || current.pageIndex !== input.created.pageIndex
                || current.subtype !== input.created.subtype) {
                return;
            }
            const quadPoints = subtractGeometry(candidate.observedQuadPoints, input.created.quadPoints);
            if (geometryEqual(quadPoints, candidate.observedQuadPoints)) {
                return;
            }
            replacements.push({
                before: current,
                after: {
                    ...current,
                    quadPoints,
                    deleted: quadPoints.length === 0,
                    revision: current.revision + 1,
                    modifiedAt: input.created.modifiedAt,
                },
            });
        });
    }
    return {
        replacements,
        projection: {
            created: structuredClone(input.created),
            replacements: replacements.map(({after}) => ({
                annotationId: after.identity.id,
                quadPoints: structuredClone(after.quadPoints),
                deleted: after.deleted,
            })),
        } satisfies ITextMarkupSelectionProjection,
    };
}
