import {decodeManifest, DOCUMENTS_DIR, isDirty, MANIFEST_NAME, STORE_ID_PATTERN} from '@document-store/documentDirectory';
import {isOpenOnlyManifest} from '@document-store/manifest';
import type {IStorePort} from '@document-store/storePort';
import {isErrnoException} from '@contracts/runtimeGuards';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';

const log = createLogger('workspace-checkpoint-store');

interface IFindUnshownUnsavedDirectoriesOptions {
    port: IStorePort;
    shownDirectories: ReadonlySet<string>;
    heldDirectories: ReadonlySet<string>;
    referencesKnown: boolean;
    settleViaCollection: () => Promise<string[]>;
}

/**
 * Finds unsaved document directories that no workspace checkpoint names and no
 * window holds, without blocking startup restore on background stale-directory
 * GC unless an unshown directory still has an interrupted publish to settle.
 */
export async function findUnshownUnsavedDirectories({
    port,
    shownDirectories,
    heldDirectories,
    referencesKnown,
    settleViaCollection,
}: IFindUnshownUnsavedDirectoriesOptions): Promise<string[]> {
    let entries: string[];
    try {
        entries = await port.list(DOCUMENTS_DIR);
    } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) {
            log.warn(`Could not scan unshown unsaved documents in ${DOCUMENTS_DIR}: ${getErrorMessage(error)}`);
        }
        return [];
    }
    const candidates = entries.filter((id) => STORE_ID_PATTERN.test(id) && !shownDirectories.has(id) && !heldDirectories.has(id));
    if (candidates.length === 0) {
        return [];
    }

    let needsSettlement = false;
    const unsaved: string[] = [];
    await Promise.all(
        candidates.map(async (id) => {
            try {
                const manifest = decodeManifest(await port.read(`${DOCUMENTS_DIR}/${id}/${MANIFEST_NAME}`));
                if (manifest.pendingPublish !== undefined || manifest.unsettled !== undefined) {
                    needsSettlement = true;
                } else if (isDirty(manifest) && !(referencesKnown && isOpenOnlyManifest(manifest))) {
                    unsaved.push(id);
                }
            } catch (error) {
                if (!(isErrnoException(error) && error.code === 'ENOENT')) {
                    unsaved.push(id);
                }
            }
        }),
    );

    if (needsSettlement) {
        return (await settleViaCollection()).filter((directory) => !shownDirectories.has(directory));
    }
    return unsaved;
}
