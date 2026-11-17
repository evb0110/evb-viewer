/**
 * The key a Ctrl/Cmd shortcut names, lower-cased. Chromium reports the active
 * layout's character in `event.key`, so with a Cyrillic or Greek layout Ctrl+F
 * arrives as `а` or `φ`. A letter outside A-Z falls back to the physical key,
 * as desktop menu accelerators do; a Latin layout such as AZERTY or Dvorak
 * keeps the letter it types.
 */
export function readShortcutKey(event: {readonly key: string; readonly code?: string}) {
    const key = event.key.toLowerCase();
    if (/^[a-z]$/.test(key) || !/^\p{L}$/u.test(key)) {
        return key;
    }
    const physicalLetter = /^Key([A-Z])$/.exec(event.code ?? '')?.[1];
    return physicalLetter ? physicalLetter.toLowerCase() : key;
}
