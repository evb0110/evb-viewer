import releaseTargetManifest from './generated-release-targets.cjs';

/** @typedef {{allowedExitCodes: Set<number>, expectedOutputTokens: string[], requiredOutputPattern?: RegExp}} IToolSmokePolicy */

export const RELEASE_TARGET_MANIFEST = releaseTargetManifest.manifest;

// One exit-code and output-signature policy for every host that can execute the
// packaged tools it verifies: macOS arm64, linux-x64, linux-arm64, win-x64, and
// the native win-arm64 release lane. The verifier retains a named fallback gap
// for callers that inspect a Windows ARM64 bundle from a non-ARM host.
const PACKAGED_TOOL_SMOKE_POLICY = {
    'pdf-print-dialog': {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['evb-pdf-print-dialog'],
    },
    'evb-pdf-image-combine': {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['evb-pdf-image-combine'],
    },
    'evb-pdf-image-combine-compact-manifest': {
        allowedExitCodes: new Set([1]),
        expectedOutputTokens: ['missing --compact-manifest value'],
    },
    'evb-pdf-page-ops': {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['evb-pdf-page-ops'],
    },
    'evb-pdf-search': {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['evb-pdf-search'],
    },
    'evb-scan-cleanup': {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['evb-scan-cleanup'],
    },
    ddjvu: {
        allowedExitCodes: new Set([
            0,
            1,
            10,
        ]),
        expectedOutputTokens: [
            'ddjvu',
            'djvu',
        ],
    },
    djvused: {
        allowedExitCodes: new Set([
            0,
            10,
        ]),
        expectedOutputTokens: [
            'djvused',
            'djvu',
        ],
    },
    djvudump: {
        allowedExitCodes: new Set([
            0,
            1,
            10,
        ]),
        expectedOutputTokens: [
            'djvudump',
            'djvu',
        ],
    },
    pdfinfo: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: [
            'pdfinfo',
            'poppler',
        ],
    },
    pdftoppm: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: [
            'pdftoppm',
            'poppler',
        ],
    },
    pdftotext: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: [
            'pdftotext',
            'poppler',
        ],
    },
    qpdf: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['qpdf'],
    },
    tesseract: {
        allowedExitCodes: new Set([0]),
        expectedOutputTokens: ['tesseract'],
        // Recognition profiles pass 5.x-only parameters that 4.x rejects silently.
        requiredOutputPattern: /^tesseract v?5\./mu,
    },
};

/** @param {string} toolName @returns {IToolSmokePolicy} */
export function getPackagedToolSmokePolicy(toolName) {
    const policy = /** @type {Record<string, IToolSmokePolicy>} */ (PACKAGED_TOOL_SMOKE_POLICY)[toolName];
    if (!policy) {
        throw new Error(`Unsupported packaged tool smoke policy "${toolName}"`);
    }

    return policy;
}

/** @param {string} toolName @param {number} exitCode @param {string} output */
export function assertPackagedToolSmoke(toolName, exitCode, output) {
    const policy = getPackagedToolSmokePolicy(toolName);
    if (!policy.allowedExitCodes.has(exitCode)) {
        throw new Error(
            `Packaged tool smoke test failed (${toolName}) with exit code ${exitCode}`,
        );
    }

    const normalizedOutput = output.trim().toLowerCase();
    if (!normalizedOutput) {
        throw new Error(`Packaged tool smoke test produced no output for ${toolName}`);
    }

    if (!policy.expectedOutputTokens.some(token => normalizedOutput.includes(token))) {
        throw new Error(
            `Packaged tool smoke test output for ${toolName} did not match any expected signature`,
        );
    }
    if (policy.requiredOutputPattern && !policy.requiredOutputPattern.test(normalizedOutput)) {
        throw new Error(
            `Packaged tool smoke test output for ${toolName} did not report a supported version`,
        );
    }
}
