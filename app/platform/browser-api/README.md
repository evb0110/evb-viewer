# Browser Platform API

Browser runtime capabilities live here as one file or small folder per `IPlatformApi` capability. Keep `browserPlatformApi.ts` and `lazyBrowserPlatformApi.ts` as composition layers only: they should wire capabilities together, not own capability behavior.

- Document, page-op, image-export, search, OCR, settings, shell, host, update, tab, DjVu, and agent behavior should stay in named capability modules.
- Browser-only fallbacks must preserve the shared contract shape from `packages/contracts/platformApi.ts`.
- Desktop-only capabilities should return explicit unavailable results in browser builds rather than importing Electron, native tools, or worker payloads.
- Public assets are part of the web release surface. Do not add engines, language caches, or generated worker payloads under `public/` unless the browser platform explicitly owns and tests them. The OCR engine `public/wasm/evb-tesseract.*` is owned by `browserOcrEngine.worker.ts` and fetched by digest (`scripts/wasm-artifacts.mjs`); its language models are not under `public/` but in Cache Storage (`browserOcrModels.ts`).
