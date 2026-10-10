import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const verifierPath = join(process.cwd(), 'scripts/diagnostics/verify-generated-pdf.py');

function classify(messages: string[], jpxPages: number[], requestedPages: number[]) {
    const source = `
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location("verify_generated_pdf", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
messages = json.loads(sys.argv[2])
expected, unexpected = module.classify_decoder_failures(
    {"consoleMessages": [{"message": message} for message in messages]},
    set(json.loads(sys.argv[3])),
    set(json.loads(sys.argv[4])),
)
print(json.dumps({"expected": expected, "unexpected": unexpected}))
`;
    const result = spawnSync('python3', [
        '-c',
        source,
        verifierPath,
        JSON.stringify(messages),
        JSON.stringify(jpxPages),
        JSON.stringify(requestedPages),
    ], {encoding: 'utf8'});
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
        expected: string[];
        unexpected: string[]
    };
}

describe('generated PDF compatibility classifier', () => {
    // python3 drives the POSIX verifier with its extensionless Electron/Poppler launchers.
    it.skipIf(process.platform === 'win32')('attributes bootstrap and dependent warnings to the adjacent JPX page', () => {
        const result = classify([
            'Warning: JpxImage#getJsModule failed to initialize',
            'Warning: Unable to decode image "img_p0_1": "JpxError: OpenJPEG failed to initialize".',
            'Warning: Dependent image isn\'t ready yet',
        ], [1], [
            1,
            2,
        ]);

        expect(result.unexpected).toEqual([]);
        expect(result.expected).toHaveLength(3);
    });

    // python3 drives the POSIX verifier with its extensionless Electron/Poppler launchers.
    it.skipIf(process.platform === 'win32')('does not excuse an unattributed decoder failure in a mixed request', () => {
        const result = classify(['Warning: JpxImage#getJsModule failed to initialize'], [1], [
            1,
            2,
        ]);

        expect(result.expected).toEqual([]);
        expect(result.unexpected).toHaveLength(1);
    });

    // python3 drives the POSIX verifier with its extensionless Electron/Poppler launchers.
    it.skipIf(process.platform === 'win32')('accepts an unattributed JPX bootstrap failure when every page requires JPX', () => {
        const result = classify(['Warning: JpxImage#getJsModule failed to initialize'], [
            1,
            2,
        ], [
            1,
            2,
        ]);

        expect(result.expected).toHaveLength(1);
        expect(result.unexpected).toEqual([]);
    });
});
