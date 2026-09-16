import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    parseExecutableArgument,
    parseReceiptArgument,
} from '@scripts/release/verifyPackagedDiagnosticsSmoke';
import {waitForPackagedRendererPage} from '@scripts/release/waitForPackagedCdpEndpoint';

describe('packaged diagnostics smoke arguments', () => {
    it('reads only the value following the executable flag', () => {
        expect(parseExecutableArgument(['--allow-rejected'])).toBeNull();
        expect(parseExecutableArgument([
            '--executable',
            '/tmp/EVB Viewer',
        ])).toBe('/tmp/EVB Viewer');
        expect(parseExecutableArgument(['--executable'])).toBeNull();
    });

    it('reads an optional credential-free evidence receipt path', () => {
        expect(parseReceiptArgument([])).toBeNull();
        expect(parseReceiptArgument([
            '--receipt',
            '.devkit/receipt.json',
        ])).toBe('.devkit/receipt.json');
        expect(parseReceiptArgument(['--receipt'])).toBeNull();
    });
});

describe('packaged renderer startup', () => {
    it('waits when CDP is ready before the first renderer page exists', async () => {
        const rendererPage = {
            isClosed: () => false,
            url: () => 'evb-viewer://app/electron',
        };
        let attempts = 0;
        const browser = {async pages() {
            attempts += 1;
            return attempts === 1 ? [] : [rendererPage];
        }};

        await expect(waitForPackagedRendererPage(browser, 1_000, 'test app', 0))
            .resolves.toBe(rendererPage);
        expect(attempts).toBe(2);
    });
});
