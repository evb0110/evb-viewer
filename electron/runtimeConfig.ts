function integer(
    raw: string | undefined,
    fallback: number,
    minimum: number,
    maximum?: number,
    clampMaximum = true,
) {
    if (!raw) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }
    if (typeof maximum === 'number' && parsed > maximum) {
        return clampMaximum ? maximum : fallback;
    }
    return parsed;
}

function boolean(raw: string | undefined, fallback = false) {
    return raw === undefined || raw === '' ? fallback : raw === '1';
}

export const runtimeConfig = {
    get allowMultipleAutomationSessions() { // false; permit isolated automation profile concurrency
        return boolean(process.env.EVB_ALLOW_MULTI_AUTOMATION_SESSIONS);
    },
    get appTempNamespace() { // unset; per-process namespace shared with workers and child tools
        return process.env.EVB_APP_TEMP_NAMESPACE?.trim().toLowerCase();
    },
    get automationBootstrapDevProfile() { // false; seed one isolated automation profile from dev recents
        return boolean(process.env.EVB_AUTOMATION_BOOTSTRAP_DEV_PROFILE);
    },
    get automationEnableRendererFileOpenHelper() { // false; expose the renderer-open harness hooks
        return boolean(process.env.EVB_ENABLE_RENDERER_FILE_OPEN_HELPER);
    },
    get automationHideWindow() { // follows no-focus when unset; keep hidden automation renderers active
        return boolean(process.env.EVB_AUTOMATION_HIDE_WINDOW, this.automationNoFocus);
    },
    get automationNoFocus() { // false; disable focus stealing for automation sessions
        return boolean(process.env.EVB_AUTOMATION_NO_FOCUS);
    },
    get automationSessionName() { // unset; name isolated automation sessions
        return process.env.EVB_AUTOMATION_SESSION_NAME?.trim();
    },
    get automationUserDataDir() { // unset; select an isolated automation profile
        return process.env.EVB_AUTOMATION_USER_DATA_DIR?.trim();
    },
    get automationWaitRendererReady() { // false; wait for the initial renderer-ready signal
        return boolean(process.env.EVB_WAIT_RENDERER_READY);
    },
    get buildGitSha() { // empty; embed the source revision in diagnostics when the build supplies it
        return process.env.EVB_BUILD_GIT_SHA?.trim() ?? '';
    },
    get builtRenderer() { // false; serve the generated renderer in an unpackaged run
        return boolean(process.env.EVB_BUILT_RENDERER);
    },
    get fileLogDir() { // unset; use the per-user Electron logs directory
        return process.env.EVB_FILE_LOG_DIR?.trim();
    },
    get logStdout() { // disabled; enable NDJSON mirroring only when requested by the launcher
        return process.env.EVB_LOG_STDOUT === 'ndjson';
    },
    get logStdoutLevel() { // info; set the minimum level for launcher NDJSON output
        return process.env.EVB_LOG_STDOUT_LEVEL;
    },
    mcpPort(isPackaged: boolean) { // 38671 packaged, 38672 unpackaged; bind the local MCP server
        return integer(process.env.EVB_MCP_PORT, isPackaged ? 38671 : 38672, 1, 65535, false);
    },
    get mcpToken() { // unset; use the configured token before generating a profile token
        return process.env.EVB_MCP_TOKEN?.trim();
    },
    get ocrModelDownloadConcurrency() { // 0 means tier default (1 low, 3 otherwise); bound simultaneous model downloads
        const raw = process.env.EVB_OCR_MODEL_DOWNLOAD_CONCURRENCY;
        return raw === undefined ? 0 : integer(raw, 0, 1, 8);
    },
    get pdfImageCombinePath() { // unset; let native tool discovery choose the image combiner
        return process.env.EVB_PDF_IMAGE_COMBINE_PATH?.trim();
    },
    get pdfPageOpsPath() { // unset; let native tool discovery choose the page operations tool
        return process.env.EVB_PDF_PAGE_OPS_PATH?.trim();
    },
    get scanCleanupPath() { // unset; let native tool discovery choose scan cleanup
        return process.env.EVB_SCAN_CLEANUP_PATH?.trim();
    },
    get serverPath() { // /electron; route the development renderer request
        return process.env.EVB_SERVER_PATH;
    },
    get serverPort() { // 3235; connect to the development renderer server
        return integer(process.env.EVB_SERVER_PORT, 3235, 1);
    },
    get startupTrace() { // false; enable startup diagnostics
        return boolean(process.env.EVB_STARTUP_TRACE);
    },
    get test() {
        return {
            get atomicReplaceBarrier() { // unset; stop Windows atomic replacement at one test stage
                return process.env.EVB_ATOMIC_REPLACE_TEST_BARRIER;
            },
            get atomicReplaceBarrierFile() { // unset; coordinate the Windows atomic replacement test
                return process.env.EVB_ATOMIC_REPLACE_TEST_BARRIER_FILE;
            },
            get e2eOpenDialogPath() { // unset; answer the native open dialog in automation
                return process.env.EVB_E2E_OPEN_DIALOG_PATH?.trim();
            },
            get e2eOpenImagePath() { // unset; provide the image opened by the stamp-picker E2E
                return process.env.EVB_E2E_OPEN_IMAGE_PATH?.trim();
            },
            get e2eSaveDialogPath() { // unset; answer the native save dialog in automation
                return process.env.EVB_E2E_SAVE_DIALOG_PATH?.trim();
            },
            get holdSelectedPageQpdfMarker() { // unset; pause the selected-page print child for cancellation tests
                return process.env.EVB_E2E_HOLD_SELECTED_PAGE_QPDF_MARKER?.trim();
            },
            get issue124Acceptance() { // false; enable the selected-page print cancellation test hook
                return boolean(process.env.EVB_E2E_ISSUE_124_ACCEPTANCE);
            },
            get nativePdfImageCombineEnabled() { // false; enable the native image-combiner test path
                return boolean(process.env.EVB_PDF_IMAGE_COMBINE_ENABLE);
            },
            get nativePdfAssemblerEnabled() { // false; enable the native PDF assembler test path
                return boolean(process.env.EVB_PDF_NATIVE_ASSEMBLER_ENABLE);
            },
            get nativeTiffCombineEnabled() { // false; enable the native TIFF combiner test path
                return boolean(process.env.EVB_TIFF_COMBINE_NATIVE_ENABLE);
            },
            get nativeToolAllowPackagedDiagnosticPaths() { // false; allow release verification to use a diagnostic native tool
                return boolean(process.env.EVB_NATIVE_TOOL_ALLOW_PACKAGED_DIAGNOSTIC_PATHS);
            },
            get ocrJobMaxTempMb() { // 4096 MiB; let the storage test lower the aggregate OCR limit
                return integer(process.env.EVB_OCR_JOB_MAX_TEMP_MB, 4_096, 1, 65_536);
            },
            get performanceMode() { // unset; override the performance mode in isolated E2E sessions
                return process.env.EVB_TEST_PERFORMANCE_MODE;
            },
            get printDialogMode() { // unset; replace the native print dialog in E2E
                return process.env.EVB_PRINT_DIALOG_TEST_MODE;
            },
            get printDialogOutputPath() { // unset; write the E2E print result to a known path
                return process.env.EVB_PRINT_DIALOG_TEST_OUTPUT_PATH;
            },
            get scanCleanupEvidenceDirectory() { // unset; preserve scan cleanup evidence for release diagnostics
                return process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR?.trim();
            },
        };
    },
} as const;
