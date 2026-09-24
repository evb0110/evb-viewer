import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    getDocumentMutationErrorPayload,
    isMissingRevisionError,
} from '@contracts/documentMutationErrors';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';

const mocks = vi.hoisted(() => ({
    assertWorkingCopyMutationAllowed: vi.fn(),
    assertWorkingCopyResyncAllowed: vi.fn(),
    assertWorkingCopyRevisionCurrent: vi.fn(),
}));

vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyMutationAllowed: (...args: unknown[]) => mocks.assertWorkingCopyMutationAllowed(...args),
    assertWorkingCopyResyncAllowed: (...args: unknown[]) => mocks.assertWorkingCopyResyncAllowed(...args),
    assertWorkingCopyRevisionCurrent: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
}));

describe('documentMutationGuards', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.assertWorkingCopyMutationAllowed.mockReturnValue(undefined);
        mocks.assertWorkingCopyResyncAllowed.mockReturnValue(undefined);
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
    });

    it('rejects queued working-copy mutations without a revision token using the typed missing-revision error', async () => {
        const { assertQueuedWorkingCopyMutationPreconditions } =
            await import('@electron/file-access/documentMutationGuards');
        const workingPath = '/tmp/evb/working.pdf';

        let caught: unknown;
        try {
            await assertQueuedWorkingCopyMutationPreconditions(workingPath);
        } catch (error) {
            caught = error;
        }

        expect(isMissingRevisionError(caught)).toBe(true);
        expect(getDocumentMutationErrorPayload(caught)).toMatchObject({
            code: 'MISSING_REVISION',
            documentRef: workingPath,
        });
        expect(mocks.assertWorkingCopyMutationAllowed).toHaveBeenCalledWith(workingPath);
        expect(mocks.assertWorkingCopyRevisionCurrent).not.toHaveBeenCalled();
    });

    it('checks the current revision when a token is provided', async () => {
        const { assertQueuedWorkingCopyMutationPreconditions } =
            await import('@electron/file-access/documentMutationGuards');
        const workingPath = '/tmp/evb/current.pdf';

        await expect(assertQueuedWorkingCopyMutationPreconditions(
            workingPath,
            requireDocumentRevisionToken('revision-before-save'),
        )).resolves.toBeUndefined();

        expect(mocks.assertWorkingCopyMutationAllowed).toHaveBeenCalledWith(workingPath);
        expect(mocks.assertWorkingCopyRevisionCurrent)
            .toHaveBeenCalledWith(workingPath, 'revision-before-save');
    });

    it('allows explicit bootstrap mutations without a revision token', async () => {
        const { assertQueuedWorkingCopyMutationPreconditionsForBootstrap } =
            await import('@electron/file-access/documentMutationGuards');
        const workingPath = '/tmp/evb/bootstrap.pdf';

        expect(() => assertQueuedWorkingCopyMutationPreconditionsForBootstrap(
            workingPath,
            'initial-working-copy-creation',
        )).not.toThrow();

        expect(mocks.assertWorkingCopyMutationAllowed).toHaveBeenCalledWith(workingPath);
        expect(mocks.assertWorkingCopyRevisionCurrent).not.toHaveBeenCalled();
    });

    it('requires a greppable bootstrap reason', async () => {
        const { assertQueuedWorkingCopyMutationPreconditionsForBootstrap } =
            await import('@electron/file-access/documentMutationGuards');

        expect(() => assertQueuedWorkingCopyMutationPreconditionsForBootstrap(
            '/tmp/evb/bootstrap.pdf',
            ' ',
        )).toThrow('bootstrap mutation precondition reason must be a non-empty string');
    });
});
