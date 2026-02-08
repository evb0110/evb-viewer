# App Icon Pipeline

This project uses a single source icon at `resources/icon.svg`.

Generate all platform assets with:

```bash
pnpm run build:icons
```

That script regenerates:

- `resources/icon.png` (Linux/runtime PNG)
- `resources/icon.ico` (Windows multi-size icon)
- `resources/icon.icns` (macOS app bundle icon)

## Platform Notes

- macOS package icon should come from the app bundle `.icns` file.
- Windows `.ico` should include multiple sizes for common DPI scales.
- Linux icons should be PNG-based and provide a large base size.

Sources:

- https://www.electron.build/icons.html
- https://www.electronjs.org/docs/latest/api/native-image
- https://www.electronjs.org/docs/latest/api/browser-window
- https://developer.apple.com/library/archive/documentation/Xcode/Reference/xcode_ref-Asset_Catalog_Format/IconSetType.html
- https://learn.microsoft.com/en-us/windows/apps/design/style/iconography/app-icon-construction
- https://specifications.freedesktop.org/icon-theme/latest/index.html
