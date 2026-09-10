import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface ITestOwner {
    id: number;
    destroyed: boolean;
    once: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
}

function createOwner(id: number): ITestOwner {
    const owner: ITestOwner = {
        id,
        destroyed: false,
        once: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        isDestroyed: () => owner.destroyed,
    };

    return owner;
}

function triggerDestroyed(owner: ITestOwner) {
    const destroyedHandler = owner.once.mock.calls
        .find(call => call[0] === 'destroyed')?.[1] as (() => void) | undefined;
    destroyedHandler?.();
}

function triggerRenderProcessGone(owner: ITestOwner) {
    const handler = owner.once.mock.calls
        .find(call => call[0] === 'render-process-gone')?.[1] as (() => void) | undefined;
    handler?.();
}

function triggerMainFrameNavigation(owner: ITestOwner) {
    const handler = owner.on.mock.calls
        .find(call => call[0] === 'did-start-navigation')?.[1] as ((
            event: unknown,
            url: string,
            isInPlace: boolean,
            isMainFrame: boolean,
        ) => void) | undefined;
    handler?.({}, 'app://reload', false, true);
}

describe('open path capabilities', () => {
    let tempRoot = '';
    const previousTtl = process.env.EVB_OPEN_PATH_CAPABILITY_TTL_MS;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-open-path-capability-test-'));
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
        if (previousTtl === undefined) {
            delete process.env.EVB_OPEN_PATH_CAPABILITY_TTL_MS;
        } else {
            process.env.EVB_OPEN_PATH_CAPABILITY_TTL_MS = previousTtl;
        }
        vi.useRealTimers();
    });

    it('expires grants after the configured lifetime', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        process.env.EVB_OPEN_PATH_CAPABILITY_TTL_MS = '60000';

        const filePath = join(tempRoot, 'opened.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const {
            allowOpenPath,
            requireOpenPath,
        } = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(filePath)).not.toBeNull();
        expect(() => requireOpenPath(filePath)).not.toThrow();

        vi.setSystemTime(61_001);

        expect(() => requireOpenPath(filePath)).toThrow('Path not allowed');
    });

    it('authorizes an exact path whose filename ends in whitespace', async () => {
        const filePath = join(tempRoot, 'exact-percent-%25.pdf ');
        writeFileSync(filePath, new Uint8Array([1]));

        const {
            allowOpenPath,
            requireOpenPath,
        } = await import('@electron/file-access/openPathCapabilities');
        const canonicalFilePath = realpathSync.native(filePath);

        expect(allowOpenPath(filePath)).toBe(canonicalFilePath);
        expect(requireOpenPath(filePath)).toBe(canonicalFilePath);
    });

    it('clears grants when the owning webContents is destroyed', async () => {
        const filePath = join(tempRoot, 'owned.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const owner = createOwner(42);
        const {
            allowOpenPath,
            requireOpenPath,
        } = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(filePath, owner as never)).not.toBeNull();
        expect(() => requireOpenPath(filePath, owner as never)).not.toThrow();

        triggerDestroyed(owner);

        expect(() => requireOpenPath(filePath, owner as never)).toThrow('Path not allowed');
    });

    it('clears grants when the owning renderer process crashes', async () => {
        const filePath = join(tempRoot, 'crashed.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const owner = createOwner(43);
        const {
            allowOpenPath,
            requireOpenPath,
        } = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(filePath, owner as never)).not.toBeNull();
        triggerRenderProcessGone(owner);

        expect(() => requireOpenPath(filePath, owner as never)).toThrow('Path not allowed');
    });

    it('clears grants when the owning renderer reloads', async () => {
        const filePath = join(tempRoot, 'reloaded.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const owner = createOwner(44);
        const {
            allowOpenPath,
            requireOpenPath,
        } = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(filePath, owner as never)).not.toBeNull();
        triggerMainFrameNavigation(owner);

        expect(() => requireOpenPath(filePath, owner as never)).toThrow('Path not allowed');
    });

    it('keeps reveal-only grants separate from full open grants', async () => {
        const filePath = join(tempRoot, 'revealed-only.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const owner = createOwner(45);
        const {
            allowRevealPath,
            requireOpenPath,
            requireRevealPath,
        } = await import('@electron/file-access/openPathCapabilities');

        expect(allowRevealPath(filePath, owner as never)).not.toBeNull();

        expect(() => requireRevealPath(filePath, owner as never)).not.toThrow();
        expect(() => requireOpenPath(filePath, owner as never)).toThrow('Path not allowed');

        triggerDestroyed(owner);

        expect(() => requireRevealPath(filePath, owner as never)).toThrow('Path not allowed');
    });

    it('allows full open grants to satisfy reveal checks', async () => {
        const filePath = join(tempRoot, 'opened-can-reveal.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const owner = createOwner(46);
        const {
            allowOpenPath,
            requireRevealPath,
        } = await import('@electron/file-access/openPathCapabilities');

        expect(allowOpenPath(filePath, owner as never)).not.toBeNull();

        expect(() => requireRevealPath(filePath, owner as never)).not.toThrow();
    });

    it('registers one cleanup listener per owner', async () => {
        const firstPath = join(tempRoot, 'first.pdf');
        const secondPath = join(tempRoot, 'second.pdf');
        writeFileSync(firstPath, new Uint8Array([1]));
        writeFileSync(secondPath, new Uint8Array([2]));

        const owner = createOwner(7);
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');

        allowOpenPath(firstPath, owner as never);
        allowOpenPath(secondPath, owner as never);

        expect(owner.once).toHaveBeenCalledTimes(2);
        expect(owner.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(owner.once).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
        expect(owner.on).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));
    });
});
