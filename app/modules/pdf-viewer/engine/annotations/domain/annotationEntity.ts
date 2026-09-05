import type {
    IAnnotationMarkerRect,
    IShapeAnnotation,
    IShapePoint,
    TEmbeddedPdfShapeSubtype,
    TShapeType,
    TDrawableShapeType,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfAnnotationNoteReply,
    IPdfAnnotationStampImageReference,
} from '@contracts/pdfAnnotationParseTypes';

declare const annotationIdBrand: unique symbol;

// Domain language from the annotation blueprint intentionally omits the T prefix.
// eslint-disable-next-line @typescript-eslint/naming-convention
export type AnnotationId = string & { readonly [annotationIdBrand]: 'AnnotationId' };

export type TAnnotationRotation = 0 | 90 | 180 | 270;

export interface IAnnotationIdentity {
    readonly id: AnnotationId;
    /** Session-local object reference refreshed by the writer after a save. */
    readonly pdfRef?: string;
}

/** A reply read from a foreign note. Replies are derived and never authored here. */
export type IAnnotationReply = IPdfAnnotationNoteReply;

/** The image object reference returned by the writer for a stamp. */
export type IAnnotationImageReference = IPdfAnnotationStampImageReference;

interface IAnnotationEntityBase {
    readonly identity: IAnnotationIdentity;
    readonly pageIndex: number;
    readonly revision: number;
    readonly persistedRevision: number;
    readonly deleted: boolean;
    readonly createdAt: number | null;
    readonly modifiedAt: number | null;
    readonly author: string | null;
}

export interface ITextBoxEntity extends IAnnotationEntityBase {
    readonly kind: 'text-box';
    readonly text: string;
    readonly rect: IAnnotationMarkerRect;
    readonly rotation: TAnnotationRotation;
    readonly fontSize: number;
    readonly color: string | null;
}

export interface INoteEntity extends IAnnotationEntityBase {
    readonly kind: 'note';
    readonly contents: string;
    readonly position: IAnnotationMarkerRect;
    readonly color: string | null;
    readonly open: boolean;
    /** Derived from the document on open. Replies are excluded from equality. */
    readonly replies?: readonly IAnnotationReply[];
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
    readonly rotation: TAnnotationRotation;
    readonly image: IAnnotationImageReference;
}

export interface IShapeEntity extends IAnnotationEntityBase {
    readonly kind: 'shape';
    /** The authored stable key has been observed in a committed PDF parse. */
    readonly materialized?: boolean;
    readonly tool: TDrawableShapeType;
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

/**
 * Temporary projection for the shape tools and serializers that still accept
 * IShapeAnnotation. Remove it when #165 and #166 move those consumers to the
 * flat IShapeEntity model and no viewer consumer accepts the legacy record.
 */
export function toLegacyShapeAnnotation(entity: IShapeEntity): IShapeAnnotation {
    const lineEndpoints = entity.tool === 'line' || entity.tool === 'arrow'
        ? toLegacyLineEndpoints(entity)
        : null;
    return {
        id: entity.identity.id,
        type: toLegacyShapeType(entity.tool),
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
        pdfSubtype: toLegacyShapeSubtype(entity.tool),
        lineStartStyle: 'none',
        lineEndStyle: entity.tool === 'arrow' ? 'closedArrow' : 'none',
        createdAt: entity.createdAt,
        modifiedAt: entity.modifiedAt,
        stableKey: entity.identity.id.startsWith('evb-shape:')
            ? entity.identity.id
            : `evb-shape:${entity.identity.id}`,
    };
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export type AnnotationEntity =
    | ITextBoxEntity
    | INoteEntity
    | ITextMarkupEntity
    | IPlacedImageEntity
    | IShapeEntity;

export interface ISavedSemanticEntry {
    readonly kind: AnnotationEntity['kind'];
    readonly fingerprint: string;
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
    if (!randomUuid) throw new Error('A cryptographically strong AnnotationId generator is required');
    return asAnnotationId(`anno_${randomUuid()}`);
}

/**
 * Removes editor-only placeholder characters and puts authored text in Unicode
 * NFC. The fingerprint applies the same normalization to every text field.
 */
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

function quantizePoints(points: readonly IShapePoint[] | undefined) {
    return points === undefined ? null : points.map(quantizePoint);
}

function quantizeStrokes(strokes: ReadonlyArray<readonly IShapePoint[]> | undefined) {
    return strokes === undefined ? null : strokes.map(stroke => stroke.map(quantizePoint));
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
                Number.parseInt(`${digits[0]}${digits[0]}`, 16),
                Number.parseInt(`${digits[1]}${digits[1]}`, 16),
                Number.parseInt(`${digits[2]}${digits[2]}`, 16),
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

function normalizeImageReference(image: IAnnotationImageReference) {
    return {
        objectNumber: image.objectNumber,
        generationNumber: image.generationNumber,
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
                rect: quantizeRect(entity.rect),
                points: quantizePoints(entity.points),
                strokes: quantizeStrokes(entity.strokes),
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

export function semanticSnapshot(entities: Iterable<AnnotationEntity>) {
    return new Map(Array.from(entities, entity => (
        [
            entity.identity.id,
            {
                kind: entity.kind,
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
    return left.size === right.size
        && Array.from(left).every(([
            id,
            entry,
        ]) => right.get(id)?.fingerprint === entry.fingerprint);
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
            const [
                left,
                right,
            ] = intervals[index]!;
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
