import { sameWitness } from './contentWitness';

export const DOCUMENTS_DIR = 'documents';
export const MANIFEST_NAME = 'manifest.json';
/** Directory and window ids: also file names, so they never contain a separator. */
export const STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
export const EXT_PATTERN = /^[A-Za-z0-9]{1,16}$/u;
const REVISION_FILE_PATTERN = /^r\d+\.[A-Za-z0-9]{1,16}$/u;
const DRAFTS_FILE_PATTERN = /^drafts-[A-Za-z0-9-]{1,64}\.json$/u;

export type TForeignRevisionState = 'staged' | 'committed';

/** The bytes `[0, length)` of `file`. `witness` names them once something established it: a content witness, or the witness of the destination they were copied from. */
export interface IRevision {
    id: number;
    file: string;
    length: number;
    witness?: string | undefined;
    /** Revision 1 copied from an externally modified destination: `'staged'` until published or archived for undo, then `'committed'`. */
    foreign?: TForeignRevisionState | undefined;
    /** Affirmative evidence that this revision holds only bytes created during document open (decrypt/normalize/repair), never a user edit. */
    openOnly?: true | undefined;
}

/**
 * Revision 1 of a document opened from a destination, kept for undo while no file of the store holds it: the
 * destination's bytes, as long as the destination still has `witness`.
 */
export interface IDestinationRevision {
    id: 1;
    witness: string;
}

export type THistoryRevision = IRevision | IDestinationRevision;

export const hasFile = (revision: THistoryRevision): revision is IRevision => 'file' in revision;

/**
 * A publish whose outcome is unknown: `witness` is what `destination` holds if it finished (absent until the bytes are
 * staged), and `temp` the file it stages beside the destination, named before that file exists.
 */
export interface IPendingPublish {
    destination: string;
    witness?: string | undefined;
    temp?: string | undefined;
    /** What the destination held before, for an `unsettled` record; the latest publish's is the manifest's `baseline`. */
    baseline?: string | undefined;
}

export interface IManifest {
    version: 1;
    ext: string;
    /** The file name the document was created under, for a view with no other name for it; absent in older stores. */
    name?: string | undefined;
    /** The id of the next revision, which also names its file. Revision 1 is the destination's bytes as opened. */
    next: number;
    current?: IRevision | undefined;
    /** Revisions kept for undo and redo; never contains `current`. */
    history: THistoryRevision[];
    destination?: string | undefined;
    /** The witness of the bytes last read from or published to `destination`. */
    baseline?: string | undefined;
    /** The latest publish while its outcome is unknown; recovery adopts it when the destination holds what it published. */
    pendingPublish?: IPendingPublish | undefined;
    /** Earlier publishes a later one followed before they could be settled, for example while their destination could not be read. */
    unsettled?: IPendingPublish[] | undefined;
    /** The immutable file holding the drafts that apply to `current`; absent when there are none. */
    drafts?: string | undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encodeJson(value: unknown) {
    return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeJson(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(bytes));
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';
const isOptionalForeign = (value: unknown): value is TForeignRevisionState | undefined => value === undefined || value === 'staged' || value === 'committed';
const isOptionalOpenOnly = (value: unknown): value is true | undefined => value === undefined || value === true;

function isRevision(value: unknown): value is IRevision {
    return isRecord(value) && isCount(value.id) && typeof value.file === 'string' && REVISION_FILE_PATTERN.test(value.file)
        && isCount(value.length) && isOptionalString(value.witness) && isOptionalForeign(value.foreign)
        && isOptionalOpenOnly(value.openOnly);
}

const isDestinationRevision = (value: unknown) => isRecord(value) && value.id === 1 && typeof value.witness === 'string' && !('file' in value);
const isPendingPublish = (value: unknown) => isRecord(value) && typeof value.destination === 'string' && isOptionalString(value.witness)
    && isOptionalString(value.temp) && isOptionalString(value.baseline);

function isManifest(value: unknown): value is IManifest {
    return isRecord(value) && value.version === 1 && typeof value.ext === 'string' && EXT_PATTERN.test(value.ext)
        && isOptionalString(value.name) && isCount(value.next) && Array.isArray(value.history)
        && value.history.every(revision => isRevision(revision) || isDestinationRevision(revision))
        && (value.current === undefined || isRevision(value.current))
        && isOptionalString(value.destination) && isOptionalString(value.baseline)
        && (value.drafts === undefined || (typeof value.drafts === 'string' && DRAFTS_FILE_PATTERN.test(value.drafts)))
        && (value.pendingPublish === undefined || isPendingPublish(value.pendingPublish))
        && (value.unsettled === undefined || (Array.isArray(value.unsettled) && value.unsettled.every(isPendingPublish)));
}

export function decodeManifest(bytes: Uint8Array): IManifest {
    const value = decodeJson(bytes);
    if (!isManifest(value)) throw new Error('Unreadable document manifest');
    return value;
}

/** Dirty: drafts exist, a publish is unresolved, or the current bytes are not known to equal the baseline. */
export function isDirty(manifest: IManifest) {
    const { current } = manifest;
    return manifest.drafts !== undefined || manifest.pendingPublish !== undefined || manifest.unsettled !== undefined
        || (current !== undefined && !sameWitness(current.witness, manifest.baseline));
}

const isUnchangedBaselineCopy = (revision: IRevision, manifest: IManifest) => revision.id === 1
    && revision.foreign === undefined
    && revision.witness !== undefined
    && sameWitness(revision.witness, manifest.baseline);

/** Whether `manifest` has no user edits yet, so an open-time rewrite may still carry `openOnly: true`. */
export function hasNoUserEdits(manifest: IManifest) {
    return manifest.drafts === undefined
        && manifest.pendingPublish === undefined
        && manifest.unsettled === undefined
        && (manifest.current === undefined || manifest.current.openOnly === true || isUnchangedBaselineCopy(manifest.current, manifest))
        && manifest.history.every(revision => !hasFile(revision) || revision.openOnly === true || isUnchangedBaselineCopy(revision, manifest));
}

/**
 * Affirmative evidence that a dirty directory holds only what an open made, with no user edit since: no drafts,
 * no publish to settle, a current revision explicitly marked `openOnly`, and no non-`openOnly` file revision in
 * history. Older or ambiguous dirty manifests without `openOnly: true` (including a first byte edit whose checkpoint
 * naming failed) are never deleted.
 */
export function isOpenOnlyManifest(manifest: IManifest) {
    return manifest.current?.openOnly === true && hasNoUserEdits(manifest);
}

export function namedFiles(manifest: IManifest) {
    const files = [manifest.current, ...manifest.history].flatMap(revision => revision && hasFile(revision) ? [revision.file] : []);
    return new Set(manifest.drafts === undefined ? files : [...files, manifest.drafts]);
}
