import {
    describe,
    expect,
    it,
} from 'vitest';
import { describeProcessExitCode } from '@electron/utils/process-exit';

describe('describeProcessExitCode', () => {
    it('annotates known Windows NTSTATUS crash codes', () => {
        expect(describeProcessExitCode(3221225595, { platform: 'win32' }))
            .toContain('0xC000007B STATUS_INVALID_IMAGE_FORMAT');
    });

    it('handles signed Windows NTSTATUS values', () => {
        expect(describeProcessExitCode(-1073741701, { platform: 'win32' }))
            .toContain('0xC000007B STATUS_INVALID_IMAGE_FORMAT');
    });

    it('returns plain exit code for non-Windows platforms', () => {
        expect(describeProcessExitCode(3221225595, { platform: 'linux' })).toBe('3221225595');
    });
});
