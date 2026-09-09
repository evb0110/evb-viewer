import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { useExternalFileDrop } from '@app/modules/workspace-shell/composables/useExternalFileDrop';
import { requireDocumentRef } from '@contracts/documentRef';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import type * as PlatformDocuments from '@app/utils/platformDocuments';

type TCapturedListener = (event: DragEvent) => void;

interface ICapturedListeners {
    dragover?: TCapturedListener;
    drop?: TCapturedListener;
}

let capturedListeners: ICapturedListeners = {};
const toastAddMock = vi.fn();
const browserDocumentStoreMock = vi.hoisted(() => ({registerFileWithOwnership: vi.fn()}));
const cleanupFileMock = vi.hoisted(() => vi.fn(async (_path: string) => {}));

vi.mock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: browserDocumentStoreMock}));
vi.mock('@app/utils/platformDocuments', async importOriginal => ({
    ...await importOriginal<typeof PlatformDocuments>(),
    getDocumentWorkingCopyCapability: () => ({cleanupFile: cleanupFileMock}),
}));

vi.mock('@vueuse/core', () => ({ useEventListener: vi.fn((_target: unknown, event: string, listener: TCapturedListener) => {
    if (event === 'dragover' || event === 'drop') {
        capturedListeners[event] = listener;
    }

    return () => {
        if (event === 'dragover') {
            delete capturedListeners.dragover;
        }

        if (event === 'drop') {
            delete capturedListeners.drop;
        }
    };
}) }));

function createDragEvent(
    paths: string[],
    types: string[] = ['Files'],
    options: { defaultPrevented?: boolean } = {},
) {
    const files = paths.map((path, index) => {
        const file = new File([], `file-${index}`);
        Object.defineProperty(file, 'path', {
            configurable: true,
            value: path,
        });
        return file;
    });
    const event = new Event('drop', {cancelable: true});
    Object.defineProperties(event, {
        dataTransfer: {
            configurable: true,
            value: {
                types,
                files,
                dropEffect: 'none',
            },
        },
        defaultPrevented: {
            configurable: true,
            value: options.defaultPrevented ?? false,
        },
        preventDefault: {
            configurable: true,
            value: vi.fn(),
        },
        stopPropagation: {
            configurable: true,
            value: vi.fn(),
        },
    });

    // The drop handler only consumes this small Electron DataTransfer shim.
    return event as DragEvent;
}

async function flushDropQueue() {
    await Promise.resolve();
    await Promise.resolve();
    await delay(0);
}

describe('useExternalFileDrop', () => {
    beforeEach(() => {
        capturedListeners = {};
        toastAddMock.mockClear();
        browserDocumentStoreMock.registerFileWithOwnership.mockReset();
        cleanupFileMock.mockClear();
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        vi.stubGlobal('useToast', () => ({ add: toastAddMock }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('opens supported dropped files', async () => {
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});
        const pickerRegisterFilesForOpen = vi.fn(async (files: Array<{ name: string }>) => files.map((file) =>
            file.name === 'file-0'
                ? requireDocumentRef('/docs/a.pdf')
                : requireDocumentRef('/docs/b.djvu'),
        ));

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({documentPicker: { registerFilesForOpen: pickerRegisterFilesForOpen }}),
        });

        useExternalFileDrop({ openPathsInAppropriateTab });
        capturedListeners.drop?.(createDragEvent([
            '/docs/a.pdf',
            '/docs/b.djvu',
        ]));

        await flushDropQueue();

        expect(openPathsInAppropriateTab).toHaveBeenCalledWith([
            '/docs/a.pdf',
            '/docs/b.djvu',
        ]);
        expect(pickerRegisterFilesForOpen).toHaveBeenCalledTimes(2);
    });

    it('ignores unsupported extensions and non-file drags', async () => {
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({ documentPicker: {registerFilesForOpen: vi.fn(async () => [requireDocumentRef('/docs/readme.txt')])} }),
        });

        useExternalFileDrop({ openPathsInAppropriateTab });

        const nonFileEvent = createDragEvent(['/docs/readme.txt'], ['text/plain']);
        capturedListeners.dragover?.(nonFileEvent);
        capturedListeners.drop?.(nonFileEvent);

        const fileEvent = createDragEvent(['/docs/readme.txt']);
        capturedListeners.drop?.(fileEvent);
        await Promise.resolve();

        expect(nonFileEvent.preventDefault).not.toHaveBeenCalled();
        expect(openPathsInAppropriateTab).not.toHaveBeenCalled();
    });

    it('still handles valid file drops that were already prevented upstream', async () => {
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({ documentPicker: {registerFilesForOpen: vi.fn(async () => [requireDocumentRef('/docs/a.pdf')])} }),
        });

        useExternalFileDrop({ openPathsInAppropriateTab });

        const event = createDragEvent(
            ['/docs/a.pdf'],
            ['Files'],
            { defaultPrevented: true },
        );

        capturedListeners.drop?.(event);
        await flushDropQueue();

        expect(openPathsInAppropriateTab).toHaveBeenCalledWith(['/docs/a.pdf']);
    });

    it('stops processing queued paths after cleanup', async () => {
        let releaseFirstPathBarrier!: () => void;
        const firstBatchOpened = new Promise<void>((resolve) => {
            releaseFirstPathBarrier = resolve;
        });
        const openPathsInAppropriateTab = vi.fn(async (paths: string[]) => {
            if (paths.includes('/docs/a.pdf')) {
                await firstBatchOpened;
            }
        });

        const documentPicker = { registerFilesForOpen: vi.fn(async (files: Array<{ name: string }>) => files.map((file) =>
            file.name === 'file-0'
                ? requireDocumentRef('/docs/a.pdf')
                : requireDocumentRef('/docs/b.png'),
        )) };

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({ documentPicker }),
        });

        const { cleanup } = useExternalFileDrop({ openPathsInAppropriateTab });

        capturedListeners.drop?.(createDragEvent([
            '/docs/a.pdf',
            '/docs/b.png',
        ]));

        await flushDropQueue();
        expect(openPathsInAppropriateTab).toHaveBeenCalledWith([
            '/docs/a.pdf',
            '/docs/b.png',
        ]);

        cleanup();
        releaseFirstPathBarrier();
        await flushDropQueue();

        expect(openPathsInAppropriateTab).toHaveBeenCalledTimes(1);
    });

    it('reports failed dropped-file registration and opens remaining valid files', async () => {
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});
        const registerFilesForOpen = vi.fn(async (files: Array<{ name: string }>) => {
            if (files[0]?.name === 'file-0') {
                throw new Error('ingestion failed');
            }
            return [requireDocumentRef('/docs/b.pdf')];
        });

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: createElectronPlatformApiFixture({ documentPicker: { registerFilesForOpen } }),
        });

        useExternalFileDrop({ openPathsInAppropriateTab });
        capturedListeners.drop?.(createDragEvent([
            '/docs/a.pdf',
            '/docs/b.pdf',
        ]));

        await flushDropQueue();

        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.open',
            description: expect.stringContaining('ingestion failed'),
        }));
        expect(openPathsInAppropriateTab).toHaveBeenCalledWith(['/docs/b.pdf']);
    });

    it('does not start browser registration after cleanup', async () => {
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});
        const registerFilesForOpen = vi.fn(async () => [requireDocumentRef('/docs/a.pdf')]);

        vi.stubGlobal('window', undefined);
        const { cleanup } = useExternalFileDrop({ openPathsInAppropriateTab });
        capturedListeners.drop?.(createDragEvent(['/docs/a.pdf']));
        cleanup();
        await flushDropQueue();

        expect(browserDocumentStoreMock.registerFileWithOwnership).not.toHaveBeenCalled();
        expect(registerFilesForOpen).not.toHaveBeenCalled();
        expect(openPathsInAppropriateTab).not.toHaveBeenCalled();
    });

    it('releases newly owned browser refs when registration finishes after cleanup', async () => {
        let releaseRegistration!: (value: {
            ref: ReturnType<typeof requireDocumentRef>;
            created: boolean
        }) => void;
        const registration = new Promise<{
            ref: ReturnType<typeof requireDocumentRef>;
            created: boolean
        }>(resolve => {
            releaseRegistration = resolve;
        });
        browserDocumentStoreMock.registerFileWithOwnership.mockReturnValue(registration);
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});

        vi.stubGlobal('window', undefined);
        const { cleanup } = useExternalFileDrop({ openPathsInAppropriateTab });
        capturedListeners.drop?.(createDragEvent(['/docs/a.pdf']));
        await vi.waitFor(() => expect(browserDocumentStoreMock.registerFileWithOwnership).toHaveBeenCalledTimes(1));
        cleanup();
        releaseRegistration({
            ref: requireDocumentRef('/docs/a.pdf'),
            created: true,
        });
        await flushDropQueue();

        expect(openPathsInAppropriateTab).not.toHaveBeenCalled();
        expect(cleanupFileMock).toHaveBeenCalledTimes(1);
        expect(cleanupFileMock).toHaveBeenCalledWith('/docs/a.pdf');
    });

    it('keeps a deduplicated browser ref when the drop is canceled', async () => {
        let releaseRegistration!: (value: {
            ref: ReturnType<typeof requireDocumentRef>;
            created: boolean
        }) => void;
        browserDocumentStoreMock.registerFileWithOwnership.mockReturnValue(new Promise(resolve => {
            releaseRegistration = resolve;
        }));
        const openPathsInAppropriateTab = vi.fn(async (_paths: string[]) => {});

        vi.stubGlobal('window', undefined);
        const { cleanup } = useExternalFileDrop({ openPathsInAppropriateTab });
        capturedListeners.drop?.(createDragEvent(['/docs/recent.pdf']));
        await vi.waitFor(() => expect(browserDocumentStoreMock.registerFileWithOwnership).toHaveBeenCalledTimes(1));
        cleanup();
        releaseRegistration({
            ref: requireDocumentRef('/docs/recent.pdf'),
            created: false,
        });
        await flushDropQueue();

        expect(cleanupFileMock).not.toHaveBeenCalled();
        expect(openPathsInAppropriateTab).not.toHaveBeenCalled();
    });

    it('releases only newly owned refs after a callback failure', async () => {
        browserDocumentStoreMock.registerFileWithOwnership
            .mockResolvedValueOnce({
                ref: requireDocumentRef('/docs/a.pdf'),
                created: true,
            })
            .mockResolvedValueOnce({
                ref: requireDocumentRef('/docs/recent.pdf'),
                created: false,
            });
        const openPathsInAppropriateTab = vi.fn(async () => {
            throw new Error('open failed');
        });

        vi.stubGlobal('window', undefined);
        useExternalFileDrop({ openPathsInAppropriateTab });
        capturedListeners.drop?.(createDragEvent([
            '/docs/a.pdf',
            '/docs/recent.pdf',
        ]));
        await flushDropQueue();

        expect(cleanupFileMock).toHaveBeenCalledTimes(1);
        expect(cleanupFileMock).toHaveBeenCalledWith('/docs/a.pdf');
    });
});
