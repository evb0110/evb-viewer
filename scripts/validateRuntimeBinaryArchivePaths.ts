const WINDOWS_MEMBER_PATH = /^[a-z]:/iu;

function normalizeMember(member: string) {
    const normalized = member.replaceAll('\\', '/');
    const segments = normalized.split('/');
    const pathSegments = segments.at(-1) === '' ? segments.slice(0, -1) : segments;
    if (
        normalized.length === 0
        || normalized.startsWith('/')
        || normalized.includes('\0')
        || WINDOWS_MEMBER_PATH.test(normalized)
        || pathSegments.some(segment => segment.length === 0 || segment === '..')
    ) {
        throw new Error(`Runtime archive member is not a safe relative path: ${member}`);
    }
    return normalized;
}

export function validateRuntimeBinaryArchivePaths(members: readonly string[]) {
    const normalizedMembers = members.map(normalizeMember);
    if (new Set(normalizedMembers).size !== normalizedMembers.length) {
        throw new Error('Runtime archive contains duplicate members.');
    }
    return normalizedMembers;
}
