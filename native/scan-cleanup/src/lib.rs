pub mod adapters;
mod analysis;
pub mod auto_dewarp;
pub mod background;
pub mod bw;
mod cache;
#[doc(hidden)]
pub mod calibration;
pub mod cli;
pub mod content;
pub mod deskew;
pub mod dewarp;
pub mod domain;
pub mod engine;
pub mod ink_consistency;
pub mod io;
pub mod mode_select;
mod mrc;
pub mod picture;
pub mod pipeline;
pub mod png;
pub mod protocol;
pub mod split;
pub mod text_tone;

pub use domain::options::*;
// Generated from packages/contracts/nativeToolProtocols.ts. Keeping the CLI
// handshake on this descriptor makes a stale strict-manifest parser fail
// before Electron sends it a request.
pub const HANDSHAKE_VERSION: u32 =
    evb_native_support::generated_native_tool_protocols::SCAN_CLEANUP.protocol_version;
