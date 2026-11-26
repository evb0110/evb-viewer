// Generated from evb-pdf-page-ops Rust wire structs; do not edit.
// Regenerate with `EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-pdf-page-ops generated_wire_schema`.

export const PDF_DECRYPT_OUTCOME_FORMAT = 'evb-pdf-decrypt' as const;
export const PDF_DECRYPT_OUTCOME_SCHEMA_VERSION = 1 as const;
export const PDF_PAGE_SIZES_SIDECAR_FORMAT = 'evb-pdf-page-sizes' as const;
export const PDF_PAGE_SIZES_SIDECAR_SCHEMA_VERSION = 1 as const;
export const PDF_PAGE_SIZES_SIDECAR_CHUNK_BYTES = 4194304 as const;

export interface IPdfConformanceFactsWire {
    isSigned: boolean;
    isEncrypted: boolean;
    isTagged: boolean;
    hasAcroForm: boolean;
    hasXfa: boolean;
}

export type TPdfDecryptOutcomeWire =
    | {
        format: typeof PDF_DECRYPT_OUTCOME_FORMAT;
        schemaVersion: typeof PDF_DECRYPT_OUTCOME_SCHEMA_VERSION;
        outcome: 'opened';
        wasEncrypted: false;
        revision: null;
    }
    | {
        format: typeof PDF_DECRYPT_OUTCOME_FORMAT;
        schemaVersion: typeof PDF_DECRYPT_OUTCOME_SCHEMA_VERSION;
        outcome: 'rewritten';
        wasEncrypted: true;
        revision: number | null;
    };

export interface IPdfAnnotationIdentityBindingWire {
    annotationId: string;
    pdfRef: string;
}

export interface IPdfAnnotationDeleteEffectsWire {
    affectedPageIndices: number[];
    deletedReplyRefs: string[];
}

export type TPdfNativeSaveReportWire =
    | IPdfAnnotationIdentityBindingWire[]
    | {
        identityBindings: IPdfAnnotationIdentityBindingWire[];
        annotationDeleteEffects: IPdfAnnotationDeleteEffectsWire;
    };

export type TPdfAppendAdmissionVerdictWire = 'appendable' | 'repairable' | 'limited' | 'unverified';

export type TPdfDesktopAppendAdmissionWire =
    | {
        verdict: 'appendable';
        reason: null;
    }
    | {
        verdict: Exclude<TPdfAppendAdmissionVerdictWire, 'appendable'>;
        reason: string;
    };
