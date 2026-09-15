import path from 'node:path';
import type { IWindowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';

export const WINDOWS_TEST_WINAPP_ARCHIVE_RELATIVE_PATH = path.join(
    'winapp-0.6.0-arm64',
    'winappcli-arm64.zip',
);

export const WINDOWS_TEST_WINAPP_ARCHIVE_SHA256 = '423d24d8d361841f78643a05c1212125bd33d85d710619c7b9819f5754061056';

export function windowsTestWinappToolPaths(layout: IWindowsTestHostLayout) {
    const directory = path.join(layout.toolsCacheDir, 'winapp-0.6.0-arm64');
    return {
        archivePath: path.join(directory, 'winappcli-arm64.zip'),
        executablePath: path.join(directory, 'winapp.exe'),
        nativeLibraryPath: path.join(directory, 'libSkiaSharp.dll'),
    };
}
