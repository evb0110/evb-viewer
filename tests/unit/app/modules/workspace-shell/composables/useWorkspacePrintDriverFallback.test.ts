import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { useWorkspacePrint } from '@app/modules/workspace-shell/composables/useWorkspacePrint';
import type {
    IWorkspaceDriverPrintRequest,
    TWorkspaceDriverCommandResult,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';

const documentsCapabilityMock = vi.hoisted(() => ({
    cancelPdfPrint: vi.fn(async () => ({canceled: true})),
    onNativePrintDialogOpened: vi.fn(() => vi.fn()),
    printPdfData: vi.fn(),
}));
const toastAddMock = vi.hoisted(() => vi.fn());
const toastRemoveMock = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentPdfCapability: () => documentsCapabilityMock,
    isNativePrintCapabilityUnavailable: (result: {
        success: boolean;
        canceled?: boolean;
        error?: string;
    }) => (
        result.success !== true
        && result.canceled !== true
        && result.error === 'Printing via the native desktop dialog is unavailable in the browser capability'
    ),
}));

function flushMicrotasks() {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

function createState() {
    const preparePrintSource = vi.fn(async (
        _payload: IWorkspaceDriverPrintRequest,
    ): Promise<TWorkspaceDriverCommandResult> => ({
        status: 'unavailable',
        capability: 'print',
    }));
    const getQuickPrintPageMetrics = vi.fn(async () => [{
        width: 612,
        height: 792,
    }]);
    const getPrintableSourceData = vi.fn(async () => Uint8Array.of(9, 8, 7));
    const scope = effectScope();
    const state = scope.run(() => useWorkspacePrint({
        totalPages: ref(10),
        currentPage: ref(4),
        selectedPages: ref([4]),
        sourcePdf: ref(null),
        workingCopyPath: ref<string | null>(null),
        fileName: ref('document.pdf'),
        hasPendingUnsavedChanges: ref(false),
        getQuickPrintPageMetrics,
        getPrintableSourceData,
        preparePrintSource,
        isDriverOwnedQuickPrint: () => false,
    }));

    if (!state) {
        throw new Error('Failed to create workspace print scope');
    }

    return {
        getPrintableSourceData,
        getQuickPrintPageMetrics,
        preparePrintSource,
        scope,
        state,
    };
}

describe('useWorkspacePrint driver fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        toastAddMock.mockReturnValue({id: 'toast-id'});
        documentsCapabilityMock.printPdfData.mockResolvedValue({success: true});
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        vi.stubGlobal('useToast', () => ({
            add: toastAddMock,
            remove: toastRemoveMock,
        }));
        vi.stubGlobal('window', {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            setTimeout: (callback: () => void) => {
                callback();
                return 1;
            },
            clearTimeout: vi.fn(),
        });
    });

    it('keeps PDF quick-print metrics fallback when driver preparation is unavailable', async () => {
        const {
            getPrintableSourceData,
            getQuickPrintPageMetrics,
            preparePrintSource,
            scope,
            state,
        } = createState();

        try {
            await state.handleQuickPrint();
            await flushMicrotasks();

            expect(preparePrintSource).toHaveBeenCalledOnce();
            expect(getQuickPrintPageMetrics).toHaveBeenCalledOnce();
            expect(getPrintableSourceData).toHaveBeenCalledOnce();
            expect(documentsCapabilityMock.printPdfData).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                'document.pdf',
                {requestId: expect.stringMatching(/^print-/u)},
            );
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });
});
