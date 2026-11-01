import * as v from 'valibot';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';

/** Bump with the pinned engine artifact so existing browser caches cannot mix runtimes. */
export const BROWSER_QPDF_ENGINE_REVISION = '12.3.2-r1';
/** qpdf reads whole files; the browser admits the inputs its page tool admits. */
export const BROWSER_QPDF_MAX_INPUT_BYTES = BROWSER_PAGE_OPS_MAX_REQUEST_BYTES;
/** The bound desktop puts on a native tool's captured stderr. */
export const BROWSER_QPDF_MAX_DIAGNOSTIC_CHARACTERS = 262_144;

/**
 * The qpdf commands the browser may run, by name: the worker builds each
 * command line from `@pdf-core/qpdfCommands`, so no argv crosses the boundary.
 */
export const BROWSER_QPDF_COMMANDS = [
    'check',
    'page-count',
    'rewrite',
    'lossless-rewrite',
] as const;
export type TBrowserQpdfCommand = typeof BROWSER_QPDF_COMMANDS[number];

/**
 * Desktop's append-admission verdicts (`@contracts/pdfAppendAdmission`), at the
 * index `evb_pdf_page_ops_append_admission` returns for each
 * (`native/pdf-page-ops/src/wasm_append_admission.rs`).
 */
export const BROWSER_APPEND_ADMISSION_VERDICTS = [
    'appendable',
    'repairable',
    'limited',
    'unverified',
] as const;

/** Why a request failed, in its error envelope. */
export const BROWSER_QPDF_ENGINE_ERROR_CODES = {
    /** The engine could not be downloaded or started; nothing judged the PDF. */
    unavailable: 'qpdf-engine-unavailable',
    /** qpdf refused the rewrite, or its output still could not take an edit. */
    rewriteFailed: 'qpdf-rewrite-failed',
    failed: 'qpdf-engine-failed',
} as const;

const requestIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const inputSchema = v.pipe(
    v.custom<Uint8Array>(value => value instanceof Uint8Array),
    v.check(input => input.byteLength > 0 && input.byteLength <= BROWSER_QPDF_MAX_INPUT_BYTES),
);
const diagnosticSchema = v.pipe(v.string(), v.maxLength(BROWSER_QPDF_MAX_DIAGNOSTIC_CHARACTERS));

const requestSchema = v.variant('type', [
    v.object({
        id: requestIdSchema,
        type: v.literal('run'),
        payload: v.object({
            command: v.picklist(BROWSER_QPDF_COMMANDS),
            input: inputSchema,
        }),
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('normalize-append-base'),
        payload: v.object({input: inputSchema}),
    }),
]);

export const BROWSER_QPDF_RUN_RESULT_SCHEMA = v.object({
    exitCode: v.pipe(v.number(), v.safeInteger()),
    stdout: diagnosticSchema,
    stderr: diagnosticSchema,
    /** The written file of a rewrite that exited 0 or 3; null otherwise. */
    output: v.nullable(v.custom<Uint8Array>(value => value instanceof Uint8Array)),
});

export const BROWSER_QPDF_NORMALIZE_RESULT_SCHEMA = v.object({
    verdict: v.picklist(BROWSER_APPEND_ADMISSION_VERDICTS),
    /** The rewritten base when the verdict was repairable; null when the input stands. */
    output: v.nullable(v.custom<Uint8Array>(value => value instanceof Uint8Array)),
    stderr: diagnosticSchema,
});

export type TBrowserQpdfEngineRequest = v.InferOutput<typeof requestSchema>;
export type IBrowserQpdfRunResult = v.InferOutput<typeof BROWSER_QPDF_RUN_RESULT_SCHEMA>;
export type IBrowserQpdfNormalizeResult = v.InferOutput<typeof BROWSER_QPDF_NORMALIZE_RESULT_SCHEMA>;

export function parseBrowserQpdfEngineRequest(value: unknown) {
    const parsed = v.safeParse(requestSchema, value, {abortEarly: true});
    return parsed.success ? parsed.output : null;
}
