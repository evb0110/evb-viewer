import path from 'node:path';
import {isVmUuid} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    assertDestructiveTarget,
    nodeIdentityGuardDependencies,
    WindowsTestIdentityGuardError,
} from '@scripts/windows-test/images/vmIdentityGuard';
import type {
    IWindowsTestDestructivePolicy,
    IWindowsTestDestructiveTarget,
    IWindowsTestIdentityGuardDependencies,
} from '@scripts/windows-test/images/vmIdentityGuard';

function isInside(parent: string, child: string) {
    const relative = path.relative(parent, child);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The regular destructive guard deliberately refuses the golden baseline.
 * Headless healing is the one explicit mutable operation, so it first checks
 * the exact configured golden identity and then delegates bundle resolution,
 * UUID matching, display-name denial, and path safety to that existing guard
 * under the parent image directory. The explicit baseline check below keeps
 * the delegated policy from widening the operation to another bundle.
 */
export async function assertGoldenImageTarget(
    target: IWindowsTestDestructiveTarget,
    policy: IWindowsTestDestructivePolicy,
    dependencies: IWindowsTestIdentityGuardDependencies = nodeIdentityGuardDependencies,
) {
    const vmId = target.vmId.toLowerCase();
    if (!isVmUuid(vmId)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-not-a-uuid',
            `Refusing to heal the golden image "${target.vmId}": display names and partial identifiers are never accepted.`,
        );
    }
    if (policy.personalVmIdsDenied.some(denied => denied.toLowerCase() === vmId)) {
        throw new WindowsTestIdentityGuardError('vm-id-denied', 'Refusing to heal a denied personal VM UUID.');
    }
    if (vmId !== policy.goldenVmId.toLowerCase()) {
        throw new WindowsTestIdentityGuardError('vm-id-is-golden-image', 'Refusing to heal a VM that is not the configured golden image.');
    }

    let resolvedRoot: string;
    let resolvedTarget: string;
    try {
        resolvedRoot = await dependencies.resolvePath(policy.testImageRoot);
        resolvedTarget = await dependencies.resolvePath(target.bundlePath);
    } catch (error) {
        throw new WindowsTestIdentityGuardError(
            'bundle-path-unresolved',
            `Refusing to heal the golden image: its bundle path could not be resolved (${String(error)}).`,
        );
    }
    const baselineRoot = path.resolve(resolvedRoot, 'baselines');
    if (!isInside(resolvedRoot, resolvedTarget)) {
        throw new WindowsTestIdentityGuardError(
            'bundle-path-outside-test-image-root',
            'Refusing to heal the golden image: its bundle is outside the configured test image root.',
        );
    }
    if (!isInside(baselineRoot, resolvedTarget)) {
        throw new Error('Refusing to heal the golden image: its bundle is not below the configured baselines directory.');
    }

    // assertDestructiveTarget rejects the configured golden UUID and baseline
    // by design. Using its normal identity checks against the parent directory
    // is safe only after the exact UUID and baseline checks above pass.
    const delegatedPolicy: IWindowsTestDestructivePolicy = {
        ...policy,
        allowedTestVmIds: [
            ...policy.allowedTestVmIds,
            vmId,
        ],
        goldenVmId: '00000000-0000-4000-8000-000000000000',
        testImageRoot: path.dirname(resolvedRoot),
    };
    return assertDestructiveTarget(
        {
            vmId,
            bundlePath: resolvedTarget,
        },
        delegatedPolicy,
        dependencies,
    );
}
