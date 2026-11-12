import {
    decodeManifest,
    DOCUMENTS_DIR,
    type IDocumentStore,
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
 * Removes document directories that are clean, named by no workspace checkpoint and not held by a window,
 * and returns the unsaved ones no window holds, for the recovery offer. A directory without a manifest is
 * an aborted creation and goes too. What cannot be read is kept: an unreadable manifest keeps its
 * directory, and an unreadable checkpoint keeps every clean one it might name. Temporary files of checkpoint
 * writes that crashed are removed.
 */
export async function collectDocuments(store: IDocumentStore, isHeld: (id: string) => Promise<boolean>) {
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
        if (!STORE_ID_PATTERN.test(id) || await isHeld(id)) continue;
        const dir = `${DOCUMENTS_DIR}/${id}`;
        const names = await port.list(dir);
        const manifest = names.includes(MANIFEST_NAME)
            ? await port.read(`${dir}/${MANIFEST_NAME}`).then(decodeManifest).catch(() => null)
            : undefined;
        if (manifest === null) continue;
        if (manifest && isDirty(manifest)) {
            unsaved.push(id);
        } else if (!manifest || (referencesKnown && !referenced.has(id))) {
            await port.remove(dir);
            removed.push(id);
        }
    }
    return { removed, unsaved };
}
