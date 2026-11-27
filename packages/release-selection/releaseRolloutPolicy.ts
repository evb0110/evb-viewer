export interface IRolloutRelease {
    draft?: boolean;
    prerelease?: boolean;
    tag_name: string;
}

export interface IReleaseRolloutPolicy {
    canaryPercent: number;
    canaryTag: string | null;
    stableTags: readonly string[];
    withdrawnTags: ReadonlySet<string>;
}

function stableHash(value: string): number {
    let hash = 2_166_136_261;
    for (const character of value) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
}

export function parseReleaseTagList(value: string): string[] {
    return Array.from(
        new Set(
            value
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
        ),
    );
}

export function normalizeCanaryPercent(value: string | number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 0;
}

/** Selects public releases independently of GitHub's mutable `latest` flag. */
export function selectReleaseForRollout<TRelease extends IRolloutRelease>(
    releases: readonly TRelease[],
    policy: IReleaseRolloutPolicy,
    cohortKey: string,
): TRelease | null {
    const byTag = new Map(
        releases
            .filter((release) => !release.draft && !policy.withdrawnTags.has(release.tag_name))
            .map((release) => [release.tag_name, release]),
    );
    const canary = policy.canaryTag ? byTag.get(policy.canaryTag) : undefined;
    if (canary && stableHash(cohortKey) % 10_000 < Math.round(policy.canaryPercent * 100)) {
        return canary;
    }
    if (policy.stableTags.length > 0) {
        for (const tag of policy.stableTags) {
            const release = byTag.get(tag);
            if (release) {
                return release;
            }
        }
        return null;
    }
    return releases.find((release) => !release.draft && !release.prerelease && !policy.withdrawnTags.has(release.tag_name)) ?? null;
}
