use evb_native_support::{NativeError, NativeErrorCode};

pub(crate) const CANCELLATION_MESSAGE: &str = "Scan-cleanup canceled by SIGTERM";

pub(crate) fn cancellation_error() -> NativeError {
    NativeError::new(NativeErrorCode::Io, CANCELLATION_MESSAGE)
}

pub mod analyze;
pub mod batch_reconciliation;
pub mod output_geometry;
pub mod page_statistics;
pub mod page_workflow;
pub mod prepare;
pub mod render;
pub mod render_plan;
pub mod resource_planning;
pub mod staged_input;
pub mod text_axis;
