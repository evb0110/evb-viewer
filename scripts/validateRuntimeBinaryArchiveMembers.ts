const WINDOWS_MEMBER_PATH = /^[a-z]:/iu;

export interface IRuntimeBinaryArchiveMemberPolicy {
    executableEntry: string;
    requiredExecutableEntries?: readonly string[];
    requiredAdjacentDllEntries: readonly string[];
    excludedAdjacentDllEntries?: readonly string[];
    requiredDirectoryEntries?: readonly string[];
}

export interface IRuntimeBinaryArchiveMembers {
    adjacentDllEntries: readonly string[];
    executableEntry: string;
    executableEntries: readonly string[];
    requiredDirectoryEntries: readonly string[];
}

// Member names prove which paths the staging step may copy. The archive
// digest remains the provenance boundary for bytes, metadata, and signatures.
// This validator intentionally does not reject unrelated upstream files such
// as qpdf's fix-qdf.exe and zlib-flate.exe.

function normalizeMember(member: string) {
    const normalized = member.replaceAll('\\', '/');
    const segments = normalized.split('/');
    const directory = segments.at(-1) === '';
    const pathSegments = directory ? segments.slice(0, -1) : segments;
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

function parentDirectory(member: string) {
    const separator = member.lastIndexOf('/');
    return separator < 0 ? '' : member.slice(0, separator);
}

export function validateRuntimeBinaryArchiveMembers(
    members: readonly string[],
    policy: IRuntimeBinaryArchiveMemberPolicy,
): IRuntimeBinaryArchiveMembers {
    const normalizedMembers = members.map(normalizeMember);
    if (new Set(normalizedMembers).size !== normalizedMembers.length) {
        throw new Error('Runtime archive contains duplicate members.');
    }
    const executableEntry = normalizeMember(policy.executableEntry);
    const executableEntries = [
        executableEntry,
        ...(policy.requiredExecutableEntries ?? []).map(normalizeMember),
    ];
    if (new Set(executableEntries).size !== executableEntries.length) {
        throw new Error('Runtime archive executable requirements contain duplicates.');
    }
    for (const requiredExecutableEntry of executableEntries) {
        if (requiredExecutableEntry.endsWith('/')) {
            throw new Error('Runtime archive executable member must be a file.');
        }
        if (!normalizedMembers.includes(requiredExecutableEntry)) {
            throw new Error(`Runtime archive is missing executable member: ${requiredExecutableEntry}`);
        }
    }

    const executableDirectory = parentDirectory(executableEntry);
    for (const requiredExecutableEntry of executableEntries) {
        if (parentDirectory(requiredExecutableEntry) !== executableDirectory) {
            throw new Error(`Runtime archive executable requirement is outside executable directory: ${requiredExecutableEntry}`);
        }
    }
    const excludedAdjacentDllEntries = new Set(
        (policy.excludedAdjacentDllEntries ?? []).map(normalizeMember),
    );
    for (const excludedEntry of excludedAdjacentDllEntries) {
        if (parentDirectory(excludedEntry) !== executableDirectory || !excludedEntry.toLowerCase().endsWith('.dll')) {
            throw new Error(`Runtime archive excluded DLL is outside executable directory: ${excludedEntry}`);
        }
    }
    const adjacentDllEntries = normalizedMembers
        .filter(member => (
            parentDirectory(member) === executableDirectory
            && member.toLowerCase().endsWith('.dll')
            && !excludedAdjacentDllEntries.has(member)
        ))
        .sort();
    const requiredAdjacentDllEntries = policy.requiredAdjacentDllEntries.map(normalizeMember);
    if (new Set(requiredAdjacentDllEntries).size !== requiredAdjacentDllEntries.length) {
        throw new Error('Runtime archive DLL requirements contain duplicates.');
    }
    for (const requiredEntry of requiredAdjacentDllEntries) {
        if (parentDirectory(requiredEntry) !== executableDirectory || !requiredEntry.toLowerCase().endsWith('.dll')) {
            throw new Error(`Runtime archive DLL requirement is outside executable directory: ${requiredEntry}`);
        }
        if (!adjacentDllEntries.includes(requiredEntry)) {
            throw new Error(`Runtime archive is missing required DLL member: ${requiredEntry}`);
        }
    }

    const requiredDirectoryEntries = (policy.requiredDirectoryEntries ?? []).map(normalizeMember);
    if (new Set(requiredDirectoryEntries).size !== requiredDirectoryEntries.length) {
        throw new Error('Runtime archive directory requirements contain duplicates.');
    }
    for (const requiredDirectoryEntry of requiredDirectoryEntries) {
        if (!requiredDirectoryEntry.endsWith('/')) {
            throw new Error(`Runtime archive directory requirement must end with '/': ${requiredDirectoryEntry}`);
        }
        const hasDirectoryEntry = normalizedMembers.includes(requiredDirectoryEntry)
            || normalizedMembers.some(member => member.startsWith(requiredDirectoryEntry));
        if (!hasDirectoryEntry) {
            throw new Error(`Runtime archive is missing required directory member: ${requiredDirectoryEntry}`);
        }
    }

    return {
        adjacentDllEntries,
        executableEntry,
        executableEntries,
        requiredDirectoryEntries,
    };
}
