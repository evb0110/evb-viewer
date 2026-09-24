import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runDetached } from '@electron/utils/runDetached';

describe('runDetached', () => {
    it('contains rejected detached work and reports its label', async () => {
        const logger = {error: vi.fn()};
        const failure = new Error('cleanup failed');

        runDetached(
            () => Promise.reject(failure),
            {
                label: 'cleanup',
                logger,
            },
        );
        await Promise.resolve();

        expect(logger.error).toHaveBeenCalledWith(
            'Detached task "cleanup" failed: cleanup failed',
            {
                code: 'MAIN_DETACHED_PROCESS_FAILED',
                cause: failure,
            },
        );
    });

    it('contains synchronous task failures', () => {
        const logger = {error: vi.fn()};
        const failure = new Error('sync failure');

        runDetached(
            () => {
                throw failure;
            },
            {
                label: 'sync cleanup',
                logger,
            },
        );

        expect(logger.error).toHaveBeenCalledWith(
            'Detached task "sync cleanup" failed: sync failure',
            {
                code: 'MAIN_DETACHED_PROCESS_FAILED',
                cause: failure,
            },
        );
    });
});
