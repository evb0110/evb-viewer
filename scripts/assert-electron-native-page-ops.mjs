import {
    accessSync,
    constants,
    existsSync,
} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {
    join,
    resolve,
} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tsImport} from 'tsx/esm/api';
import {
    platform,
    arch,
} from 'node:process';

function platformArch() {
    const platformName = platform === 'win32' ? 'win32' : platform;
    return `${platformName}-${arch}`;
}

function nativeToolCandidates(projectRoot, env) {
    const binaryName = platform === 'win32' ? 'evb-pdf-page-ops.exe' : 'evb-pdf-page-ops';
    const tag = platformArch();
    return [
        env.EVB_PDF_PAGE_OPS_PATH,
        join(projectRoot, '.tmp', 'pdf-page-ops', tag, 'bin', binaryName),
        join(projectRoot, 'native', 'target', 'release', binaryName),
        join(projectRoot, 'native', 'target', 'debug', binaryName),
    ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
}

function stagedToolPath(projectRoot, protocol) {
    const binaryName = platform === 'win32' ? `${protocol.binaryName}.exe` : protocol.binaryName;
    return join(projectRoot, '.tmp', protocol.stagingName, platformArch(), 'bin', binaryName);
}

function readProtocolHandshake(toolPath) {
    // A helper that hangs or waits on input must not hang the preflight; a
    // timeout reaches the caller's rebuild message like any other failure.
    const output = execFileSync(toolPath, ['--protocol-version'], {
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        encoding: 'utf8',
        timeout: 10_000,
    }).trim();
    if (/^\d+$/u.test(output)) {
        return {
            protocolVersion: Number(output),
            capabilities: [],
        };
    }
    const parsed = JSON.parse(output);
    return {
        protocolVersion: parsed.protocolVersion,
        capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
    };
}

// A helper built from older sources still runs `--version` but speaks an
// older protocol, and every suite that reaches it then fails far from the
// cause. Refuse it here and name the rebuild instead.
function assertCurrentProtocol(toolPath, protocol) {
    const rebuild = `rebuild it with node scripts/build-native-tool.mjs ${protocol.stagingName}`;
    let handshake;
    try {
        handshake = readProtocolHandshake(toolPath);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${protocol.binaryName} at ${toolPath} did not answer --protocol-version (${detail}); ${rebuild}.`);
    }
    const missingCapabilities = (protocol.capabilities ?? [])
        .filter(capability => capability.required && !handshake.capabilities.includes(capability.name))
        .map(capability => capability.name);
    if (handshake.protocolVersion !== protocol.protocolVersion || missingCapabilities.length > 0) {
        const missing = missingCapabilities.length > 0
            ? ` without ${missingCapabilities.join(', ')}`
            : '';
        throw new Error(
            `${protocol.binaryName} at ${toolPath} speaks protocol ${handshake.protocolVersion}${missing}, `
            + `but this checkout expects ${protocol.protocolVersion}. It was built from older sources; ${rebuild}.`,
        );
    }
}

/**
 * Every helper staged under `.tmp` must speak this checkout's protocol. A
 * missing helper is left to the suites that need it.
 */
export function assertStagedNativeToolProtocols({
    projectRoot = process.cwd(),
    protocols,
}) {
    for (const protocol of protocols) {
        const toolPath = stagedToolPath(resolve(projectRoot), protocol);
        if (existsSync(toolPath)) {
            assertCurrentProtocol(toolPath, protocol);
        }
    }
}

function findExecutable(projectRoot, env) {
    return nativeToolCandidates(projectRoot, env).find((candidate) => {
        if (!existsSync(candidate)) {
            return false;
        }
        try {
            accessSync(candidate, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }) ?? null;
}

/**
 * @param {{
 *     project?: string;
 *     projectRoot?: string;
 *     env?: Record<string, string | undefined>;
 *     protocols?: ReadonlyArray<{
 *         binaryName: string;
 *         stagingName: string;
 *         protocolVersion: number;
 *         capabilities?: ReadonlyArray<{name: string; required: boolean}>;
 *     }>;
 * }} options
 */
export function assertElectronNativePageOps({
    project,
    projectRoot = process.cwd(),
    env = process.env,
    protocols = [],
} = {}) {
    if (env.EVB_PDF_PAGE_OPS_DISABLE === '1') {
        return {
            required: true,
            disabled: true,
            toolPath: null,
        };
    }

    if (env.EVB_PDF_PAGE_OPS_ENABLE !== '1') {
        throw new Error(
            `Native PDF page operations are required for ${project}; `
            + 'the launcher did not set EVB_PDF_PAGE_OPS_ENABLE=1.',
        );
    }

    const toolPath = findExecutable(resolve(projectRoot), env);
    if (!toolPath) {
        throw new Error(
            `Native PDF page operations are required for ${project}, but `
            + 'evb-pdf-page-ops was not found in EVB_PDF_PAGE_OPS_PATH, .tmp, '
            + 'native/target/release, or native/target/debug.',
        );
    }

    try {
        execFileSync(toolPath, ['--version'], {stdio: 'pipe'});
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Native PDF page operations failed its --version check at ${toolPath}: ${detail}`);
    }
    const pageOpsProtocol = protocols.find(protocol => protocol.binaryName === 'evb-pdf-page-ops');
    if (pageOpsProtocol) {
        assertCurrentProtocol(toolPath, pageOpsProtocol);
    }

    return {
        required: true,
        disabled: false,
        toolPath,
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const project = process.argv[2];
    try {
        const {GENERATED_RUST_NATIVE_TOOL_PROTOCOLS: protocols} = await tsImport(
            '../packages/contracts/nativeToolProtocols.ts',
            import.meta.url,
        );
        assertStagedNativeToolProtocols({protocols});
        const result = assertElectronNativePageOps({
            project,
            protocols,
        });
        if (result.required && !result.disabled) {
            console.log(`[native-page-ops] admitted ${project}: ${result.toolPath}`);
        }
    } catch (error) {
        console.error(`[native-page-ops] admission failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
