import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {ref} from 'vue';
import {
    createDeferred,
    createDeps,
    useWorkspaceSaveServiceForTest,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceFixture';

describe('unencrypted save notice', () => {
    it('warns once before the first save of a formerly encrypted document', async () => {
        const requestNotice = vi.fn(async () => ({
            confirmed: true,
            dontShowAgain: false,
        }));
        const {deps} = createDeps({
            wasEncrypted: ref(true),
            requestUnencryptedSaveNotice: requestNotice,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(true);
        await expect(service.handleSave()).resolves.toBe(true);

        expect(requestNotice).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).toHaveBeenCalledTimes(2);
    });

    it('returns a cancelled not-saved result without writing when the user declines', async () => {
        const requestNotice = vi.fn(async () => ({
            confirmed: false,
            dontShowAgain: false,
        }));
        const {
            deps,
            saveFile,
            saveWorkingCopyAs,
        } = createDeps({
            wasEncrypted: ref(true),
            requestUnencryptedSaveNotice: requestNotice,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(requestNotice).toHaveBeenCalledOnce();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(saveWorkingCopyAs).not.toHaveBeenCalled();
    });

    it('leaves the notice pending after cancel so the next save asks again', async () => {
        const requestNotice = vi.fn()
            .mockResolvedValueOnce({
                confirmed: false,
                dontShowAgain: false,
            })
            .mockResolvedValueOnce({
                confirmed: true,
                dontShowAgain: false,
            });
        const {deps} = createDeps({
            wasEncrypted: ref(true),
            requestUnencryptedSaveNotice: requestNotice,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);
        await expect(service.handleSave()).resolves.toBe(true);

        expect(requestNotice).toHaveBeenCalledTimes(2);
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
    });

    it('skips the notice when the suppression setting is enabled', async () => {
        const requestNotice = vi.fn(async () => ({
            confirmed: true,
            dontShowAgain: false,
        }));
        const {deps} = createDeps({
            wasEncrypted: ref(true),
            suppressUnencryptedSaveNotice: ref(true),
            requestUnencryptedSaveNotice: requestNotice,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(true);

        expect(requestNotice).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
    });

    it('uses a new session key for a reopened document', async () => {
        const requestNotice = vi.fn(async () => ({
            confirmed: true,
            dontShowAgain: false,
        }));
        const documentSessionKey = ref('document-session-1');
        const {deps} = createDeps({
            documentSessionKey,
            wasEncrypted: ref(true),
            requestUnencryptedSaveNotice: requestNotice,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(true);
        documentSessionKey.value = 'document-session-2';
        await expect(service.handleSave()).resolves.toBe(true);

        expect(requestNotice).toHaveBeenCalledTimes(2);
    });

    it('warns before Save As for a formerly encrypted document', async () => {
        const requestNotice = vi.fn(async () => ({
            confirmed: true,
            dontShowAgain: false,
        }));
        const {
            deps,
            saveWorkingCopyAs,
        } = createDeps({
            wasEncrypted: ref(true),
            requestUnencryptedSaveNotice: requestNotice,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSaveAs()).resolves.toBe(true);

        expect(requestNotice).toHaveBeenCalledOnce();
        expect(saveWorkingCopyAs).toHaveBeenCalledOnce();
    });

    it('does not write when the notice is cancelled before Save As', async () => {
        const requestNotice = vi.fn(async () => ({
            confirmed: false,
            dontShowAgain: false,
        }));
        const {
            deps,
            saveWorkingCopyAs,
        } = createDeps({
            wasEncrypted: ref(true),
            requestUnencryptedSaveNotice: requestNotice,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSaveAs()).resolves.toBe(false);

        expect(requestNotice).toHaveBeenCalledOnce();
        expect(saveWorkingCopyAs).not.toHaveBeenCalled();
    });

    it('does not warn for a document that was never encrypted', async () => {
        const requestNotice = vi.fn(async () => ({
            confirmed: true,
            dontShowAgain: false,
        }));
        const {deps} = createDeps({requestUnencryptedSaveNotice: requestNotice});
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(true);

        expect(requestNotice).not.toHaveBeenCalled();
    });

    it('applies the dont-show-again choice before the save completes', async () => {
        const requestNotice = vi.fn(async () => ({
            confirmed: true,
            dontShowAgain: true,
        }));
        const updateSuppression = vi.fn();
        const flushStarted = createDeferred<unknown>();
        const flushSettingsDeferred = createDeferred<boolean>();
        const flushSettings = vi.fn(() => {
            flushStarted.resolve(undefined);
            return flushSettingsDeferred.promise;
        });
        const {deps} = createDeps({
            wasEncrypted: ref(true),
            suppressUnencryptedSaveNotice: ref(false),
            requestUnencryptedSaveNotice: requestNotice,
            updateSuppressUnencryptedSaveNotice: updateSuppression,
            flushSettings,
        });
        const service = useWorkspaceSaveServiceForTest(deps);
        const saveWorkingCopy = vi.mocked(deps.saveWorkingCopy);
        const savePromise = service.handleSave();

        await flushStarted.promise;
        expect(flushSettings).toHaveBeenCalledOnce();
        expect(saveWorkingCopy).not.toHaveBeenCalled();
        flushSettingsDeferred.resolve(true);

        await expect(savePromise).resolves.toBe(true);

        expect(updateSuppression).toHaveBeenCalledOnce();
        expect(flushSettings).toHaveBeenCalledOnce();
        expect(updateSuppression.mock.invocationCallOrder[0]!)
            .toBeLessThan(flushSettings.mock.invocationCallOrder[0]!);
        expect(flushSettings.mock.invocationCallOrder[0]!)
            .toBeLessThan(saveWorkingCopy.mock.invocationCallOrder[0]!);
    });

    it('restores the warning when the dont-show-again preference cannot be saved', async () => {
        const requestNotice = vi.fn(async () => ({
            confirmed: true,
            dontShowAgain: true,
        }));
        const suppression = ref(false);
        const updateSuppression = vi.fn(() => {
            suppression.value = true;
        });
        const resetSuppression = vi.fn(() => {
            suppression.value = false;
        });
        const flushSettings = vi.fn(async () => false);
        const {deps} = createDeps({
            wasEncrypted: ref(true),
            suppressUnencryptedSaveNotice: suppression,
            requestUnencryptedSaveNotice: requestNotice,
            updateSuppressUnencryptedSaveNotice: updateSuppression,
            resetSuppressUnencryptedSaveNotice: resetSuppression,
            flushSettings,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(true);

        expect(updateSuppression).toHaveBeenCalledOnce();
        expect(flushSettings).toHaveBeenCalledOnce();
        expect(resetSuppression).toHaveBeenCalledOnce();
        expect(suppression.value).toBe(false);
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
    });
});
