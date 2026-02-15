import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useExternalFileDrop } from '@app/composables/page/useExternalFileDrop';

function createDragEvent(paths: string[], types: string[] = ['Files']) {
    const files = paths.map((_path, index) => ({ name: `file-${index}` })) as File[];
    const event = {
        defaultPrevented: false,
        target: null,
        dataTransfer: {
            types,
            files,
            dropEffect: 'none',
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
    return event as DragEvent;
}

describe('useExternalFileDrop', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('opens supported dropped files', async () => {
        const openPathInAppropriateTab = vi.fn(async (_path: string) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: { getPathForFile: vi.fn((file: { name: string }) => {
                if (file.name === 'file-0') {
                    return '/docs/a.pdf';
                }
                return '/docs/b.djvu';
            }) },
        });

        const { handleWindowDrop } = useExternalFileDrop({ openPathInAppropriateTab });
        handleWindowDrop(createDragEvent([
            '/docs/a.pdf',
            '/docs/b.djvu',
        ]));

        await Promise.resolve();
        await Promise.resolve();

        expect(openPathInAppropriateTab).toHaveBeenNthCalledWith(1, '/docs/a.pdf');
        expect(openPathInAppropriateTab).toHaveBeenNthCalledWith(2, '/docs/b.djvu');
    });

    it('ignores unsupported extensions and non-file drags', async () => {
        const openPathInAppropriateTab = vi.fn(async (_path: string) => {});

        vi.stubGlobal('window', {
            ...globalThis,
            electronAPI: { getPathForFile: vi.fn(() => '/docs/readme.txt') },
        });

        const {
            handleWindowDragOver,
            handleWindowDrop,
        } = useExternalFileDrop({ openPathInAppropriateTab });

        const nonFileEvent = createDragEvent(['/docs/readme.txt'], ['text/plain']);
        handleWindowDragOver(nonFileEvent);
        handleWindowDrop(nonFileEvent);

        const fileEvent = createDragEvent(['/docs/readme.txt']);
        handleWindowDrop(fileEvent);
        await Promise.resolve();

        expect(nonFileEvent.preventDefault).not.toHaveBeenCalled();
        expect(openPathInAppropriateTab).not.toHaveBeenCalled();
    });
});
