import {closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {devNull} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createTempSiblingPath, PdfPageOpsNativeError, type IPageOpsProcessResult} from '@node-runtime/pdfPageOpsWasmRunner';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const QPDF_WASM_FILE_NAME = 'evb-qpdf.wasm';
export const QPDF_MJS_FILE_NAME = 'evb-qpdf.mjs';

const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 1 * 1024 * 1024;
const READ_BLOCK_BYTES = 256 * 1024;
const MAX_CACHED_READ_BLOCKS = 8;

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const ERRNO_EPERM = 63;
const ERRNO_ENOENT = 44;
const ERRNO_EINVAL = 28;
const ERRNO_EIO = 29;

const QPDF_PAGE_RANGE_PATTERN = /^(?:r?\d+|z)(?:-(?:r?\d+|z))?(?:,(?:r?\d+|z)(?:-(?:r?\d+|z))?)*(?::(?:even|odd))?$/u;
const WASM_TOO_LARGE_ERROR_PATTERN =
    /\b(?:cannot enlarge memory|out of memory|abort\(oom\)|std::bad_alloc|bad_alloc|std::length_error|length_error|memory growth|unable to grow)\b/iu;
const QPDF_STREAM_LIMIT_STDERR_PATTERN =
    /error decoding stream data for object \d+ \d+:\s*(?:std::)?(?:basic_string|bad_alloc|length_error|vector)\b/iu;
const QPDF_VIRTUAL_NULL_PATH = '/dev/null';

interface IQpdfFsNode {
    id: number;
    mode: number;
    node_ops: object;
    stream_ops: object;
}

interface IQpdfFileStream {
    path: string;
    position: number;
}

interface IQpdfEmscriptenModule {
    callMain(args: string[]): number;
    FS: {
        mkdirTree(path: string): void;
        createNode(parent: IQpdfFsNode | null, name: string, mode: number, rdev: number): IQpdfFsNode;
        mount(type: {mount(): IQpdfFsNode}, options: object, mountpoint: string): void;
        unmount(mountpoint: string): void;
        ErrnoError: new (errno: number) => Error;
    };
}

export type TQpdfEmscriptenFactory = (options: {
    instantiateWasm: (
        imports: WebAssembly.Imports,
        receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => object;
    thisProgram: string;
    stdout: (byte: number | null) => void;
    stderr: (byte: number | null) => void;
    printErr: (line: string) => void;
}) => Promise<IQpdfEmscriptenModule>;

export interface IVirtualQpdfInput {
    hostPath: string;
    virtualName: string;
    virtualPath: string;
}

export interface IRewrittenQpdfInvocation {
    virtualArgs: string[];
    inputs: IVirtualQpdfInput[];
    outputHostPath: string | null;
}

export interface IExecuteDesktopQpdfOptions {
    allowedExitCodes?: readonly number[];
    commandLabel?: string;
    cwd?: string;
    deferPublish?: boolean;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    rejectOnStdoutTruncation?: boolean;
    stagedOutputPath?: string;
}

export interface IResolveQpdfWasmPathOptions {
    currentDir?: string;
    isPackaged?: boolean;
    resourcesPath?: string;
}

export function isQpdfWasmPath(command: string) {
    return basename(command).toLowerCase() === QPDF_WASM_FILE_NAME;
}

export function resolveDesktopQpdfWasmPath(options: IResolveQpdfWasmPathOptions = {}): string | null {
    const currentDir = options.currentDir ?? __dirname;
    const isPackaged = options.isPackaged ?? currentDir.includes('app.asar');
    if (isPackaged) {
        const resourcesPath = options.resourcesPath ?? (process as NodeJS.Process & {resourcesPath?: string}).resourcesPath;
        const candidates = [
            ...(resourcesPath
                ? [
                      join(resourcesPath, 'app.asar.unpacked', 'nuxt-output', 'public', 'wasm', QPDF_WASM_FILE_NAME),
                      join(resourcesPath, 'app.asar', 'nuxt-output', 'public', 'wasm', QPDF_WASM_FILE_NAME),
                  ]
                : []),
            join(currentDir, '..', 'nuxt-output', 'public', 'wasm', QPDF_WASM_FILE_NAME),
        ];
        return candidates.find((candidate) => existsSync(candidate)) ?? null;
    }
    const candidates = [
        join(currentDir, '..', 'public', 'wasm', QPDF_WASM_FILE_NAME),
        join(currentDir, '..', '..', 'public', 'wasm', QPDF_WASM_FILE_NAME),
        join(currentDir, '..', '..', '..', 'public', 'wasm', QPDF_WASM_FILE_NAME),
        join(process.cwd(), 'public', 'wasm', QPDF_WASM_FILE_NAME),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function resolveDesktopQpdfMjsPath(wasmPath: string) {
    return join(dirname(wasmPath), QPDF_MJS_FILE_NAME);
}

const cachedModules = new Map<string, Promise<WebAssembly.Module>>();
const cachedFactories = new Map<string, Promise<TQpdfEmscriptenFactory>>();

export function loadQpdfWasmModule(wasmPath?: string): Promise<WebAssembly.Module> {
    const resolvedPath = wasmPath ?? resolveDesktopQpdfWasmPath();
    if (!resolvedPath) {
        return Promise.reject(new PdfPageOpsNativeError('native-failure', `${QPDF_WASM_FILE_NAME} was not found`));
    }
    const existing = cachedModules.get(resolvedPath);
    if (existing) {
        return existing;
    }
    const pending = readFile(resolvedPath)
        .then((bytes) => WebAssembly.compile(bytes))
        .catch((error: unknown) => {
            if (cachedModules.get(resolvedPath) === pending) {
                cachedModules.delete(resolvedPath);
            }
            throw error;
        });
    cachedModules.set(resolvedPath, pending);
    return pending;
}

export function loadQpdfModuleFactory(mjsPath: string): Promise<TQpdfEmscriptenFactory> {
    const existing = cachedFactories.get(mjsPath);
    if (existing) {
        return existing;
    }
    const pending = (import(pathToFileURL(mjsPath).href) as Promise<{default?: unknown}>)
        .then((imported) => {
            if (typeof imported.default !== 'function') {
                throw new PdfPageOpsNativeError('native-failure', `Invalid qpdf WASM factory module at ${mjsPath}`);
            }
            return imported.default as TQpdfEmscriptenFactory;
        })
        .catch((error: unknown) => {
            if (cachedFactories.get(mjsPath) === pending) {
                cachedFactories.delete(mjsPath);
            }
            throw error;
        });
    cachedFactories.set(mjsPath, pending);
    return pending;
}

function isNullDevicePath(filePath: string, platform: NodeJS.Platform = process.platform) {
    if (filePath === devNull || filePath === QPDF_VIRTUAL_NULL_PATH) {
        return true;
    }
    if (platform !== 'win32') {
        return false;
    }
    const lower = filePath.toLowerCase();
    return lower === 'nul' || lower === '\\\\.\\nul';
}

function isQpdfPageRangeToken(token: string) {
    return !isAbsolute(token) && QPDF_PAGE_RANGE_PATTERN.test(token);
}

/**
 * Translates a desktop qpdf CLI argument vector into Emscripten virtual paths
 * (`/in/<N>.pdf`, `/out/0.pdf`, `/dev/null`). Host filesystem paths never cross
 * into qpdf argv, avoiding Windows drive letters, UNC paths, Unicode, and CR/LF.
 */
export function rewriteQpdfArgsToVirtualPaths(
    args: readonly string[],
    cwd?: string,
    platform: NodeJS.Platform = process.platform,
): IRewrittenQpdfInvocation {
    const inputByHostPath = new Map<string, IVirtualQpdfInput>();
    const inputs: IVirtualQpdfInput[] = [];
    let outputHostPath: string | null = null;

    const resolveHostPath = (rawPath: string) => (cwd !== undefined && !isAbsolute(rawPath) ? resolve(cwd, rawPath) : rawPath);

    const registerInput = (rawHostPath: string, extension = '.pdf') => {
        const hostPath = resolveHostPath(rawHostPath);
        const existing = inputByHostPath.get(hostPath);
        if (existing) {
            return existing.virtualPath;
        }
        const virtualName = `${inputs.length}${extension}`;
        const entry: IVirtualQpdfInput = {
            hostPath,
            virtualName,
            virtualPath: `/in/${virtualName}`,
        };
        inputByHostPath.set(hostPath, entry);
        inputs.push(entry);
        return entry.virtualPath;
    };

    const registerOutput = (rawHostPath: string) => {
        if (isNullDevicePath(rawHostPath, platform)) {
            return QPDF_VIRTUAL_NULL_PATH;
        }
        const hostPath = resolveHostPath(rawHostPath);
        if (outputHostPath !== null && outputHostPath !== hostPath) {
            throw new PdfPageOpsNativeError('invalid-request', 'qpdf command specified multiple output paths');
        }
        outputHostPath = hostPath;
        return '/out/0.pdf';
    };

    const pagesFlagIndex = args.indexOf('--pages');
    if (pagesFlagIndex >= 0) {
        const beforePages = args.slice(0, pagesFlagIndex);
        const afterPages = args.slice(pagesFlagIndex + 1);
        const virtualArgs: string[] = [];
        let hasEmpty = false;
        let hasPrimaryInput = false;

        for (let index = 0; index < beforePages.length; index += 1) {
            const token = beforePages[index]!;
            if (token === '--encrypt') {
                const closeIndex = beforePages.indexOf('--', index + 1);
                if (closeIndex < 0) {
                    throw new PdfPageOpsNativeError('invalid-request', 'qpdf --encrypt invocation is missing terminating --');
                }
                virtualArgs.push(...beforePages.slice(index, closeIndex + 1));
                index = closeIndex;
            } else if (token === '--empty') {
                hasEmpty = true;
                virtualArgs.push(token);
            } else if (token.startsWith('--update-from-json=')) {
                const jsonHostPath = token.slice('--update-from-json='.length);
                virtualArgs.push(`--update-from-json=${registerInput(jsonHostPath, '.json')}`);
            } else if (token.startsWith('-')) {
                virtualArgs.push(token);
            } else {
                if (hasEmpty || hasPrimaryInput) {
                    throw new PdfPageOpsNativeError('invalid-request', 'Unexpected primary input before --pages');
                }
                hasPrimaryInput = true;
                virtualArgs.push(registerInput(token));
            }
        }

        virtualArgs.push('--pages');
        const endPagesIndex = afterPages.indexOf('--');
        if (endPagesIndex < 0) {
            throw new PdfPageOpsNativeError('invalid-request', 'qpdf --pages invocation is missing terminating --');
        }

        let lastWasSource = false;
        for (const token of afterPages.slice(0, endPagesIndex)) {
            if (token === '.') {
                virtualArgs.push('.');
                lastWasSource = true;
            } else if (token.startsWith('--')) {
                virtualArgs.push(token);
            } else if (lastWasSource && isQpdfPageRangeToken(token)) {
                virtualArgs.push(token);
                lastWasSource = false;
            } else {
                virtualArgs.push(registerInput(token));
                lastWasSource = true;
            }
        }

        virtualArgs.push('--');
        const trailingPositionals: string[] = [];
        const trailingTokens = afterPages.slice(endPagesIndex + 1);
        let afterTrailingDoubleDash = false;
        for (let index = 0; index < trailingTokens.length; index += 1) {
            const token = trailingTokens[index]!;
            if (!afterTrailingDoubleDash && token === '--encrypt') {
                const closeIndex = trailingTokens.indexOf('--', index + 1);
                if (closeIndex < 0) {
                    throw new PdfPageOpsNativeError('invalid-request', 'qpdf --encrypt invocation is missing terminating --');
                }
                virtualArgs.push(...trailingTokens.slice(index, closeIndex + 1));
                index = closeIndex;
            } else if (!afterTrailingDoubleDash && token === '--') {
                afterTrailingDoubleDash = true;
            } else if (!afterTrailingDoubleDash && token.startsWith('--update-from-json=')) {
                const jsonHostPath = token.slice('--update-from-json='.length);
                virtualArgs.push(`--update-from-json=${registerInput(jsonHostPath, '.json')}`);
            } else if (!afterTrailingDoubleDash && token.startsWith('-')) {
                virtualArgs.push(token);
            } else {
                trailingPositionals.push(token);
            }
        }
        if (trailingPositionals.length !== 1) {
            throw new PdfPageOpsNativeError(
                'invalid-request',
                `qpdf --pages expected one output path after --, received ${trailingPositionals.length}`,
            );
        }
        virtualArgs.push(registerOutput(trailingPositionals[0]!));
        return {
            virtualArgs,
            inputs,
            outputHostPath,
        };
    }

    const flagTokens: string[] = [];
    const positionals: string[] = [];
    let hasEmpty = false;
    let afterDoubleDash = false;

    for (let index = 0; index < args.length; index += 1) {
        const token = args[index]!;
        if (!afterDoubleDash && token === '--encrypt') {
            const closeIndex = args.indexOf('--', index + 1);
            if (closeIndex < 0) {
                throw new PdfPageOpsNativeError('invalid-request', 'qpdf --encrypt invocation is missing terminating --');
            }
            flagTokens.push(...args.slice(index, closeIndex + 1));
            index = closeIndex;
            continue;
        }
        if (!afterDoubleDash && token === '--') {
            afterDoubleDash = true;
            continue;
        }
        if (!afterDoubleDash && token.startsWith('-')) {
            if (token === '--empty') {
                hasEmpty = true;
            }
            if (token.startsWith('--update-from-json=')) {
                const jsonHostPath = token.slice('--update-from-json='.length);
                flagTokens.push(`--update-from-json=${registerInput(jsonHostPath, '.json')}`);
            } else {
                flagTokens.push(token);
            }
        } else {
            positionals.push(token);
        }
    }

    if (positionals.length > 2) {
        throw new PdfPageOpsNativeError('invalid-request', `qpdf expected at most two positional paths, received ${positionals.length}`);
    }

    const virtualPositionals: string[] = [];
    if (positionals.length === 1) {
        virtualPositionals.push(hasEmpty ? registerOutput(positionals[0]!) : registerInput(positionals[0]!));
    } else if (positionals.length === 2) {
        virtualPositionals.push(registerInput(positionals[0]!), registerOutput(positionals[1]!));
    }

    return {
        virtualArgs: [...flagTokens, ...virtualPositionals],
        inputs,
        outputHostPath,
    };
}

export function inspectDesktopQpdfWriteTarget(args: readonly string[], cwd?: string): {outputPath: string} | null {
    try {
        const rewritten = rewriteQpdfArgsToVirtualPaths(args, cwd);
        return rewritten.outputHostPath === null ? null : {outputPath: rewritten.outputHostPath};
    } catch {
        return null;
    }
}

function toSafePosition(value: number | bigint) {
    return typeof value === 'bigint' ? Number(value) : value;
}

const MAX_OPEN_INPUT_FDS = 64;

interface IOpenedHostInput {
    hostPath: string;
    fd: number | null;
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    virtualName: string;
    blocks: Map<number, Buffer>;
}

function mountHostInputs(fs: IQpdfEmscriptenModule['FS'], inputs: readonly IVirtualQpdfInput[]) {
    const opened: IOpenedHostInput[] = [];
    const liveFdOrder = new Set<IOpenedHostInput>();

    const closeEntryFd = (entry: IOpenedHostInput) => {
        if (entry.fd === null) {
            return;
        }
        const fd = entry.fd;
        entry.fd = null;
        liveFdOrder.delete(entry);
        try {
            closeSync(fd);
        } catch {
            // Best-effort fd cleanup.
        }
    };

    const ensureEntryFd = (entry: IOpenedHostInput): number => {
        if (entry.fd !== null) {
            liveFdOrder.delete(entry);
            liveFdOrder.add(entry);
            return entry.fd;
        }
        while (liveFdOrder.size >= MAX_OPEN_INPUT_FDS) {
            const oldest = liveFdOrder.values().next().value;
            if (!oldest) {
                break;
            }
            closeEntryFd(oldest);
        }
        const fd = openSync(entry.hostPath, 'r');
        entry.fd = fd;
        liveFdOrder.add(entry);
        return fd;
    };

    const createInputReadBlock = (entry: IOpenedHostInput, blockIndex: number) => {
        let block = entry.blocks.get(blockIndex);
        if (block !== undefined) {
            entry.blocks.delete(blockIndex);
            entry.blocks.set(blockIndex, block);
            return block;
        }
        const fd = ensureEntryFd(entry);
        const start = blockIndex * READ_BLOCK_BYTES;
        const toRead = Math.min(READ_BLOCK_BYTES, Math.max(0, entry.size - start));
        block = Buffer.allocUnsafe(toRead);
        let offset = 0;
        while (offset < toRead) {
            const read = readSync(fd, block, offset, toRead - offset, start + offset);
            if (read <= 0) {
                block = block.subarray(0, offset);
                break;
            }
            offset += read;
        }
        if (entry.blocks.size >= MAX_CACHED_READ_BLOCKS) {
            const oldest = entry.blocks.keys().next().value;
            if (oldest !== undefined) {
                entry.blocks.delete(oldest);
            }
        }
        entry.blocks.set(blockIndex, block);
        return block;
    };

    for (const input of inputs) {
        const st = statSync(input.hostPath);
        if (!st.isFile()) {
            throw new PdfPageOpsNativeError('io', `qpdf input is not a regular file: ${input.hostPath}`);
        }
        opened.push({
            hostPath: input.hostPath,
            fd: null,
            size: st.size,
            mtimeMs: st.mtimeMs,
            dev: st.dev,
            ino: st.ino,
            virtualName: input.virtualName,
            blocks: new Map(),
        });
    }

    const refuse = (errno: number) => () => {
        throw new fs.ErrnoError(errno);
    };
    const nodes = new Map<string, IQpdfFsNode>();
    const entryByNode = new WeakMap<IQpdfFsNode, IOpenedHostInput>();

    const nodeOps = {
        getattr(node: IQpdfFsNode) {
            const entry = entryByNode.get(node);
            const size = entry ? entry.size : 4096;
            const time = entry ? entry.mtimeMs : 0;
            const date = new Date(time);
            return {
                dev: 1,
                ino: node.id,
                mode: node.mode,
                nlink: 1,
                uid: 0,
                gid: 0,
                rdev: 0,
                size,
                atime: date,
                mtime: date,
                ctime: date,
                atimeMs: time,
                mtimeMs: time,
                ctimeMs: time,
                blksize: 4096,
                blocks: Math.ceil(size / 4096),
            };
        },
        setattr: refuse(ERRNO_EPERM),
        lookup(_parent: IQpdfFsNode, name: string) {
            const node = nodes.get(name);
            if (!node) {
                throw new fs.ErrnoError(ERRNO_ENOENT);
            }
            return node;
        },
        mknod: refuse(ERRNO_EPERM),
        rename: refuse(ERRNO_EPERM),
        unlink: refuse(ERRNO_EPERM),
        rmdir: refuse(ERRNO_EPERM),
        symlink: refuse(ERRNO_EPERM),
        readdir: () => ['.', '..', ...nodes.keys()],
    };

    const createStreamOps = (entry: IOpenedHostInput) => ({
        read(_stream: IQpdfFileStream, buffer: Uint8Array, offset: number, length: number, rawPosition: number | bigint) {
            const position = toSafePosition(rawPosition);
            if (position < 0) {
                throw new fs.ErrnoError(ERRNO_EINVAL);
            }
            if (position >= entry.size || length <= 0) {
                return 0;
            }
            const remaining = Math.min(length, entry.size - position);
            if (remaining >= READ_BLOCK_BYTES) {
                try {
                    const fd = ensureEntryFd(entry);
                    return readSync(fd, buffer, offset, remaining, position);
                } catch {
                    throw new fs.ErrnoError(ERRNO_EIO);
                }
            }
            let done = 0;
            while (done < remaining) {
                const at = position + done;
                const blockIndex = Math.floor(at / READ_BLOCK_BYTES);
                const block = createInputReadBlock(entry, blockIndex);
                const from = at - blockIndex * READ_BLOCK_BYTES;
                const count = Math.min(remaining - done, block.byteLength - from);
                if (count <= 0) {
                    break;
                }
                buffer.set(block.subarray(from, from + count), offset + done);
                done += count;
            }
            return done;
        },
        write: refuse(ERRNO_EPERM),
        llseek(stream: IQpdfFileStream, rawOffset: number | bigint, whence: number) {
            const offset = toSafePosition(rawOffset);
            const base = whence === 1 ? stream.position : whence === 2 ? entry.size : 0;
            const nextPosition = base + offset;
            if (nextPosition < 0) {
                throw new fs.ErrnoError(ERRNO_EINVAL);
            }
            return nextPosition;
        },
    });

    if (opened.length > 0) {
        try {
            fs.mkdirTree('/in');
            fs.mount(
                {
                    mount() {
                        const root = Object.assign(fs.createNode(null, '/', S_IFDIR | 0o555, 0), {
                            node_ops: nodeOps,
                            stream_ops: {},
                        });
                        for (const entry of opened) {
                            const fileNode = Object.assign(fs.createNode(root, entry.virtualName, S_IFREG | 0o444, 0), {
                                node_ops: nodeOps,
                                stream_ops: createStreamOps(entry),
                            });
                            entryByNode.set(fileNode, entry);
                            nodes.set(entry.virtualName, fileNode);
                        }
                        return root;
                    },
                },
                {},
                '/in',
            );
        } catch (error) {
            for (const entry of opened) {
                entry.blocks.clear();
                closeEntryFd(entry);
            }
            throw error;
        }
    }

    return {
        entries: opened,
        close() {
            if (opened.length > 0) {
                try {
                    fs.unmount('/in');
                } catch {
                    // Best-effort unmount before instance discard.
                }
            }
            for (const entry of opened) {
                entry.blocks.clear();
                closeEntryFd(entry);
            }
        },
    };
}

function mountHostOutput(fs: IQpdfEmscriptenModule['FS'], stagedOutputPath: string) {
    const fd = openSync(stagedOutputPath, 'w+');
    let size = 0;
    let closed = false;
    const nodes = new Map<string, IQpdfFsNode>();
    const refuse = (errno: number) => () => {
        throw new fs.ErrnoError(errno);
    };

    const streamOps = {
        read(_stream: IQpdfFileStream, buffer: Uint8Array, offset: number, length: number, rawPosition: number | bigint) {
            const position = toSafePosition(rawPosition);
            if (position < 0) {
                throw new fs.ErrnoError(ERRNO_EINVAL);
            }
            if (position >= size || length <= 0) {
                return 0;
            }
            try {
                return readSync(fd, buffer, offset, Math.min(length, size - position), position);
            } catch {
                throw new fs.ErrnoError(ERRNO_EIO);
            }
        },
        write(_stream: IQpdfFileStream, buffer: Uint8Array, offset: number, length: number, rawPosition: number | bigint) {
            const position = toSafePosition(rawPosition);
            if (position < 0) {
                throw new fs.ErrnoError(ERRNO_EINVAL);
            }
            if (length <= 0) {
                return 0;
            }
            try {
                const written = writeSync(fd, buffer, offset, length, position);
                if (position + written > size) {
                    size = position + written;
                }
                return written;
            } catch {
                throw new fs.ErrnoError(ERRNO_EIO);
            }
        },
        llseek(stream: IQpdfFileStream, rawOffset: number | bigint, whence: number) {
            const offset = toSafePosition(rawOffset);
            const base = whence === 1 ? stream.position : whence === 2 ? size : 0;
            const nextPosition = base + offset;
            if (nextPosition < 0) {
                throw new fs.ErrnoError(ERRNO_EINVAL);
            }
            return nextPosition;
        },
    };

    const nodeOps = {
        getattr(node: IQpdfFsNode) {
            const nodeSize = (node.mode & S_IFREG) !== 0 ? size : 4096;
            const now = new Date();
            return {
                dev: 2,
                ino: node.id,
                mode: node.mode,
                nlink: 1,
                uid: 0,
                gid: 0,
                rdev: 0,
                size: nodeSize,
                atime: now,
                mtime: now,
                ctime: now,
                atimeMs: now.getTime(),
                mtimeMs: now.getTime(),
                ctimeMs: now.getTime(),
                blksize: 4096,
                blocks: Math.ceil(nodeSize / 4096),
            };
        },
        setattr(_node: IQpdfFsNode, attr: {size?: number}) {
            if (typeof attr.size === 'number') {
                if (attr.size < 0) {
                    throw new fs.ErrnoError(ERRNO_EINVAL);
                }
                try {
                    ftruncateSync(fd, attr.size);
                    size = attr.size;
                } catch {
                    throw new fs.ErrnoError(ERRNO_EIO);
                }
            }
        },
        lookup(_parent: IQpdfFsNode, name: string) {
            const node = nodes.get(name);
            if (!node) {
                throw new fs.ErrnoError(ERRNO_ENOENT);
            }
            return node;
        },
        mknod(parent: IQpdfFsNode, name: string, mode: number) {
            if (name !== '0.pdf') {
                throw new fs.ErrnoError(ERRNO_EPERM);
            }
            let node = nodes.get(name);
            if (!node) {
                node = Object.assign(fs.createNode(parent, name, mode, 0), {
                    node_ops: nodeOps,
                    stream_ops: streamOps,
                });
                nodes.set(name, node);
            }
            return node;
        },
        unlink(_parent: IQpdfFsNode, name: string) {
            if (!nodes.delete(name)) {
                throw new fs.ErrnoError(ERRNO_ENOENT);
            }
            try {
                ftruncateSync(fd, 0);
                size = 0;
            } catch {
                // Best-effort reset.
            }
        },
        rename: refuse(ERRNO_EPERM),
        rmdir: refuse(ERRNO_EPERM),
        symlink: refuse(ERRNO_EPERM),
        readdir: () => ['.', '..', ...nodes.keys()],
    };

    try {
        fs.mkdirTree('/out');
        fs.mount(
            {
                mount() {
                    return Object.assign(fs.createNode(null, '/', S_IFDIR | 0o755, 0), {
                        node_ops: nodeOps,
                        stream_ops: {},
                    });
                },
            },
            {},
            '/out',
        );
    } catch (error) {
        closed = true;
        try {
            closeSync(fd);
        } catch {
            // Best-effort fd cleanup on mount failure.
        }
        throw error;
    }

    return {
        getSize: () => size,
        syncAndClose() {
            if (closed) {
                return;
            }
            closed = true;
            try {
                fs.unmount('/out');
            } catch {
                // Best-effort unmount.
            }
            try {
                fsyncSync(fd);
            } finally {
                closeSync(fd);
            }
        },
        closeQuietly() {
            if (closed) {
                return;
            }
            closed = true;
            try {
                fs.unmount('/out');
            } catch {
                // Best-effort unmount.
            }
            try {
                closeSync(fd);
            } catch {
                // Best-effort close.
            }
        },
    };
}

const BYTE_CAPTURE_CHUNK_BYTES = 64 * 1024;
const STDERR_CLASSIFY_LINE_MAX_BYTES = 4096;

class BoundedByteCapture {
    private readonly chunks: Buffer[] = [];
    private current: Buffer | null = null;
    private currentOffset = 0;
    private bytes = 0;
    private truncated = false;

    constructor(private readonly maxBytes: number) {}

    pushByte(rawByte: number | null) {
        if (rawByte === null || this.truncated) {
            return;
        }
        if (this.bytes >= this.maxBytes) {
            this.truncated = true;
            return;
        }
        if (this.current === null || this.currentOffset >= this.current.byteLength) {
            const nextChunkSize = Math.min(BYTE_CAPTURE_CHUNK_BYTES, this.maxBytes - this.bytes);
            this.current = Buffer.allocUnsafe(nextChunkSize);
            this.chunks.push(this.current);
            this.currentOffset = 0;
        }
        this.current[this.currentOffset] = rawByte & 0xff;
        this.currentOffset += 1;
        this.bytes += 1;
    }

    isTruncated() {
        return this.truncated;
    }

    toString() {
        if (this.bytes === 0) {
            return '';
        }
        const slices = this.chunks.map((chunk, index) =>
            index === this.chunks.length - 1 ? chunk.subarray(0, this.currentOffset) : chunk,
        );
        return Buffer.concat(slices, this.bytes).toString('utf8');
    }
}

class BoundedStderrCapture {
    private readonly capture: BoundedByteCapture;
    private readonly lineBuffer = Buffer.allocUnsafe(STDERR_CLASSIFY_LINE_MAX_BYTES);
    private lineLength = 0;
    private tooLargeDetail: string | null = null;

    constructor(maxBytes: number) {
        this.capture = new BoundedByteCapture(maxBytes);
    }

    private inspectLine(line: string) {
        if (this.tooLargeDetail === null && (QPDF_STREAM_LIMIT_STDERR_PATTERN.test(line) || WASM_TOO_LARGE_ERROR_PATTERN.test(line))) {
            this.tooLargeDetail = line.trim();
        }
    }

    pushByte(rawByte: number | null) {
        if (rawByte === null) {
            return;
        }
        const byte = rawByte & 0xff;
        // Always classify every stderr byte before applying the byte capture cap
        // so preceding warnings or >4 KiB single lines cannot hide a stream-limit/OOM failure.
        if (byte === 0x0a) {
            this.flushPendingLine();
        } else {
            if (this.lineLength === this.lineBuffer.byteLength) {
                const chunk = this.lineBuffer.toString('utf8');
                this.inspectLine(chunk);
                const overlap = Math.min(512, this.lineBuffer.byteLength);
                this.lineBuffer.copy(this.lineBuffer, 0, this.lineBuffer.byteLength - overlap);
                this.lineLength = overlap;
            }
            this.lineBuffer[this.lineLength] = byte;
            this.lineLength += 1;
        }
        this.capture.pushByte(byte);
    }

    recordLine(line: string) {
        this.inspectLine(line);
        const bytes = Buffer.from(`${line}\n`, 'utf8');
        for (let index = 0; index < bytes.byteLength; index += 1) {
            this.capture.pushByte(bytes[index]!);
        }
    }

    flushPendingLine() {
        if (this.lineLength === 0) {
            return;
        }
        const line = this.lineBuffer.subarray(0, this.lineLength).toString('utf8');
        this.lineLength = 0;
        this.inspectLine(line);
    }

    getTooLargeDetail() {
        this.flushPendingLine();
        return this.tooLargeDetail;
    }

    toString() {
        this.flushPendingLine();
        return this.capture.toString();
    }
}

function isWasmTooLargeFailure(error: unknown, stderr: string) {
    if (QPDF_STREAM_LIMIT_STDERR_PATTERN.test(stderr) || WASM_TOO_LARGE_ERROR_PATTERN.test(stderr)) {
        return true;
    }
    if (error === undefined || error === null) {
        return false;
    }
    if (error instanceof RangeError) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (WASM_TOO_LARGE_ERROR_PATTERN.test(message)) {
        return true;
    }
    if (error instanceof WebAssembly.RuntimeError && /memory|oob|out of bounds|unreachable/iu.test(message)) {
        return true;
    }
    return false;
}

function extractFirstStderrSummary(stderr: string) {
    const lines = stderr
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.slice(0, 3).join(' | ');
}

/**
 * Executes one desktop qpdf CLI command inside a fresh Emscripten instance
 * created from the pre-compiled `evb-qpdf.wasm` module.
 *
 * Host files are exposed strictly under virtual paths (`/in/<N>.pdf`, `/out/0.pdf`,
 * `/dev/null`). Outputs are staged into a sibling temporary file and atomically
 * renamed into place only on an allowed exit code with no wasm32 memory/stream
 * truncation error, guaranteeing that a failed or >2 GiB single-stream run never
 * writes truncated output.
 */
export async function executeDesktopQpdfCommand(
    wasmModule: WebAssembly.Module,
    factory: TQpdfEmscriptenFactory,
    args: readonly string[],
    options: IExecuteDesktopQpdfOptions = {},
): Promise<IPageOpsProcessResult> {
    const label = options.commandLabel ?? 'qpdf';
    const allowedExitCodes = options.allowedExitCodes ?? [0];
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

    const rewritten = rewriteQpdfArgsToVirtualPaths(args, options.cwd);
    const stdoutCapture = new BoundedByteCapture(maxStdoutBytes);
    const stderrCapture = new BoundedStderrCapture(maxStderrBytes);

    let instance: IQpdfEmscriptenModule;
    try {
        let rejectInstantiate!: (reason: unknown) => void;
        const instantiateFailed = new Promise<never>((_resolve, reject) => {
            rejectInstantiate = reject;
        });
        instance = await Promise.race([
            factory({
                instantiateWasm(imports, receive) {
                    WebAssembly.instantiate(wasmModule, imports).then(
                        (created) => receive(created, wasmModule),
                        (error) => rejectInstantiate(error),
                    );
                    return {};
                },
                thisProgram: 'qpdf',
                stdout(byte) {
                    stdoutCapture.pushByte(byte);
                },
                stderr(byte) {
                    stderrCapture.pushByte(byte);
                },
                printErr(line) {
                    stderrCapture.recordLine(line);
                },
            }),
            instantiateFailed,
        ]);
    } catch (error) {
        const stderr = stderrCapture.toString();
        const tooLargeDetail = stderrCapture.getTooLargeDetail();
        if (tooLargeDetail !== null || isWasmTooLargeFailure(error, stderr)) {
            throw new PdfPageOpsNativeError(
                'too-large',
                `${label} exceeded WebAssembly memory limits: ${tooLargeDetail || (error instanceof Error ? error.message : String(error))}`,
            );
        }
        throw new PdfPageOpsNativeError(
            'native-failure',
            `${label} failed to initialize evb-qpdf.wasm: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    if (options.deferPublish && rewritten.outputHostPath !== null && !options.stagedOutputPath) {
        throw new PdfPageOpsNativeError('invalid-request', `${label} requires stagedOutputPath when deferPublish is enabled`);
    }

    const stagedOutputPath =
        rewritten.outputHostPath === null ? null : (options.stagedOutputPath ?? createTempSiblingPath(rewritten.outputHostPath));
    let outputCommitted = false;

    const inputMount = mountHostInputs(instance.FS, rewritten.inputs);
    let outputMount: ReturnType<typeof mountHostOutput> | null = null;
    try {
        if (rewritten.outputHostPath !== null) {
            const normalizedOutput = resolve(rewritten.outputHostPath);
            let outputStat: ReturnType<typeof statSync> | null = null;
            try {
                outputStat = statSync(rewritten.outputHostPath);
            } catch {
                outputStat = null;
            }
            for (const entry of inputMount.entries) {
                const samePath = resolve(entry.hostPath) === normalizedOutput;
                const sameInode =
                    outputStat !== null && outputStat.ino !== 0 && outputStat.dev === entry.dev && outputStat.ino === entry.ino;
                if (samePath || sameInode) {
                    throw new PdfPageOpsNativeError(
                        'invalid-request',
                        `${label} refuses to write output over an input file: ${rewritten.outputHostPath}`,
                    );
                }
            }
        }
        if (stagedOutputPath !== null) {
            outputMount = mountHostOutput(instance.FS, stagedOutputPath);
        }

        let exitCode: number;
        try {
            exitCode = instance.callMain(rewritten.virtualArgs);
        } catch (error) {
            const stderr = stderrCapture.toString();
            const tooLargeDetail = stderrCapture.getTooLargeDetail();
            if (tooLargeDetail !== null || isWasmTooLargeFailure(error, stderr)) {
                const detail =
                    tooLargeDetail || extractFirstStderrSummary(stderr) || (error instanceof Error ? error.message : String(error));
                throw new PdfPageOpsNativeError(
                    'too-large',
                    `${label} exceeded qpdf WebAssembly memory or single-stream limits: ${detail}`,
                );
            }
            throw new PdfPageOpsNativeError(
                'native-failure',
                `${label} aborted in evb-qpdf.wasm: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        const stdout = stdoutCapture.toString();
        const stderr = stderrCapture.toString();
        const tooLargeDetail = stderrCapture.getTooLargeDetail();

        // In wasm32, a single stream exceeding 2 GiB causes std::basic_string
        // length_error inside qpdf's stream copy/decode path; qpdf may still
        // exit 3 while skipping the stream and writing a truncated file. Fail
        // closed with a typed 'too-large' error and never publish staged output,
        // even if earlier warnings filled the stderr capture buffer.
        if (tooLargeDetail !== null || isWasmTooLargeFailure(null, stderr)) {
            const detail = tooLargeDetail || extractFirstStderrSummary(stderr);
            throw new PdfPageOpsNativeError('too-large', `${label} exceeded qpdf WebAssembly single-stream or memory limits: ${detail}`);
        }

        if (options.rejectOnStdoutTruncation && stdoutCapture.isTruncated()) {
            throw new PdfPageOpsNativeError('too-large', `${label} stdout exceeded ${maxStdoutBytes} bytes`);
        }

        if (!allowedExitCodes.includes(exitCode)) {
            const detail = extractFirstStderrSummary(stderr);
            const failure = new Error(
                detail ? `${label} exited with code ${exitCode}: ${detail}` : `${label} exited with code ${exitCode}`,
            ) as Error & {
                exitCode?: number;
                stdout?: string;
                stderr?: string;
            };
            failure.exitCode = exitCode;
            failure.stdout = stdout;
            failure.stderr = stderr;
            throw failure;
        }

        if (rewritten.outputHostPath !== null && stagedOutputPath !== null && outputMount !== null) {
            outputMount.syncAndClose();
            if (!options.deferPublish) {
                renameSync(stagedOutputPath, rewritten.outputHostPath);
            }
            outputCommitted = true;
        }

        return {
            stdout,
            stderr,
            exitCode,
        };
    } finally {
        outputMount?.closeQuietly();
        inputMount.close();
        if (stagedOutputPath !== null && !outputCommitted) {
            try {
                unlinkSync(stagedOutputPath);
            } catch {
                // Staging file may not exist or already been removed.
            }
        }
    }
}
