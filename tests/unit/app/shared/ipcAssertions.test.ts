import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    MAX_IPC_PATH_LENGTH,
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    isLikelyAbsolutePath,
} from '@contracts/ipcAssertions';

describe('ipcAssertions', () => {
    it('trims and validates non-empty strings', () => {
        expect(assertNonEmptyString('  abc  ', 'field')).toBe('abc');
        expect(() => assertNonEmptyString('', 'field')).toThrowError('field must not be empty');
        expect(() => assertNonEmptyString('a\0b', 'field')).toThrowError('field must not contain NUL bytes');
    });

    it('enforces max length for strings', () => {
        const tooLong = 'a'.repeat(MAX_IPC_PATH_LENGTH + 1);
        expect(() => assertNonEmptyString(tooLong, 'field')).toThrowError(
            `field exceeds maximum length (${MAX_IPC_PATH_LENGTH})`,
        );
    });

    it('recognizes absolute path formats', () => {
        expect(isLikelyAbsolutePath('/tmp/file.pdf')).toBe(true);
        expect(isLikelyAbsolutePath('C:\\temp\\file.pdf')).toBe(true);
        expect(isLikelyAbsolutePath('\\\\server\\share\\file.pdf')).toBe(true);
        expect(isLikelyAbsolutePath('relative/file.pdf')).toBe(false);
    });

    it('asserts required and optional absolute paths', () => {
        expect(assertAbsolutePath('/tmp/file.pdf', 'path')).toBe('/tmp/file.pdf');
        expect(() => assertAbsolutePath(' /tmp/file.pdf ', 'path')).toThrowError('path must be an absolute path');
        expect(assertOptionalAbsolutePath('   ', 'path')).toBeUndefined();
        expect(assertOptionalAbsolutePath(undefined, 'path')).toBeUndefined();
        expect(assertOptionalAbsolutePath(' C:\\temp\\file.pdf ', 'path')).toBe('C:\\temp\\file.pdf');
        expect(() => assertAbsolutePath('relative/file.pdf', 'path')).toThrowError('path must be an absolute path');
    });
});
