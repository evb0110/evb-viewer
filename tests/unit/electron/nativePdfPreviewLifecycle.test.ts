import type * as TViMockOriginalModule from '@electron/native-tools/buildPopplerEnv';
import type * as TViMockOriginalModule2 from '@electron/pdf/nativeToolPaths';

import { EventEmitter } from 'node:events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireRequestId} from '@contracts/shared';
import {mainJobBroker} from '@electron/resources/jobBroker';

const mocks = vi.hoisted(() => ({
    mkdtemp: vi.fn(),
    readFile: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    resolveExistingReadablePdfPath: vi.fn(),
    buildPopplerEnv: vi.fn(),
    getPdfNativeToolPaths: vi.fn(),
    runNativeToolCommand: vi.fn(),
    cancelNativeCommandGroup: vi.fn(),
    getRecentFiles: vi.fn(),
    allowOpenPath: vi.fn(),
    resolveOriginalBackedReadTransport: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    mkdtemp: (...args: unknown[]) => mocks.mkdtemp(...args),
    readFile: (...args: unknown[]) => mocks.readFile(...args),
    rm: (...args: unknown[]) => mocks.rm(...args),
    stat: (...args: unknown[]) => mocks.stat(...args),
}));
vi.mock('@electron/features/documents/main/documentFilePathResolution', () => ({resolveExistingReadablePdfPath: (...args: unknown[]) => mocks.resolveExistingReadablePdfPath(...args)}));
vi.mock('@electron/native-tools/buildPopplerEnv', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    buildPopplerEnv: (...args: unknown[]) => mocks.buildPopplerEnv(...args),
}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    getPdfNativeToolPaths: (...args: unknown[]) => mocks.getPdfNativeToolPaths(...args),
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({cancelNativeCommandGroup: (...args: unknown[]) => mocks.cancelNativeCommandGroup(...args)}));
vi.mock('@electron/recentFiles', () => ({getRecentFiles: (...args: unknown[]) => mocks.getRecentFiles(...args)}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args)}));
vi.mock('@electron/features/documents/main/documentFileReadHandlers', () => ({resolveOriginalBackedReadTransport: (...args: unknown[]) =>
    mocks.resolveOriginalBackedReadTransport(...args)}));

class FakeSender extends EventEmitter {
    destroyed = false;
    readonly id = 42;

    isDestroyed() {
        return this.destroyed;
    }
}

function createJpegBytes(width: number, height: number) {
    const bytes = Buffer.alloc(23);
    bytes.set([
        0xff,
        0xd8,
        0xff,
        0xe0,
        0x00,
        0x04,
        0x00,
        0x00,
        0xff,
        0xc2,
        0x00,
        0x0b,
        0x08,
    ], 0);
    bytes.writeUInt16BE(height, 13);
    bytes.writeUInt16BE(width, 15);
    bytes.set([
        0x01,
        0x01,
        0x11,
        0x00,
        0xff,
        0xd9,
    ], 17);
    return bytes;
}

describe('native PDF preview lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mkdtemp.mockResolvedValue('/tmp/native-preview');
        mocks.readFile.mockResolvedValue(createJpegBytes(640, 480));
        mocks.rm.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({
            size: 28_000_000,
            mtimeMs: 1_720_000_000_000,
        });
        mocks.resolveExistingReadablePdfPath.mockResolvedValue('/tmp/input.pdf');
        mocks.buildPopplerEnv.mockReturnValue({POPPLER: '1'});
        mocks.getPdfNativeToolPaths.mockReturnValue({
            pdfinfo: '/mock/pdfinfo',
            pdftoppm: '/mock/pdftoppm',
        });
        mocks.runNativeToolCommand.mockResolvedValue({
            exitCode: 0,
            stdout: '',
            stderr: '',
        });
        mocks.getRecentFiles.mockResolvedValue([]);
        mocks.allowOpenPath.mockReturnValue('/tmp/input.pdf');
        mocks.resolveOriginalBackedReadTransport.mockReturnValue(null);
    });

    afterEach(async () => {
        const { resetMainOperationLifecycleForTests } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        resetMainOperationLifecycleForTests();
    });

    it('admits the first native page through the interactive lane', async () => {
        const sender = new FakeSender();
        const acquire = vi.spyOn(mainJobBroker, 'acquire');
        const {handlePdfNativePagePreview} = await import('@electron/features/documents/main/nativePdfPreview');

        await handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf', 1);

        expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
            ownerId: String(sender.id),
            kind: 'native-pdf-preview',
            priority: 'visible',
            admissionClass: 'interactive',
            resources: expect.objectContaining({
                cpuTokens: 1,
                nativeProcesses: 1,
                ioWeight: 1,
            }),
        }));
        acquire.mockRestore();
    });

    it('aborts the pdftoppm command when the requesting renderer is destroyed', async () => {
        const sender = new FakeSender();
        const capturedOptions: Array<{
            signal?: AbortSignal;
            cancelGroup?: string;
        }> = [];
        mocks.runNativeToolCommand.mockImplementationOnce((_command: string, _args: string[], options: {
            signal?: AbortSignal;
            cancelGroup?: string;
        }) => {
            capturedOptions.push(options);
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    reject(options.signal?.reason);
                }, {once: true});
            });
        });
        const { handlePdfNativePagePreview } = await import('@electron/features/documents/main/nativePdfPreview');
        const { snapshotMainOperations } = await import('@electron/operation-lifecycle/mainOperationLifecycle');

        const previewPromise = handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf', 1);
        await vi.waitFor(() => {
            expect(capturedOptions).toHaveLength(1);
        });
        const [options] = capturedOptions;
        if (!options) {
            throw new Error('Expected pdftoppm options to be captured.');
        }

        expect(snapshotMainOperations()).toEqual([expect.objectContaining({
            kind: 'abortable-work',
            ownerWebContentsId: sender.id,
            workingCopyPath: '/tmp/input.pdf',
        })]);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.cancelGroup).toMatch(/^pdf-native-preview:/u);

        sender.destroyed = true;
        sender.emit('destroyed');

        await expect(previewPromise).rejects.toThrow('Renderer lifecycle ended');
        expect(options.signal?.aborted).toBe(true);
        expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledWith(expect.stringMatching(/^pdf-native-preview:/u));
        expect(snapshotMainOperations()).toEqual([]);
    });

    it('aborts native page-size discovery when the requesting renderer is destroyed', async () => {
        const sender = new FakeSender();
        const capturedOptions: Array<{
            signal?: AbortSignal;
            cancelGroup?: string;
        }> = [];
        mocks.runNativeToolCommand.mockImplementationOnce((_command: string, _args: string[], options: {
            signal?: AbortSignal;
            cancelGroup?: string;
        }) => {
            capturedOptions.push(options);
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    reject(options.signal?.reason);
                }, {once: true});
            });
        });
        const { handlePdfNativePageSizes } = await import('@electron/features/documents/main/nativePdfPreview');
        const { snapshotMainOperations } = await import('@electron/operation-lifecycle/mainOperationLifecycle');

        const pageSizesPromise = handlePdfNativePageSizes({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf');
        await vi.waitFor(() => {
            expect(capturedOptions).toHaveLength(1);
        });
        const [options] = capturedOptions;
        if (!options) {
            throw new Error('Expected pdfinfo options to be captured.');
        }

        expect(snapshotMainOperations()).toEqual([expect.objectContaining({
            kind: 'abortable-work',
            ownerWebContentsId: sender.id,
            workingCopyPath: '/tmp/input.pdf',
        })]);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.cancelGroup).toMatch(/^pdf-native-page-sizes:/u);

        sender.destroyed = true;
        sender.emit('destroyed');

        await expect(pageSizesPromise).rejects.toThrow('Renderer lifecycle ended');
        expect(options.signal?.aborted).toBe(true);
        expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledWith(expect.stringMatching(/^pdf-native-page-sizes:/u));
        expect(snapshotMainOperations()).toEqual([]);
    });

    it('aborts opening-geometry discovery when the requesting renderer is destroyed', async () => {
        const sender = new FakeSender();
        let commandOptions: {
            signal?: AbortSignal;
            cancelGroup?: string
        } | undefined;
        mocks.runNativeToolCommand.mockImplementationOnce((_command: string, _args: string[], options: {
            signal?: AbortSignal;
            cancelGroup?: string;
        }) => {
            commandOptions = options;
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {once: true});
            });
        });
        const { handlePdfOpeningGeometry } = await import('@electron/features/documents/main/nativePdfPreview');

        const geometryPromise = handlePdfOpeningGeometry({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf');
        await vi.waitFor(() => expect(commandOptions).toBeDefined());
        sender.destroyed = true;
        sender.emit('destroyed');

        await expect(geometryPromise).rejects.toThrow('Renderer lifecycle ended');
        expect(commandOptions?.signal?.aborted).toBe(true);
        expect(mocks.cancelNativeCommandGroup)
            .toHaveBeenCalledWith(expect.stringMatching(/^pdf-opening-geometry:/u));
    });

    it('discovers only first-page opening geometry and fences the source identity', async () => {
        const sender = new FakeSender();
        mocks.runNativeToolCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: [
                'Pages: 431',
                'Page    1 size: 612 x 792 pts (letter)',
                'Page    1 rot: 90',
                '',
            ].join('\n'),
        });
        const { handlePdfOpeningGeometry } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfOpeningGeometry({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf')).resolves.toEqual({
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 90,
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        });

        expect(mocks.resolveExistingReadablePdfPath).toHaveBeenCalledWith('/tmp/input.pdf', sender.id);
        expect(mocks.stat).toHaveBeenCalledTimes(2);
        expect(mocks.runNativeToolCommand).toHaveBeenCalledOnce();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdfinfo',
            [
                '-box',
                '-f',
                '1',
                '-l',
                '1',
                '/tmp/input.pdf',
            ],
            expect.objectContaining({
                commandLabel: 'pdfinfo-opening-geometry',
                cancelGroup: expect.stringMatching(/^pdf-opening-geometry:/u),
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it('returns a typed miss before probing a retired working-copy path', async () => {
        const { handlePdfOpeningGeometry } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfOpeningGeometry(
            {senderId: 42},
            '/tmp/pdf-work-retired/old.pdf',
        )).resolves.toBeNull();

        expect(mocks.resolveExistingReadablePdfPath).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('returns a typed miss when the admitted file disappears before identity probing', async () => {
        mocks.stat.mockRejectedValueOnce(Object.assign(
            new Error('missing opening geometry source'),
            {code: 'ENOENT'},
        ));
        const { handlePdfOpeningGeometry } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfOpeningGeometry(
            {senderId: 42},
            '/tmp/input.pdf',
        )).resolves.toBeNull();

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('probes lazy-original opening geometry through its witnessed source without materializing', async () => {
        const sender = new FakeSender();
        const read = vi.fn(async (reader: (physicalPath: string) => Promise<unknown>) =>
            reader('/Users/alice/Documents/input.pdf'));
        mocks.resolveExistingReadablePdfPath.mockResolvedValueOnce('/tmp/pdf-work/input.pdf');
        mocks.resolveOriginalBackedReadTransport.mockReturnValueOnce({
            identity: {
                size: 28_000_000,
                modifiedAt: 1_720_000_000_000,
            },
            read,
        });
        mocks.runNativeToolCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: 'Pages: 1\nPage 1 size: 612 x 792 pts\nPage 1 rot: 0\n',
        });
        const { handlePdfOpeningGeometry } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfOpeningGeometry({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/pdf-work/input.pdf')).resolves.toMatchObject({
            pageNumber: 1,
            pageCount: 1,
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        });

        expect(mocks.resolveOriginalBackedReadTransport)
            .toHaveBeenCalledWith('/tmp/pdf-work/input.pdf', sender.id);
        expect(read).toHaveBeenCalledOnce();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdfinfo',
            expect.arrayContaining(['/Users/alice/Documents/input.pdf']),
            expect.objectContaining({commandLabel: 'pdfinfo-opening-geometry'}),
        );
    });

    it('discovers lazy-original page sizes through the witnessed source', async () => {
        const sender = new FakeSender();
        const read = vi.fn(async (reader: (physicalPath: string) => Promise<unknown>) =>
            reader('/Users/alice/Documents/input.pdf'));
        mocks.resolveExistingReadablePdfPath.mockResolvedValueOnce('/tmp/pdf-work/input.pdf');
        mocks.resolveOriginalBackedReadTransport.mockReturnValueOnce({
            identity: {
                size: 28_000_000,
                modifiedAt: 1_720_000_000_000,
            },
            read,
        });
        mocks.runNativeToolCommand
            .mockResolvedValueOnce({
                exitCode: 0,
                stderr: '',
                stdout: 'Pages: 1\nPage size: 612 x 792 pts\n',
            })
            .mockResolvedValueOnce({
                exitCode: 0,
                stderr: '',
                stdout: 'Pages: 1\nPage 1 size: 612 x 792 pts\nPage 1 rot: 0\n',
            });
        const { handlePdfNativePageSizes } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfNativePageSizes({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/pdf-work/input.pdf')).resolves.toEqual([expect.objectContaining({
            width: 612,
            height: 792,
        })]);

        expect(read).toHaveBeenCalledOnce();
        for (const [
            , args,
        ] of mocks.runNativeToolCommand.mock.calls) {
            expect(args).toContain('/Users/alice/Documents/input.pdf');
            expect(args).not.toContain('/tmp/pdf-work/input.pdf');
        }
    });

    it('renders a lazy-original page preview through the witnessed source', async () => {
        const sender = new FakeSender();
        const read = vi.fn(async (reader: (physicalPath: string) => Promise<unknown>) =>
            reader('/Users/alice/Documents/input.pdf'));
        mocks.resolveExistingReadablePdfPath.mockResolvedValueOnce('/tmp/pdf-work/input.pdf');
        mocks.resolveOriginalBackedReadTransport.mockReturnValueOnce({
            identity: {
                size: 28_000_000,
                modifiedAt: 1_720_000_000_000,
            },
            read,
        });
        mocks.stat.mockResolvedValueOnce({size: 4_096});
        const { handlePdfNativePagePreview } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/pdf-work/input.pdf', 1)).resolves.toMatchObject({
            width: 640,
            height: 480,
        });

        expect(read).toHaveBeenCalledOnce();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdftoppm',
            expect.arrayContaining(['/Users/alice/Documents/input.pdf']),
            expect.objectContaining({commandLabel: 'pdftoppm'}),
        );
    });

    it('preserves a typed backing error when the lazy source swaps during geometry discovery', async () => {
        const backingError = Object.assign(
            new Error('Working-copy registration changed during the read'),
            {code: 'WORKING_COPY_REGISTRATION_CHANGED'},
        );
        mocks.resolveOriginalBackedReadTransport.mockReturnValueOnce({
            identity: {
                size: 28_000_000,
                modifiedAt: 1_720_000_000_000,
            },
            read: vi.fn(async (reader: (physicalPath: string) => Promise<unknown>) => {
                await reader('/Users/alice/Documents/input.pdf');
                throw backingError;
            }),
        });
        const { handlePdfOpeningGeometry } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfOpeningGeometry({senderId: 42}, '/tmp/input.pdf'))
            .rejects
            .toMatchObject({code: 'WORKING_COPY_REGISTRATION_CHANGED'});

        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledOnce();
    });

    it('authorizes opening-geometry preflight for a current Recent PDF before open', async () => {
        const sender = new FakeSender();
        mocks.resolveExistingReadablePdfPath
            .mockRejectedValueOnce(new Error('path capability missing'));
        mocks.getRecentFiles.mockResolvedValueOnce([{
            originalPath: '/tmp/recent.pdf',
            fileName: 'recent.pdf',
            lastOpened: 1,
        }]);
        mocks.allowOpenPath.mockReturnValueOnce('/tmp/recent.pdf');
        mocks.runNativeToolCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: 'Pages: 1\nPage 1 size: 612 x 792 pts\nPage 1 rot: 0\n',
        });
        const { handlePdfOpeningGeometry } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfOpeningGeometry({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/recent.pdf')).resolves.toMatchObject({
            pageNumber: 1,
            pageCount: 1,
            width: 612,
            height: 792,
        });

        expect(mocks.getRecentFiles).toHaveBeenCalledOnce();
        expect(mocks.allowOpenPath).toHaveBeenCalledWith('/tmp/recent.pdf', sender);
        expect(mocks.resolveExistingReadablePdfPath).toHaveBeenCalledOnce();
    });

    it('rejects opening geometry when the original source changes during discovery', async () => {
        mocks.stat
            .mockResolvedValueOnce({
                size: 10,
                mtimeMs: 100,
            })
            .mockResolvedValueOnce({
                size: 11,
                mtimeMs: 101,
            });
        mocks.runNativeToolCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: 'Pages: 1\nPage 1 size: 612 x 792 pts\nPage 1 rot: 0\n',
        });
        const { handlePdfOpeningGeometry } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfOpeningGeometry({senderId: 42}, '/tmp/input.pdf'))
            .rejects
            .toThrow('PDF changed while opening geometry was being discovered');
    });

    it('uses one abort scope for both native page-size discovery commands', async () => {
        const sender = new FakeSender();
        const capturedOptions: Array<{
            signal?: AbortSignal;
            cancelGroup?: string;
        }> = [];
        mocks.runNativeToolCommand
            .mockImplementationOnce((_command: string, _args: string[], options: {
                signal?: AbortSignal;
                cancelGroup?: string;
            }) => {
                capturedOptions.push(options);
                return Promise.resolve({
                    exitCode: 0,
                    stderr: '',
                    stdout: 'Pages: 2\nPage size: 612 x 792 pts\n',
                });
            })
            .mockImplementationOnce((_command: string, _args: string[], options: {
                signal?: AbortSignal;
                cancelGroup?: string;
            }) => {
                capturedOptions.push(options);
                return Promise.resolve({
                    exitCode: 0,
                    stderr: '',
                    stdout: [
                        'Pages: 2',
                        'Page 1 size: 612 x 792 pts',
                        'Page 2 size: 300 x 400 pts',
                        '',
                    ].join('\n'),
                });
            });
        const { handlePdfNativePageSizes } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfNativePageSizes({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf')).resolves.toEqual([
            {
                width: 612,
                height: 792,
            },
            {
                width: 300,
                height: 400,
            },
        ]);

        expect(capturedOptions).toHaveLength(2);
        expect(capturedOptions[0]?.signal).toBeInstanceOf(AbortSignal);
        expect(capturedOptions[1]?.signal).toBe(capturedOptions[0]?.signal);
        expect(capturedOptions[0]?.cancelGroup).toMatch(/^pdf-native-page-sizes:/u);
        expect(capturedOptions[1]?.cancelGroup).toBe(capturedOptions[0]?.cancelGroup);
        expect(mocks.runNativeToolCommand).toHaveBeenNthCalledWith(
            2,
            '/mock/pdfinfo',
            [
                '-box',
                '-f',
                '1',
                '-l',
                '2',
                '/tmp/input.pdf',
            ],
            expect.objectContaining({
                commandLabel: 'pdfinfo',
                env: {POPPLER: '1'},
                rejectOnStdoutTruncation: true,
            }),
        );
    });

    it('reads bounded first and last page-size windows for a million-page document', async () => {
        const sender = new FakeSender();
        const pageCount = 1_000_000;
        mocks.runNativeToolCommand
            .mockResolvedValueOnce({
                exitCode: 0,
                stderr: '',
                stdout: `Pages: ${String(pageCount)}\nPage size: 612 x 792 pts\n`,
            })
            .mockResolvedValueOnce({
                exitCode: 0,
                stderr: '',
                stdout: 'Page 1 size: 612 x 792 pts\n',
            })
            .mockResolvedValueOnce({
                exitCode: 0,
                stderr: '',
                stdout: `Page ${String(pageCount)} size: 400 x 500 pts\n`,
            });
        const {handlePdfNativePageSizes} = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfNativePageSizes({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf')).resolves.toEqual({
            pageCount,
            defaultPageSize: {
                width: 612,
                height: 792,
            },
            overrides: [{
                pageNumber: pageCount,
                width: 400,
                height: 500,
            }],
        });

        expect(mocks.runNativeToolCommand).toHaveBeenCalledTimes(3);
        expect(mocks.runNativeToolCommand).toHaveBeenNthCalledWith(
            2,
            '/mock/pdfinfo',
            [
                '-box',
                '-f',
                '1',
                '-l',
                '64',
                '/tmp/input.pdf',
            ],
            expect.objectContaining({
                maxStdoutBytes: 256 * 1024,
                rejectOnStdoutTruncation: true,
            }),
        );
        expect(mocks.runNativeToolCommand).toHaveBeenNthCalledWith(
            3,
            '/mock/pdfinfo',
            [
                '-box',
                '-f',
                '999937',
                '-l',
                String(pageCount),
                '/tmp/input.pdf',
            ],
            expect.objectContaining({
                maxStdoutBytes: 256 * 1024,
                rejectOnStdoutTruncation: true,
            }),
        );
    });

    it('cancels an in-flight native preview by request id', async () => {
        const sender = new FakeSender();
        const capturedOptions: Array<{
            signal?: AbortSignal;
            cancelGroup?: string;
        }> = [];
        mocks.runNativeToolCommand.mockImplementationOnce((_command: string, _args: string[], options: {
            signal?: AbortSignal;
            cancelGroup?: string;
        }) => {
            capturedOptions.push(options);
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    reject(options.signal?.reason);
                }, {once: true});
            });
        });
        const {
            handleCancelPdfNativePagePreview,
            handlePdfNativePagePreview,
        } = await import('@electron/features/documents/main/nativePdfPreview');

        const previewPromise = handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf', 1, {previewRequestId: requireRequestId('preview-1')});
        await vi.waitFor(() => {
            expect(capturedOptions).toHaveLength(1);
        });

        await expect(handleCancelPdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, requireRequestId('preview-1'))).resolves.toEqual({canceled: true});
        await expect(previewPromise).rejects.toThrow('Native PDF preview canceled');
        expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledWith(expect.stringMatching(/^pdf-native-preview:/u));
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/native-preview', {
            recursive: true,
            force: true,
        });
    });

    it('cancels a native preview before path resolution starts any native work', async () => {
        const sender = new FakeSender();
        const pathResolution = deferred<string>();
        mocks.resolveExistingReadablePdfPath.mockReturnValueOnce(pathResolution.promise);
        const acquire = vi.spyOn(mainJobBroker, 'acquire');
        const {
            handleCancelPdfNativePagePreview,
            handlePdfNativePagePreview,
        } = await import('@electron/features/documents/main/nativePdfPreview');

        const previewPromise = handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf', 1, {previewRequestId: requireRequestId('preview-path-resolution')});

        await expect(handleCancelPdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, requireRequestId('preview-path-resolution'))).resolves.toEqual({canceled: true});
        pathResolution.resolve('/tmp/input.pdf');

        await expect(previewPromise).rejects.toThrow('Native PDF preview canceled');
        expect(acquire).not.toHaveBeenCalled();
        expect(mocks.resolveOriginalBackedReadTransport).not.toHaveBeenCalled();
        expect(mocks.getPdfNativeToolPaths).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.mkdtemp).not.toHaveBeenCalled();
        expect(mocks.rm).not.toHaveBeenCalled();
        acquire.mockRestore();
    });

    it('caps requested native preview width at a high-DPI friendly limit', async () => {
        const sender = new FakeSender();
        const { handlePdfNativePagePreview } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf', 1, {targetWidthPx: 8_000})).resolves.toMatchObject({
            width: 640,
            height: 480,
            rasterWidthCeilingPx: 4_096,
        });

        const args = mocks.runNativeToolCommand.mock.calls[0]?.[1] as string[] | undefined;
        expect(args).toBeDefined();
        const scaleToXIndex = args?.indexOf('-scale-to-x') ?? -1;
        expect(scaleToXIndex).toBeGreaterThanOrEqual(0);
        expect(args?.[scaleToXIndex + 1]).toBe('4096');
        expect(args).toContain('-jpeg');
        expect(args).not.toContain('-png');
        expect(args?.[args.indexOf('-jpegopt') + 1]).toBe('quality=98,optimize=n,progressive=n');
        expect(mocks.stat).toHaveBeenCalledWith('/tmp/native-preview/page.jpg');
        expect(mocks.readFile).toHaveBeenCalledWith('/tmp/native-preview/page.jpg');
    });

    it('renders a searchable full-page scan at requested widths and reports the process ceiling', async () => {
        const sender = new FakeSender();
        const fullPageRasterListing = [
            'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
            '1 0 image 2008 3189 rgb 3 8 jpeg no 7903 0 300 300 183K 0.9%',
        ].join('\n');
        const searchableOverlayText = 'Searchable OCR overlay';
        mocks.getPdfNativeToolPaths.mockReturnValue({
            pdfimages: '/mock/pdfimages',
            pdfinfo: '/mock/pdfinfo',
            pdftotext: '/mock/pdftotext',
            pdftoppm: '/mock/pdftoppm',
        });
        mocks.runNativeToolCommand.mockImplementation((command: string) => {
            let stdout = '';
            if (command === '/mock/pdfimages') {
                stdout = fullPageRasterListing;
            } else if (command === '/mock/pdftotext') {
                stdout = searchableOverlayText;
            }
            return Promise.resolve({
                exitCode: 0,
                stderr: '',
                stdout,
            });
        });
        const { handlePdfNativePagePreview } = await import('@electron/features/documents/main/nativePdfPreview');

        const firstPreview = await handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/searchable-scan.pdf', 1, {targetWidthPx: 3_598});
        const secondPreview = await handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/searchable-scan.pdf', 1, {targetWidthPx: 4_000});

        const callsByCommand = (command: string) => mocks.runNativeToolCommand.mock.calls
            .filter(([calledCommand]) => calledCommand === command);
        expect(firstPreview.rasterWidthCeilingPx).toBe(4_096);
        expect(secondPreview.rasterWidthCeilingPx).toBe(4_096);
        expect(callsByCommand('/mock/pdfinfo')).toHaveLength(0);
        expect(callsByCommand('/mock/pdfimages')).toHaveLength(0);
        expect(callsByCommand('/mock/pdftotext')).toHaveLength(0);
        expect(callsByCommand('/mock/pdftoppm')).toHaveLength(2);
        expect(callsByCommand('/mock/pdftoppm').map(([
            , args,
        ]) => {
            const scaleToXIndex = (args as string[]).indexOf('-scale-to-x');
            return (args as string[])[scaleToXIndex + 1];
        })).toEqual([
            '3598',
            '4000',
        ]);
    });

    it('coalesces identical in-flight native preview requests', async () => {
        const sender = new FakeSender();
        const command = deferred<{
            exitCode: number;
            stdout: string;
            stderr: string;
        }>();
        mocks.runNativeToolCommand.mockReturnValueOnce(command.promise);
        const { handlePdfNativePagePreview } = await import('@electron/features/documents/main/nativePdfPreview');
        const options = {previewRequestId: requireRequestId('preview-coalesced')};

        const first = handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf', 1, options);
        const second = handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf', 1, options);
        await vi.waitFor(() => {
            expect(mocks.runNativeToolCommand).toHaveBeenCalledTimes(1);
        });
        command.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
        });

        await expect(Promise.all([
            first,
            second,
        ])).resolves.toEqual([
            expect.objectContaining({
                width: 640,
                height: 480,
            }),
            expect.objectContaining({
                width: 640,
                height: 480,
            }),
        ]);
        expect(mocks.runNativeToolCommand).toHaveBeenCalledTimes(1);
    });
});

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return {
        promise,
        resolve,
    };
}
