use crate::protocol::manifest_v3::VERSION;
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
        Self {
            version: VERSION,
            kind: "result",
            result: ResultPayload::Success {
                completed_pages,
                total_pages,
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
