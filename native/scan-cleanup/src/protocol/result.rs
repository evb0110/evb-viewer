use crate::protocol::manifest_v3::{ResolvedDocumentInkPrior, VERSION};
use evb_native_support::{NativeErrorCode, NativeErrorEnvelope};
use serde::Serialize;

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ResultPayload {
    Success {
        #[serde(rename = "completedPages")]
        completed_pages: usize,
        #[serde(rename = "totalPages")]
        total_pages: usize,
        #[serde(
            rename = "documentInkPrior",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        #[cfg_attr(test, ts(optional))]
        document_ink_prior: Option<ResolvedDocumentInkPrior>,
    },
    Failure {
        code: NativeErrorCode,
        message: String,
    },
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ResultEnvelope {
    pub version: u32,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub result: ResultPayload,
}

impl ResultEnvelope {
    pub fn success(completed_pages: usize, total_pages: usize) -> Self {
        Self::success_with_ink_prior(completed_pages, total_pages, None)
    }

    pub fn success_with_ink_prior(
        completed_pages: usize,
        total_pages: usize,
        document_ink_prior: Option<ResolvedDocumentInkPrior>,
    ) -> Self {
        Self {
            version: VERSION,
            kind: "result",
            result: ResultPayload::Success {
                completed_pages,
                total_pages,
                document_ink_prior,
            },
        }
    }

    pub fn failure(error: &NativeErrorEnvelope) -> Self {
        Self {
            version: VERSION,
            kind: "result",
            result: ResultPayload::Failure {
                code: error.code,
                message: error.message.clone(),
            },
        }
    }
}
