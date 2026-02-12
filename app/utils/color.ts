export function parseHexColor(hex: string): [number, number, number] {
    const clean = hex.replace('#', '');
    if (clean.length === 3) {
        return [
            Number.parseInt(clean[0]! + clean[0]!, 16) / 255,
            Number.parseInt(clean[1]! + clean[1]!, 16) / 255,
            Number.parseInt(clean[2]! + clean[2]!, 16) / 255,
        ];
    }
    return [
        Number.parseInt(clean.slice(0, 2), 16) / 255,
        Number.parseInt(clean.slice(2, 4), 16) / 255,
        Number.parseInt(clean.slice(4, 6), 16) / 255,
    ];
}
