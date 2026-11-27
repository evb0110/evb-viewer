import type {IDocumentStore} from './documentDirectory';
import {decodeManifest, DOCUMENTS_DIR, isDirty, isOpenOnlyManifest, MANIFEST_NAME, STORE_ID_PATTERN} from './manifest';
import {checkpointWindowId, type IUnreadableEntry, readWorkspaceCheckpoints, WORKSPACES_DIR} from './workspaceCheckpoint';

/**
 * Removes the document directories nothing needs and returns the unsaved ones no window holds, for the recovery
 * offer. `hold` takes a directory, or answers `null` when a window has it; each directory is decided and removed
 * while held, so collection never races a window opening it. A directory `hold` refused is returned in `held`: it
 * was not inspected, so it may be unsaved. Removed: a directory without a manifest (an aborted creation), a clean
 * one no workspace checkpoint names, and an unsaved one no checkpoint names that holds only what an open made. Every
 * other unsaved directory is kept, named or not. What cannot be read is kept and returned in `unreadable`, for the
 * host to report: an unreadable manifest keeps its directory, and an unreadable checkpoint keeps every directory it
 * might name. Temporary files of checkpoint writes that crashed are removed.
 */
export async function collectDocuments(store: IDocumentStore, hold: (id: string) => Promise<(() => void) | null>) {
    const {port} = store;
    for (const name of await port.list(WORKSPACES_DIR)) {
        // A temporary file another window still has open refuses removal; it is that window's to finish.
        if (checkpointWindowId(name) === null) {
            await port.remove(`${WORKSPACES_DIR}/${name}`).catch(() => undefined);
        }
    }
    const unreadable: IUnreadableEntry[] = [];
    const checkpoints = [...(await readWorkspaceCheckpoints(port, unreadable)).values()];
    const referenced = new Set(
        checkpoints.flatMap((checkpoint) => (checkpoint ? Object.values(checkpoint.tabs).map((tab) => tab.directory) : [])),
    );
    const referencesKnown = checkpoints.every((checkpoint) => checkpoint !== null);
    const removed: string[] = [];
    const unsaved: string[] = [];
    const held: string[] = [];
    for (const id of await port.list(DOCUMENTS_DIR)) {
        if (!STORE_ID_PATTERN.test(id)) {
            continue;
        }
        const release = await hold(id);
        if (!release) {
            held.push(id);
            continue;
        }
        try {
            const dir = `${DOCUMENTS_DIR}/${id}`;
            const path = `${dir}/${MANIFEST_NAME}`;
            const manifest = (await port.list(dir)).includes(MANIFEST_NAME)
                ? await port
                      .read(path)
                      .then(decodeManifest)
                      .catch((error: unknown) => {
                          unreadable.push({path, directory: id, error});
                          return null;
                      })
                : undefined;
            if (manifest === null) {
                continue;
            }
            const unnamed = referencesKnown && !referenced.has(id);
            if (manifest && isDirty(manifest) && !(unnamed && isOpenOnlyManifest(manifest))) {
                unsaved.push(id);
            } else if (!manifest || unnamed) {
                await port.remove(dir);
                removed.push(id);
            }
        } finally {
            release();
        }
    }
    return {removed, unsaved, held, unreadable};
}
