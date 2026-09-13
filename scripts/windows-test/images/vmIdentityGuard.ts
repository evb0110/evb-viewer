import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isVmUuid } from '@scripts/windows-test/contracts/windowsTestContracts';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import { createProcessCommandRunner } from '@scripts/windows-test/host/utmctlClient';
import type { IUtmVmListEntry } from '@scripts/windows-test/host/utmctlClient';
import { createPlutilBundleIdentityReader } from '@scripts/windows-test/images/vmBundleLocator';

export interface IWindowsTestDestructiveTarget {
    vmId: string;
    bundlePath: string;
}

export interface IWindowsTestDestructivePolicy {
    allowedTestVmIds: readonly string[];
    goldenVmId: string;
    personalVmIdsDenied: readonly string[];
    testImageRoot: string;
}

export const windowsTestIdentityRefusals = [
    'vm-id-not-a-uuid',
    'vm-id-not-allowlisted',
    'vm-id-is-golden-image',
    'vm-id-denied',
    'bundle-path-unresolved',
    'bundle-path-outside-test-image-root',
    'bundle-path-is-golden-baseline',
    'bundle-identity-unreadable',
    'bundle-vm-id-mismatch',
    'bundle-display-name-denied',
    'registered-vm-mismatch',
    'clone-diff-ambiguous',
] as const;

export type TWindowsTestIdentityRefusal = typeof windowsTestIdentityRefusals[number];

export class WindowsTestIdentityGuardError extends Error {
    readonly refusal: TWindowsTestIdentityRefusal;

    constructor(refusal: TWindowsTestIdentityRefusal, message: string) {
        super(message);
        this.name = 'WindowsTestIdentityGuardError';
        this.refusal = refusal;
    }
}

export interface IWindowsTestIdentityGuardDependencies {
    resolvePath(target: string): Promise<string>;
    readVmId(bundlePath: string): Promise<string | null>;
    readVmName(bundlePath: string): Promise<string | null>;
}

const nodeBundleIdentityReader = createPlutilBundleIdentityReader(createProcessCommandRunner());

export const nodeIdentityGuardDependencies: IWindowsTestIdentityGuardDependencies = {
    resolvePath: target => realpath(target),
    readVmId: bundlePath => nodeBundleIdentityReader.readVmId(bundlePath),
    readVmName: bundlePath => nodeBundleIdentityReader.readVmName(bundlePath),
};

export function destructivePolicyFromConfig(config: IWindowsTestHostConfig): IWindowsTestDestructivePolicy {
    return {
        allowedTestVmIds: config.allowedTestVmIds,
        goldenVmId: config.goldenVmId,
        personalVmIdsDenied: config.personalVmIdsDenied,
        testImageRoot: config.testImageRoot,
    };
}

// A clone registers a UUID that no static allowlist can contain, so the
// coordinator widens the policy with the single new UUID it observed from its
// own clone call. The golden and denied identities stay refused regardless.
export function withOwnedCloneAllowlisted(
    policy: IWindowsTestDestructivePolicy,
    clonedVmId: string,
): IWindowsTestDestructivePolicy {
    const normalized = clonedVmId.toLowerCase();
    if (!isVmUuid(normalized)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-not-a-uuid',
            `Refusing to own clone "${clonedVmId}": it is not a VM UUID.`,
        );
    }
    if (normalized === policy.goldenVmId.toLowerCase()) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-is-golden-image',
            'Refusing to own the golden image UUID as a working clone.',
        );
    }
    if (policy.personalVmIdsDenied.some(denied => denied.toLowerCase() === normalized)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-denied',
            'Refusing to own a denied VM UUID as a working clone.',
        );
    }
    return {
        ...policy,
        allowedTestVmIds: [
            ...policy.allowedTestVmIds,
            normalized,
        ],
    };
}

function isInside(parent: string, child: string) {
    const relative = path.relative(parent, child);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Teardown may only act on a run-owned clone. The configured golden UUID and
 * every bundle below the baseline directory remain immutable, even when a
 * stale lease or a test-style display name makes them look disposable.
 */
export function assertNotGoldenOrBaselineTarget(
    target: IWindowsTestDestructiveTarget,
    policy: IWindowsTestDestructivePolicy,
) {
    if (target.vmId.toLowerCase() === policy.goldenVmId.toLowerCase()) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-is-golden-image',
            'Refusing a destructive operation on the configured golden image.',
        );
    }
    const baselineRoot = path.resolve(policy.testImageRoot, 'baselines');
    const resolvedBundle = path.resolve(target.bundlePath);
    if (resolvedBundle === baselineRoot || isInside(baselineRoot, resolvedBundle)) {
        throw new WindowsTestIdentityGuardError(
            'bundle-path-is-golden-baseline',
            'Refusing a destructive operation on a bundle under the golden baseline directory.',
        );
    }
}

export async function assertDestructiveTarget(
    target: IWindowsTestDestructiveTarget,
    policy: IWindowsTestDestructivePolicy,
    dependencies: IWindowsTestIdentityGuardDependencies = nodeIdentityGuardDependencies,
) {
    assertNotGoldenOrBaselineTarget(target, policy);
    const vmId = target.vmId.toLowerCase();
    if (!isVmUuid(vmId)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-not-a-uuid',
            `Refusing a destructive operation on "${target.vmId}": display names and partial identifiers are never accepted.`,
        );
    }
    if (vmId === policy.goldenVmId.toLowerCase()) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-is-golden-image',
            'Refusing a destructive operation on the golden image; it stays stopped and immutable.',
        );
    }
    if (policy.personalVmIdsDenied.some(denied => denied.toLowerCase() === vmId)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-denied',
            'Refusing a destructive operation on a denied VM UUID.',
        );
    }
    if (!policy.allowedTestVmIds.some(allowed => allowed.toLowerCase() === vmId)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-not-allowlisted',
            'Refusing a destructive operation on a VM UUID that is not in the configured test allowlist.',
        );
    }

    let resolvedTarget: string;
    let resolvedRoot: string;
    try {
        resolvedRoot = await dependencies.resolvePath(policy.testImageRoot);
        resolvedTarget = await dependencies.resolvePath(target.bundlePath);
    } catch (error) {
        throw new WindowsTestIdentityGuardError(
            'bundle-path-unresolved',
            `Refusing a destructive operation: the VM bundle path could not be resolved (${String(error)}).`,
        );
    }
    if (!isInside(resolvedRoot, resolvedTarget)) {
        throw new WindowsTestIdentityGuardError(
            'bundle-path-outside-test-image-root',
            'Refusing a destructive operation: the resolved VM bundle path is outside the configured test image root.',
        );
    }

    if (typeof dependencies.readVmId !== 'function' || typeof dependencies.readVmName !== 'function') {
        throw new WindowsTestIdentityGuardError(
            'bundle-identity-unreadable',
            'Refusing a destructive operation: the bundle identity reader is incomplete.',
        );
    }

    let bundleVmId: string | null;
    let bundleName: string | null;
    try {
        [
            bundleVmId,
            bundleName,
        ] = await Promise.all([
            dependencies.readVmId(resolvedTarget),
            dependencies.readVmName(resolvedTarget),
        ]);
    } catch (error) {
        throw new WindowsTestIdentityGuardError(
            'bundle-identity-unreadable',
            `Refusing a destructive operation: the VM bundle identity could not be read (${String(error)}).`,
        );
    }
    if (bundleVmId === null
        || !isVmUuid(bundleVmId)
        || bundleName === null
        || typeof bundleName !== 'string'
        || bundleName.trim().length === 0) {
        throw new WindowsTestIdentityGuardError(
            'bundle-identity-unreadable',
            'Refusing a destructive operation: the VM bundle configuration has no usable UUID and display name.',
        );
    }
    if (bundleName.trim().toLowerCase() === 'windows') {
        throw new WindowsTestIdentityGuardError(
            'bundle-display-name-denied',
            'Refusing a destructive operation on the personal VM display name "Windows".',
        );
    }
    if (bundleVmId.toLowerCase() !== vmId) {
        throw new WindowsTestIdentityGuardError(
            'bundle-vm-id-mismatch',
            'Refusing a destructive operation: bundle config UUID does not match the requested VM UUID.',
        );
    }

    return {
        vmId,
        bundlePath: resolvedTarget,
    };
}

export function selectClonedVmId(
    before: readonly IUtmVmListEntry[],
    after: readonly IUtmVmListEntry[],
) {
    const known = new Set(before.map(entry => entry.uuid.toLowerCase()));
    const added = after
        .map(entry => entry.uuid.toLowerCase())
        .filter(uuid => !known.has(uuid));
    const unique = [...new Set(added)];
    if (unique.length !== 1) {
        throw new WindowsTestIdentityGuardError(
            'clone-diff-ambiguous',
            `Refusing an ambiguous clone result: expected exactly one new registered VM UUID, saw ${unique.length}.`,
        );
    }
    const cloned = unique[0];
    if (cloned === undefined || !isVmUuid(cloned)) {
        throw new WindowsTestIdentityGuardError(
            'clone-diff-ambiguous',
            'Refusing an ambiguous clone result: the new registration is not a VM UUID.',
        );
    }
    return cloned;
}
