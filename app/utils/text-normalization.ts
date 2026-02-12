export function normalizeAnnotationSubtypeToken(subtype: string | null | undefined) {
    const normalized = (subtype ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
    if (!normalized) {
        return '';
    }
    switch (normalized) {
        case 'strikethrough':
            return 'strikeout';
        case 'typewriter':
        case 'noteinline':
            return 'freetext';
        case 'notelinked':
            return 'text';
        default:
            return normalized;
    }
}

export function normalizeComparableText(value: string | null | undefined) {
    return (value ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}
