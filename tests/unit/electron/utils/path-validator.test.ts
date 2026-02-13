import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { sep } from 'path';

let tempDir: string;

vi.mock('electron', () => ({app: {getPath: (name: string) => {
    if (name === 'temp') {
        return tempDir;
    }
    throw new Error(`Unknown path name: ${name}`);
}}}));

const {
    isAllowedReadPath,
    isAllowedWritePath,
} = await import('@electron/utils/path-validator');

describe('isAllowedWritePath', () => {
    beforeEach(() => {
        tempDir = '/tmp/electron-test';
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('allows a file inside the temp directory', () => {
        expect(isAllowedWritePath('/tmp/electron-test/output.pdf')).toBe(true);
    });

    it('allows a nested file inside the temp directory', () => {
        expect(isAllowedWritePath('/tmp/electron-test/subdir/deep/output.pdf')).toBe(true);
    });

    it('rejects the temp directory itself', () => {
        expect(isAllowedWritePath('/tmp/electron-test')).toBe(false);
        expect(isAllowedWritePath('/tmp/electron-test/')).toBe(false);
    });

    it('rejects paths outside the temp directory', () => {
        expect(isAllowedWritePath('/etc/passwd')).toBe(false);
        expect(isAllowedWritePath('/usr/local/bin/app')).toBe(false);
    });

    it('rejects path traversal attempts', () => {
        expect(isAllowedWritePath('/tmp/electron-test/../../../etc/passwd')).toBe(false);
        expect(isAllowedWritePath('/tmp/electron-test/..')).toBe(false);
        expect(isAllowedWritePath('/tmp/electron-test/subdir/../../outside')).toBe(false);
    });

    it('rejects empty and whitespace-only strings', () => {
        expect(isAllowedWritePath('')).toBe(false);
        expect(isAllowedWritePath('   ')).toBe(false);
    });

    it('handles paths with trailing whitespace', () => {
        expect(isAllowedWritePath('/tmp/electron-test/file.pdf   ')).toBe(true);
    });

    it('rejects paths that start with .. relative to temp', () => {
        expect(isAllowedWritePath(`/tmp/electron-test/..${sep}outside`)).toBe(false);
    });
});

describe('isAllowedReadPath', () => {
    beforeEach(() => {
        tempDir = '/tmp/electron-test';
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('allows a file inside the temp directory', () => {
        expect(isAllowedReadPath('/tmp/electron-test/document.pdf')).toBe(true);
    });

    it('allows nested files', () => {
        expect(isAllowedReadPath('/tmp/electron-test/a/b/c.txt')).toBe(true);
    });

    it('rejects the temp directory itself', () => {
        expect(isAllowedReadPath('/tmp/electron-test')).toBe(false);
    });

    it('rejects path traversal', () => {
        expect(isAllowedReadPath('/tmp/electron-test/../../etc/shadow')).toBe(false);
    });

    it('rejects empty input', () => {
        expect(isAllowedReadPath('')).toBe(false);
    });

    it('rejects paths outside temp directory', () => {
        expect(isAllowedReadPath('/home/user/secrets.txt')).toBe(false);
    });
});
