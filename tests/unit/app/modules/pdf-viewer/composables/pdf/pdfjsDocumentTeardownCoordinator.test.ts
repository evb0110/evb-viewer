import {describe, expect, it, vi} from 'vitest';
import {createPdfjsDocumentTeardownCoordinator} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfjsDocumentTeardownCoordinator';

describe('pdfjsDocumentTeardownCoordinator', () => {
    it('sequences a reopen behind teardown of the same canonical source', async () => {
        const teardown = Promise.withResolvers<undefined>();
        const coordinator = createPdfjsDocumentTeardownCoordinator();
        const destroy = vi.fn(() => teardown.promise);

        coordinator.track('/documents/shared.pdf', {
            message: 'destroy shared source',
            run: destroy,
        });
        const waiting = coordinator.waitForIdle('/documents/shared.pdf');
        let settled = false;
        void waiting.then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(destroy).toHaveBeenCalledOnce();
        expect(settled).toBe(false);

        teardown.resolve(undefined);
        await expect(waiting).resolves.toBeUndefined();
    });

    it('does not block an unrelated source or tab behind another source teardown', async () => {
        const teardown = Promise.withResolvers<undefined>();
        const coordinator = createPdfjsDocumentTeardownCoordinator();

        coordinator.track('/documents/first.pdf', {
            message: 'destroy first source',
            run: () => teardown.promise,
        });

        await expect(coordinator.waitForIdle('/documents/second.pdf')).resolves.toBeUndefined();
        teardown.resolve(undefined);
        await expect(coordinator.waitForIdle('/documents/first.pdf')).resolves.toBeUndefined();
    });

    it('lets a superseded load leave a same-source teardown wait', async () => {
        const teardown = Promise.withResolvers<undefined>();
        const coordinator = createPdfjsDocumentTeardownCoordinator();
        const abortController = new AbortController();

        coordinator.track('/documents/shared.pdf', {
            message: 'destroy shared source',
            run: () => teardown.promise,
        });
        const waiting = coordinator.waitForIdle('/documents/shared.pdf', abortController.signal);
        abortController.abort();

        await expect(waiting).rejects.toMatchObject({name: 'AbortError'});
        teardown.resolve(undefined);
        await expect(coordinator.waitForIdle('/documents/shared.pdf')).resolves.toBeUndefined();
    });
});
