# Print-selection filename compatibility

## Recommendation

Use a compact page specification made only from decimal digits, ASCII hyphens, and underscores:

- One contiguous run: `document - pages 4-6.pdf`
- Several runs: `document - pages 4-6_8_11-12.pdf`
- Two isolated pages: `document - pages 4_8.pdf`

The underscore separates page groups. The hyphen has one job inside the page specification: it marks an inclusive range. This keeps the format short and unambiguous without adding commas.

Normalize the selection before naming it. Keep valid page numbers, remove duplicates, sort ascending, then collapse consecutive numbers into inclusive ranges. An absent explicit selection should retain the source name without adding a page label, while still applying the common sanitization, length, and `.pdf` extension rules below. A one-page selection should retain the existing localized singular form, such as `document - page 4.pdf`. Multi-page selections should use a localized plural label followed by the ASCII page specification.

Set these product limits:

- Maximum exact page specification: 80 UTF-16 code units, excluding the localized `pages ` label.
- Maximum complete suggested filename: both 180 UTF-16 code units and 180 UTF-8 bytes, including `.pdf`.

If an exact page specification exceeds 80 code units, use this bounded summary:

`document - pages 500-selected_1-to-999_id-edce9f76.pdf`

The generic summary descriptor is `{count}-selected_{first}-to-{last}_id-{fingerprint}`.

The example describes 500 selected pages whose first and last pages are 1 and 999. The final eight hexadecimal digits are a stable 32-bit FNV-1a hash of the canonical exact page specification. For the example, that specification is `1_3_5_..._999`, without the visual ellipsis. Hash the actual underscore-delimited string as UTF-8. The fingerprint is not a security feature. It only prevents two different fragmented selections with the same count and bounds from receiving the same suggestion. [RFC 9923 specifies FNV-1a and recommends it for general use](https://www.rfc-editor.org/rfc/rfc9923.html#name-fnv-basics).

Localize the human words `pages`, `selected`, and `to`. Keep the digits, hyphens, underscores, `id` marker, and fingerprint ASCII and locale-independent. Compute the fingerprint before localization so the same page set has the same identifier in every app language.

The 180-unit complete-name cap is deliberately below the common 255-unit component limit. It also leaves 79 units in the legacy 260-unit Windows path budget for the drive, directory, separators, and terminating null. No filename-only policy can guarantee compatibility with an arbitrarily deep save directory. A 200-unit cap would leave only 59 units, which is needlessly tight for a user-selected path. Microsoft's long-path support also requires both system configuration and application opt-in, so the implementation should not assume that every Windows save dialog has it enabled. [Microsoft documents the 260-character legacy limit, the opt-in requirement, and a commonly 255-character component limit](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation).

The separate 180-byte cap covers filesystems that measure a directory entry in bytes. Ext4 filenames cannot exceed 255 bytes, according to the [Linux kernel's ext4 directory-entry documentation](https://docs.kernel.org/filesystems/ext4/directory.html#linear-classic-directories). The policy leaves a 75-byte engineering margin below that limit.

JavaScript string length supplies the UTF-16 measurement. ECMAScript strings are sequences of UTF-16 code units, and their length is the number of those units. Windows also represents filenames and other Unicode strings as UTF-16 `WCHAR` sequences. [ECMAScript defines the String type in UTF-16 code units](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-ecmascript-language-types-string-type), and [Microsoft defines `WCHAR` as one UTF-16 code unit](https://learn.microsoft.com/en-us/windows/win32/learnwin32/working-with-strings). HFS Plus stores at most 255 16-bit `UniChar` elements in `HFSUniStr255`, which makes the same conservative measurement useful on older Mac volumes. [Apple documents that 255-element structure](https://developer.apple.com/library/archive/technotes/tn/tn1150.html#HFSPlusNames). Measure UTF-8 with `TextEncoder`, whose `encode` method produces a UTF-8 byte sequence under the [WHATWG Encoding Standard](https://encoding.spec.whatwg.org/#dom-textencoder-encode).

When truncation is necessary, reserve the complete selection suffix and `.pdf` first, then shorten only the source stem until the whole name satisfies both 180 limits. Stop on a Unicode code-point boundary so the implementation never leaves an unmatched surrogate. Trimming on a grapheme boundary is better when `Intl.Segmenter` is available. Recalculate both measurements after each accepted segment because one code point can occupy two UTF-16 units and up to four UTF-8 bytes. Strip any new trailing period or space after truncation. Use `document` if sanitization or truncation empties the stem.

## Why not commas

A comma is technically legal in a Windows filename. Microsoft's forbidden-character list contains `<`, `>`, `:`, `"`, `/`, `\`, `|`, `?`, `*`, NUL, and control characters 1 through 31. It does not contain comma. The same is true for spaces, ordinary hyphens, and underscores. [Microsoft's naming rules provide the complete list](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#naming-conventions).

Avoiding commas is still sensible. Commas often represent list boundaries in exported data and hand-written scripts. This is an interoperability choice, not a Windows filesystem requirement. An underscore is more distinct from the range hyphen and has no special meaning in common command shells.

The other candidates are weaker:

| Separator | Assessment |
| --- | --- |
| Space | Legal inside a Windows filename, but cannot end the name. It is good around the human-readable label, not as the page-group delimiter. |
| Hyphen | Legal and compact. Reserve it for inclusive ranges so `4-6_8` has one reading. |
| Underscore | Legal, compact, and visually distinct. Best group delimiter. |
| Word `to` | Legal but longer and language-dependent. Use it only in the fallback summary, where it makes clear that first and last are bounds rather than one selected continuous range. |
| Comma | Legal on Windows, but excluded by product choice for easier interchange with list-oriented text formats and scripts. |
| Semicolon, ampersand, or pipe | A pipe is invalid on Windows. Semicolon and ampersand are legal filenames but act as shell syntax in common environments, so none is a good generated separator. |

## Sanitizing the complete suggestion

Do not rely only on Chromium's cleanup. Apply one deterministic sanitization pass in EVB Viewer after assembling the suggestion:

1. Work from the source basename, not a path. Remove a final `.pdf` case-insensitively before adding the derived suffix.
2. Replace Windows-forbidden characters, NUL, and control characters 1 through 31 with `_`.
3. Remove trailing spaces and periods from the source stem.
4. If the result is empty, `.` or `..`, use `document`.
5. Treat device names case-insensitively. The reserved set is `CON`, `PRN`, `AUX`, `NUL`, `COM1` through `COM9`, `COM¹` through `COM³`, `LPT1` through `LPT9`, and `LPT¹` through `LPT³`. Prefix `_` if a sanitized standalone stem matches one. Microsoft also reserves these names when followed by an extension. [The device-name and trailing-period rules are in the same Windows naming reference](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#naming-conventions).
6. Add the localized page label, the ASCII page specification or bounded summary, and exactly one lowercase `.pdf` extension.
7. Enforce both 180-unit caps by truncating only the source stem. Re-run the trailing-space and trailing-period cleanup, then assert that the final name is nonempty, ends in `.pdf`, contains no forbidden Windows characters, is no longer than 180 UTF-16 code units, and occupies no more than 180 UTF-8 bytes.

The generated suffix means a source such as `CON.pdf` would no longer equal a reserved device basename, but checking reserved names in the shared sanitizer is still cheap and prevents future callers from depending on that accident.

Do not strip valid commas or other legal punctuation already present in the user's source basename. The policy is to avoid generating commas in the selection descriptor, not to rename the source more than compatibility requires.

## Chromium and Electron behavior

EVB Viewer supplies the suggested name through the printable document title. Chromium's print-preview handler forwards the initiator title to the selected printer handler. Its PDF handler then replaces illegal path characters, preserves an existing `.pdf` extension or adds one, and gives the result to the native Save As dialog. The relevant first-party paths are [Chromium's `print_preview_handler.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/webui/print_preview/print_preview_handler.cc#751) and [`pdf_printer_handler.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/webui/print_preview/pdf_printer_handler.cc#352).

That source path confirms that changing the hidden frame's title is the correct way to influence Chromium's Save as PDF suggestion. It also explains why EVB Viewer should pass a title that already ends in `.pdf`. Chromium otherwise adds the extension itself.

Electron exposes page ranges separately from naming. `webContents.print` accepts inclusive zero-based ranges, with the warning that macOS honors only one range. It reports cancellation through the print callback as a failed call with `Print job canceled`. [Electron documents both behaviors in `webContents.print`](https://www.electronjs.org/docs/latest/api/web-contents#contentsprintoptions-callback). These print semantics do not change the filename encoding, but they support keeping page selection normalization in EVB Viewer rather than asking the system dialog to reconstruct it.

## Examples and edge cases

| Input | Suggested filename |
| --- | --- |
| Source `report.pdf`, pages 4, 5, 6 | `report - pages 4-6.pdf` |
| Source `report.pdf`, pages 12, 4, 6, 5, 8, 11, 12 | `report - pages 4-6_8_11-12.pdf` |
| Source `archive.PDF`, pages 2 and 9 | `archive - pages 2_9.pdf` |
| Source `budget:final.pdf`, pages 1 through 3 | `budget_final - pages 1-3.pdf` |
| Source `CON.pdf`, pages 1 and 2 | `_CON - pages 1-2.pdf` |
| No source name, pages 7 and 9 | `document - pages 7_9.pdf` |
| Five hundred odd pages from 1 through 999 | `document - pages 500-selected_1-to-999_id-edce9f76.pdf` |

APFS accepts valid UTF-8 filenames and preserves their case and normalization. It is normalization-insensitive in current documented variants. HFS Plus instead stores decomposed UTF-16 names. EVB Viewer does not need to normalize a valid JavaScript string solely for either filesystem, but it must avoid splitting a surrogate pair while truncating. [Apple contrasts APFS and HFS Plus filename storage in its APFS guide](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html#//apple_ref/doc/uid/TP40016999-CH6-SW6).
