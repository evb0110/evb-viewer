import {
    mkdir,
    mkdtemp,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    relative,
} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const logged = vi.hoisted(() => [] as string[]);

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: (message: string) => {
        logged.push(message);
    },
})}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: platform,
    });
}

async function importQuarantine() {
    return import('@electron/file-access/workingCopyQuarantine');
}

describe('working copy quarantine', () => {
    beforeEach(async () => {
        vi.resetModules();
        logged.length = 0;
        const { clearWorkingCopyQuarantinesForTests } = await importQuarantine();
        clearWorkingCopyQuarantinesForTests();
    });

    afterEach(() => {
        setPlatform(originalPlatform);
    });

    it('answers for a path spelled relative to the process directory', async () => {
        const {
            describeWorkingCopyQuarantine,
            isWorkingCopyQuarantined,
            quarantineWorkingCopy,
        } = await importQuarantine();
        const absolutePath = join(process.cwd(), 'pdf-work-alias', 'working.pdf');
        // The recording caller and the asking caller are different subsystems
        // holding different spellings of the same file. A quarantine that only
        // answered for the spelling that recorded it would let the close path
        // delete bytes a native reader may still hold.
        quarantineWorkingCopy(absolutePath, 'process tree was not proven dead');

        expect(isWorkingCopyQuarantined(relative(process.cwd(), absolutePath))).toBe(true);
        expect(describeWorkingCopyQuarantine(relative(process.cwd(), absolutePath)))
            .toBe('process tree was not proven dead');
    });

    it('normalizes a path that walks through its own parent', async () => {
        const {
            isWorkingCopyQuarantined,
            quarantineWorkingCopy,
        } = await importQuarantine();
        const absolutePath = join(process.cwd(), 'pdf-work-dotdot', 'working.pdf');
        quarantineWorkingCopy(
            join(process.cwd(), 'pdf-work-dotdot', 'nested', '..', 'working.pdf'),
            'process tree was not proven dead',
        );

        expect(isWorkingCopyQuarantined(absolutePath)).toBe(true);
    });

    it('answers for a spelling through a symlinked folder', async () => {
        const {
            isWorkingCopyQuarantined,
            quarantineWorkingCopy,
        } = await importQuarantine();
        const root = await mkdtemp(join(tmpdir(), 'evb-quarantine-alias-'));
        try {
            await mkdir(join(root, 'real'));
            await writeFile(join(root, 'real', 'working.pdf'), '%PDF');
            await symlink(join(root, 'real'), join(root, 'alias'), 'dir');
            quarantineWorkingCopy(join(root, 'alias', 'working.pdf'), 'process tree was not proven dead');

            expect(isWorkingCopyQuarantined(join(root, 'real', 'working.pdf'))).toBe(true);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('logs the path the caller supplied rather than the normalized key', async () => {
        const { quarantineWorkingCopy } = await importQuarantine();

        quarantineWorkingCopy('  ./pdf-work-logged/working.pdf  ', 'process tree was not proven dead');

        expect(logged).toEqual(['Quarantined working copy "./pdf-work-logged/working.pdf": process tree was not proven dead']);
    });

    it('keeps distinct reasons in order and records a repeated one once', async () => {
        const {
            describeWorkingCopyQuarantine,
            quarantineWorkingCopy,
        } = await importQuarantine();
        const absolutePath = join(process.cwd(), 'pdf-work-repeat', 'working.pdf');

        quarantineWorkingCopy(absolutePath, 'process tree was not proven dead');
        // The close path can reach the same working copy again -- a second close
        // attempt, or a second run that stopped the same way. The description
        // that reaches the retention log has to read as the distinct reasons the
        // bytes are held for, not as the number of times one of them recurred.
        quarantineWorkingCopy(absolutePath, 'process tree was not proven dead');
        quarantineWorkingCopy(absolutePath, 'the worker never acknowledged its cancel');

        expect(describeWorkingCopyQuarantine(absolutePath)).toBe(
            'process tree was not proven dead; the worker never acknowledged its cancel',
        );
        // Every recording is still an event worth a line: deduplicating the
        // description does not mean the second one went unreported.
        expect(logged).toHaveLength(3);
    });

    it('ignores a blank path', async () => {
        const {
            isWorkingCopyQuarantined,
            quarantineWorkingCopy,
        } = await importQuarantine();

        quarantineWorkingCopy('   ', 'process tree was not proven dead');

        expect(logged).toEqual([]);
        expect(isWorkingCopyQuarantined('   ')).toBe(false);
    });

    it('matches case-insensitively on Windows, where the two spellings are one file', async () => {
        setPlatform('win32');
        // Re-import under the override rather than reusing the instance the
        // `beforeEach` evaluated, so this stays a test of the Windows branch even
        // if the module ever samples the platform once at evaluation time.
        vi.resetModules();
        const {
            isWorkingCopyQuarantined,
            quarantineWorkingCopy,
        } = await importQuarantine();
        const workingPath = join(process.cwd(), 'PDF-Work-Case', 'Working.pdf');

        quarantineWorkingCopy(workingPath, 'process tree was not proven dead');

        expect(isWorkingCopyQuarantined(workingPath.toLowerCase())).toBe(true);
    });

    it('keeps case significant elsewhere, where they are two files', async () => {
        setPlatform('linux');
        vi.resetModules();
        const {
            isWorkingCopyQuarantined,
            quarantineWorkingCopy,
        } = await importQuarantine();
        const workingPath = join(process.cwd(), 'PDF-Work-Case', 'Working.pdf');

        quarantineWorkingCopy(workingPath, 'process tree was not proven dead');

        // Case-folding here would extend a quarantine to a genuinely different
        // file and strand its directory for the rest of the session.
        expect(isWorkingCopyQuarantined(workingPath.toLowerCase())).toBe(false);
        expect(isWorkingCopyQuarantined(workingPath)).toBe(true);
    });
});
