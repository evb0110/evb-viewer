import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePdfFile } from '@app/modules/workspace-shell/composables/usePdfFile';
import type {IPdfConformanceProfile} from '@app/types/pdfContracts';
import type { IPdfNativeMutationSet } from '@contracts/electronApiDocuments';
import { requirePageIndex } from '@contracts/pageNumbers';
import {requireDocumentRevisionToken} from '@contracts';

const analyticsMock = vi.hoisted(() => ({
    clearDocumentContext: vi.fn(),
    createDocumentScope: vi.fn(() => ({
        activate: vi.fn(),
        clear: vi.fn(),
        deactivate: vi.fn(),
        dispose: vi.fn(),
        key: 'test-document-scope',
        merge: vi.fn(),
        set: vi.fn(),
    })),
    setDocumentContext: vi.fn(),
    track: vi.fn(),
}));

const documentsMock = vi.hoisted(() => ({
    applyPdfNativeMutationsToWorkingCopy: vi.fn(async () => ({
        applied: true,
        validation: {
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        },
        stagedOutput: {
            path: '/tmp/staged-native.pdf',
            size: 4,
            sha256: 'a'.repeat(64),
            leaseId: 'staged-native-lease',
            revision: null,
        },
    })),
    commitStagedPdfNativeMutations: vi.fn(async () => ({
        applied: true,
        validation: {
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        },
    })),
    createManagedTempFileHandle: vi.fn(async () => ({
        path: '/tmp/work.pdf',
        size: 4,
        sha256: 'b'.repeat(64),
        leaseId: 'working-copy-expectation-lease',
        revision: null,
    })),
    getDocumentRevision: vi.fn(async () => ({
        authority: 'main-working-copy' as const,
        contentRevision: 2,
        documentRef: '/tmp/work.pdf',
        mintedAt: 2,
        token: requireDocumentRevisionToken('drt1:test:native-committed'),
        version: 1,
    })),
    readFile: vi.fn(async () => new Uint8Array([
        37,
        80,
        68,
        70,
    ])),
    releaseManagedTempFileHandle: vi.fn(async () => true),
    savePdfNativeMutations: vi.fn(async () => ({
        applied: true,
        validation: {
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        },
    })),
    savePdfNoteChanges: vi.fn(),
    savePdfNoteTextUpdates: vi.fn(),
    statFile: vi.fn(async () => ({size: 4})),
}));

vi.mock('@app/composables/useAnalytics', () => ({useAnalytics: () => analyticsMock}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent', () => ({useOcrTextContent: () => ({clearCache: vi.fn()})}));
vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => documentsMock,
    getDocumentWorkingCopyCapability: () => documentsMock,
    shouldRefreshWorkingCopyAfterSaveAs: () => false,
}));

const UNSIGNED_PROFILE: IPdfConformanceProfile = {
    isSigned: false,
    isEncrypted: false,
    isTagged: false,
    pdfaLevel: null,
    hasAcroForm: false,
    hasXfa: false,
    canIncrementalSave: true,
    saveRestrictions: [],
};

describe('usePdfFile native mutations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('useRuntimeEnvironment', () => ({isDesktopRuntime: ref(true)}));
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
    });

    it('persists markup-only mutation sets through the generic native IPC', async () => {
        const pdfFile = usePdfFile();
        const markup: NonNullable<IPdfNativeMutationSet['markup']> = {
            overrides: [[
                '44R',
                'Squiggly',
            ]],
            hints: [{
                subtype: 'Squiggly' as const,
                pageIndex: requirePageIndex(0),
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.2,
                },
                annotationId: '44R',
                color: '#22c55e',
                id: 'markup-1',
                pageMarkupIndex: 0,
                source: 'editor-live',
            }],
        };
        const mutations = {markup};

        pdfFile.workingCopyPath.value = '/tmp/work.pdf';
        pdfFile.originalPath.value = '/tmp/source.pdf';
        pdfFile.documentRevisionToken.value = requireDocumentRevisionToken('drt1:test:markup-base');
        pdfFile.pdfConformanceProfile.value = UNSIGNED_PROFILE;

        const result = await pdfFile.trySavePdfNativeMutations(mutations, {
            saveMode: 'rewrite',
            preserveLoadedSource: true,
            expectedWorkingPath: '/tmp/work.pdf',
            modifiedAt: 'D:20260609133855+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(documentsMock.createManagedTempFileHandle).not.toHaveBeenCalled();
        expect(documentsMock.applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            mutations,
            'D:20260609133855+03\'00\'',
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('drt1:test:markup-base')},
        );
        expect(documentsMock.commitStagedPdfNativeMutations).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            expect.objectContaining({leaseId: 'staged-native-lease'}),
            expect.objectContaining({expectedDocumentRevisionToken: requireDocumentRevisionToken('drt1:test:markup-base')}),
        );
        expect(documentsMock.savePdfNoteChanges).not.toHaveBeenCalled();
        expect(documentsMock.savePdfNoteTextUpdates).not.toHaveBeenCalled();
    });

    it('keeps preserved-source native saves out of the file undo timeline', async () => {
        const pdfFile = usePdfFile();
        const initialBytes = new Uint8Array([
            37,
            80,
            68,
            70,
        ]);
        const savedBytes = new Uint8Array([
            37,
            80,
            68,
            70,
            45,
        ]);
        const mutations: IPdfNativeMutationSet = {pageLabels: {
            totalPages: 1,
            ranges: [{
                startPage: 1,
                style: 'D',
                prefix: '',
                startNumber: 1,
            }],
        }};

        pdfFile.workingCopyPath.value = '/tmp/work.pdf';
        pdfFile.originalPath.value = '/tmp/source.pdf';
        pdfFile.pdfConformanceProfile.value = UNSIGNED_PROFILE;
        await pdfFile.loadPdfFromData(initialBytes);
        pdfFile.documentRevisionToken.value = requireDocumentRevisionToken('drt1:test:loaded-base');
        const versionAfterLoad = pdfFile.fileHistoryMutationVersion.value;

        documentsMock.statFile.mockResolvedValueOnce({size: savedBytes.byteLength});
        documentsMock.readFile.mockResolvedValueOnce(savedBytes);
        const result = await pdfFile.trySavePdfNativeMutations(mutations, {
            saveMode: 'rewrite',
            preserveLoadedSource: true,
            expectedWorkingPath: '/tmp/work.pdf',
            modifiedAt: 'D:20260609133855+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(pdfFile.fileHistoryMutationVersion.value).toBe(versionAfterLoad);
        expect(pdfFile.canUndo.value).toBe(false);
    });
});
