import {
    decodeManifest,
    DOCUMENTS_DIR,
    type IDocumentStore,
    type IManifest,
    isDirty,
    MANIFEST_NAME,
    STORE_ID_PATTERN,
} from './documentDirectory';
import {
    checkpointWindowId,
    readWorkspaceCheckpoints,
    WORKSPACES_DIR,
} from './workspaceCheckpoint';

/**
 * What an open leaves, with nothing done since: no drafts, no publish to settle, and at most two revisions made (the
 * one it created or copied in, and one it wrote, such as a decrypted or normalized PDF). A window names a directory
 * in its checkpoint before the first edit, so an unsaved directory no checkpoint names that looks like this is an
 * open a crash cut short.
 */
const isOpenOnly = (manifest: IManifest) => manifest.drafts === undefined && manifest.pendingPublish === undefined
    && manifest.unsettled === undefined && manifest.next <= 3;

/**
 * Removes the document directories nothing needs and returns the unsaved ones no window holds, for the recovery
 * offer. `hold` takes a directory, or answers `null` when a window has it; each directory is decided and removed
 * while held, so collection never races a window opening it. Removed: a directory without a manifest (an aborted
 * creation), a clean one no workspace checkpoint names, and an unsaved one no checkpoint names that holds only what
 * an open made. Every other unsaved directory is kept, named or not. What cannot be read is kept: an unreadable
 * manifest keeps its directory, and an unreadable checkpoint keeps every directory it might name. Temporary files of
 * checkpoint writes that crashed are removed.
 */
export async function collectDocuments(store: IDocumentStore, hold: (id: string) => Promise<(() => void) | null>) {
    const { port } = store;
    for (const name of await port.list(WORKSPACES_DIR)) {
        // A temporary file another window still has open refuses removal; it is that window's to finish.
        if (checkpointWindowId(name) === null) await port.remove(`${WORKSPACES_DIR}/${name}`).catch(() => undefined);
    }
    const checkpoints = [...(await readWorkspaceCheckpoints(port)).values()];
    const referenced = new Set(checkpoints.flatMap(checkpoint => checkpoint ? Object.values(checkpoint.tabs).map(tab => tab.directory) : []));
    const referencesKnown = checkpoints.every(checkpoint => checkpoint !== null);
    const removed: string[] = [];
    const unsaved: string[] = [];
    for (const id of await port.list(DOCUMENTS_DIR)) {
        if (!STORE_ID_PATTERN.test(id)) continue;
        const release = await hold(id);
        if (!release) continue;
        try {
            const dir = `${DOCUMENTS_DIR}/${id}`;
            const manifest = (await port.list(dir)).includes(MANIFEST_NAME)
                ? await port.read(`${dir}/${MANIFEST_NAME}`).then(decodeManifest).catch(() => null)
                : undefined;
            if (manifest === null) continue;
            const unnamed = referencesKnown && !referenced.has(id);
            if (manifest && isDirty(manifest) && !(unnamed && isOpenOnly(manifest))) {
                unsaved.push(id);
            } else if (!manifest || unnamed) {
                await port.remove(dir);
                removed.push(id);
            }
        } finally {
            release();
        }
    }
    return { removed, unsaved };
}
