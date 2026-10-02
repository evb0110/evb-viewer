import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {IAnnotationCreationFailureReport} from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { toastDescriptionContaining } from '@tests/helpers/toastDescription';

const toastAddMock = vi.fn();
vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
vi.stubGlobal('useToast', () => ({add: toastAddMock}));

const { useWorkspaceFailureSurface } = await import(
    '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface'
);

function expectedAnnotationReport(
    operationId: string,
    reason: Extract<IAnnotationCreationFailureReport, {kind: 'expected'}>['reason'],
): IAnnotationCreationFailureReport {
    return {
        kind: 'expected',
        operationId,
        pageNumber: requirePageNumber(1),
        reason,
        outcome: {
            kind: 'expected',
            code: reason === 'selection-spans-pages'
                || reason === 'no-selection'
                || reason === 'selection-not-in-text-layer'
                ? 'validation-rejected'
                : 'temporarily-unavailable',
        },
    };
}

// The composable resolves both globals on every call, so the stubs have to
// outlive each test and are dropped once for the file.
afterAll(() => {
    vi.unstubAllGlobals();
});

describe('useWorkspaceFailureSurface', () => {
    beforeEach(() => {
        toastAddMock.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('keeps one captured receipt in the log and red presentation', () => {
        const receipt = {
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            eventId: 'receipt-save-123456789',
            occurredAt: 1,
            severity: 'error',
        } as FailureReceipt;
        const capture = vi.spyOn(BrowserLogger, 'error').mockReturnValue(receipt);
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportSaveFailure('save-1', 'persist-rejected')).toBe(true);
        expect(surface.reportSaveFailure('save-1', 'persist-rejected')).toBe(false);

        expect(capture).toHaveBeenCalledOnce();
        expect(surface.saveFailurePresentation.value?.failure).toBe(receipt);
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({description: toastDescriptionContaining('errors.runtime.errorId: receipt')}));
    });

    it('shows one toast when a low-level failure and a service result share an operation', () => {
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportSaveFailure('save-1', 'validation-rejected')).toBe(true);
        expect(surface.reportSaveFailure('save-1', 'persist-rejected')).toBe(false);

        expect(toastAddMock).toHaveBeenCalledOnce();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: toastDescriptionContaining('errors.save.validation'),
        }));
        expect(surface.hasSaveFailure.value).toBe(true);
    });

    it('toasts again for a separate operation', () => {
        const surface = useWorkspaceFailureSurface();

        surface.reportSaveFailure('save-1', 'validation-rejected');
        surface.reportSaveFailure('save-2', 'validation-rejected');

        expect(toastAddMock).toHaveBeenCalledTimes(2);
    });

    it('prefers a caller-supplied detail over the reason copy', () => {
        const surface = useWorkspaceFailureSurface();

        surface.reportSaveFailure('save-1', 'unexpected-error', 'disk exploded');

        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({description: toastDescriptionContaining('disk exploded')}));
    });

    it('drops the durable state when the save domain is cleared', () => {
        const surface = useWorkspaceFailureSurface();

        surface.reportSaveFailure('save-1', 'persist-rejected');
        expect(surface.hasSaveFailure.value).toBe(true);

        surface.clearSaveFailure();

        expect(surface.hasSaveFailure.value).toBe(false);
    });

    it('re-toasts an operation id that repeats after a clear', () => {
        const surface = useWorkspaceFailureSurface();

        surface.reportSaveFailure('save-1', 'persist-rejected');
        surface.clearSaveFailure();

        expect(surface.reportSaveFailure('save-1', 'persist-rejected')).toBe(true);
        expect(toastAddMock).toHaveBeenCalledTimes(2);
    });

    it('tells the user about a superseded save without keeping it against the next document', () => {
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportSaveFailure('save-1', 'document-changed')).toBe(true);

        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({description: toastDescriptionContaining('errors.save.documentChanged')}));
        expect(surface.hasSaveFailure.value).toBe(false);
    });

    it('keeps a rejected annotation out of the save state', () => {
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportAnnotationFailure(expectedAnnotationReport(
            'annotation-create-1',
            'selection-spans-pages',
        ))).toBe(true);

        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'warning',
            title: 'errors.annotation.create',
            description: 'errors.annotation.selectionSpansPages',
        }));
        expect(surface.hasSaveFailure.value).toBe(false);
    });

    it('separates annotation and save deduplication', () => {
        const surface = useWorkspaceFailureSurface();

        surface.reportSaveFailure('op-1', 'persist-rejected');
        surface.reportAnnotationFailure(expectedAnnotationReport('op-1', 'selection-spans-pages'));

        expect(toastAddMock).toHaveBeenCalledTimes(2);
    });

    it('stays silent for annotation reasons that are ordinary no-ops', () => {
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportAnnotationFailure(expectedAnnotationReport(
            'annotation-create-1',
            'no-selection',
        ))).toBe(false);
        expect(surface.reportAnnotationFailure(expectedAnnotationReport(
            'annotation-create-2',
            'editor-unavailable',
        ))).toBe(false);
        expect(surface.reportAnnotationFailure(expectedAnnotationReport(
            'annotation-create-3',
            'selection-not-in-text-layer',
        ))).toBe(false);

        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('presents the bridge-owned receipt for an annotation defect', () => {
        const receipt = {
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            eventId: 'annotation-failure-123456789',
            occurredAt: 1,
            severity: 'error',
        } as FailureReceipt;
        const capture = vi.spyOn(BrowserLogger, 'error');
        const surface = useWorkspaceFailureSurface();

        expect(surface.reportAnnotationFailure({
            kind: 'fault',
            operationId: 'annotation-create-1',
            pageNumber: requirePageNumber(1),
            reason: 'mode-switch-failed',
            failure: receipt,
        })).toBe(true);

        expect(capture).not.toHaveBeenCalled();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.annotation.create',
            description: toastDescriptionContaining('errors.runtime.errorId: annotati'),
        }));
    });
});
