use crate::{split::DocumentPrior, CleanupOptions};
use evb_native_support::{bounded_io::deserialize_bounded_vec, NativeError, NativeErrorCode};
use scan_primitives::Point;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};

pub const VERSION: u32 = 3;
pub const MAX_RASTER_WINDOW: usize = 16;
/// A staged-input window is a residency bound, not a queue: it may never grow
/// past the number of pages the sidecar can hold leases for at once.
pub const MAX_STAGED_INPUT_WINDOW: usize = 16;
/// One gigapixel is far above any page a 150-DPI analysis raster can reach and
/// still keeps the declared peak inside the arithmetic the pool sizing uses.
pub const MAX_STAGED_INPUT_PEAK_PIXELS: u64 = 1_000_000_000;
/// Maximum page records admitted in one native process invocation. The
/// Electron/core orchestrator replays this bounded manifest for long source
/// documents, so this is never a document page-count limit.
pub const MAX_MANIFEST_PAGES_PER_BATCH: usize = 20_000;
pub const MAX_MANIFEST_PATH_BYTES: usize = 4_096;

fn deserialize_manifest_pages<'de, D>(deserializer: D) -> Result<Vec<Page>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec::<D, Page, MAX_MANIFEST_PAGES_PER_BATCH>(deserializer)
}

const fn default_raster_window() -> usize {
    1
}

/// Optional diagnostic geometry for a non-straight page seam. The existing
/// cutter and page polygons remain the rendering contract; consumers that do
/// not know about this additive field continue to cut at `cutterXPx`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitSeamPolyline {
    pub points: Vec<Point>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSideConfidence {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDiagnosticRect {
    pub x_px: usize,
    pub y_px: usize,
    pub width_px: usize,
    pub height_px: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentTextMaskSummary {
    pub analysis_width_px: usize,
    pub analysis_height_px: usize,
    pub ink_pixels: usize,
    pub line_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<ContentDiagnosticRect>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContentTrimSide {
    Left,
    Top,
    Right,
    Bottom,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlockEvidence {
    pub bounds: ContentDiagnosticRect,
    pub picture_mask_overlap_pixels: usize,
    pub heading_evidence: bool,
    pub grayscale_evidence: bool,
    #[serde(default)]
    pub text_evidence: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentAcceptedTrim {
    pub side: ContentTrimSide,
    pub iteration: usize,
    pub score: f64,
    pub threshold: f64,
    pub content_distance_sum: f64,
    pub garbage_distance_sum: f64,
    pub removed_blocks: Vec<ContentBlockEvidence>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDiagnostics {
    pub side_confidence: ContentSideConfidence,
    pub text_mask: ContentTextMaskSummary,
    /// Exact analysis-space detector box after every post-trim writer. Export
    /// maps this box through source-pixel support and margin transforms; it is
    /// not the final output crop rectangle. Absent means no detected crop box.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipped_bounds: Option<ContentDiagnosticRect>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted_trims: Vec<ContentAcceptedTrim>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub protected_blocks: Vec<ContentBlockEvidence>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    Analyze,
    Render,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnalysisPurpose {
    /// Retained for direct native `--manifest` callers. The Electron app
    /// emits `page-plan` (or omits this field, which defaults to it).
    Classification,
    #[default]
    PagePlan,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RenderMode {
    Preview,
    Final,
}

pub use crate::domain::geometry::CanvasScope;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
/// The one rectangle and pixel grid every matched output of this document is
/// normalized onto. The owning process measures it from the source page
/// geometry so a preview and the final run place their pages identically.
pub struct DocumentCanvas {
    pub width_points: f64,
    pub height_points: f64,
    pub width_px: usize,
    pub height_px: usize,
}

impl DocumentCanvas {
    /// Pixels per inch of the canvas grid, which is the one output resolution
    /// every page of the document is resampled to.
    pub fn dpi(&self) -> f64 {
        self.width_px as f64 / self.width_points * 72.0
    }

    /// Keeps the document's physical page box while giving a continuous-tone
    /// page the pixel grid it was actually rendered on. Matched page size is a
    /// PDF geometry promise, not permission to inflate every low-resolution
    /// gray/color scan to the finest page's raster dimensions.
    pub fn at_dpi(self, dpi: f64) -> Self {
        Self {
            width_px: ((self.width_points / 72.0 * dpi).round() as usize).max(1),
            height_px: ((self.height_points / 72.0 * dpi).round() as usize).max(1),
            ..self
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOutput {
    pub output_path: PathBuf,
    pub metadata_path: PathBuf,
    #[serde(default)]
    pub bilevel_output_path: Option<PathBuf>,
    #[serde(default)]
    pub background_output_path: Option<PathBuf>,
    #[serde(default)]
    pub foreground_mask_output_path: Option<PathBuf>,
    #[serde(default)]
    pub foreground_alpha_output_path: Option<PathBuf>,
    #[serde(default)]
    pub picture_mask_output_path: Option<PathBuf>,
    #[serde(default)]
    pub tone_preservation_alpha_output_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailPixelRect {
    pub x_px: f64,
    pub y_px: f64,
    pub width_px: f64,
    pub height_px: f64,
}

impl DetailPixelRect {
    pub fn as_rect(&self) -> scan_primitives::Rect {
        scan_primitives::Rect::new(self.x_px, self.y_px, self.width_px, self.height_px)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailRenderPlan {
    pub base_metadata_path: PathBuf,
    pub base_raster_path: PathBuf,
    /// Canonical cleaned base-preview raster for this output half. Detail
    /// rendering replays its source-to-cleaned transfer instead of rebuilding
    /// illumination and text-tone decisions from a viewport crop.
    #[serde(default)]
    pub base_cleaned_raster_path: Option<PathBuf>,
    pub source_crop: DetailPixelRect,
    pub full_source_width_px: usize,
    pub full_source_height_px: usize,
    pub scale: f64,
    pub render_region: DetailPixelRect,
    pub sampled_region: DetailPixelRect,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub input_path: PathBuf,
    /// Fixed-resolution PDF render that owns analysis and Auto-routing.
    /// Raster/image callers omit it because input_path is already canonical.
    #[serde(default)]
    pub analysis_input_path: Option<PathBuf>,
    #[serde(default)]
    pub analysis_dpi: Option<f64>,
    /// White samples in this extracted one-bit PDF soft mask select the
    /// source MRC foreground. It shares input_path's unrotated page grid.
    #[serde(default)]
    pub trusted_foreground_mask_path: Option<PathBuf>,
    /// Native-resolution continuous-tone background extracted from the same
    /// compact MRC page as trusted_foreground_mask_path.
    #[serde(default)]
    pub trusted_mrc_background_path: Option<PathBuf>,
    pub source_page_index: usize,
    pub page_metadata_path: PathBuf,
    /// Any serialized dewarp directrices inside `options` are authored in
    /// source-rotated page coordinates (before deskew, dewarp, and crop).
    pub options: CleanupOptions,
    #[serde(default)]
    pub document_prior: Option<DocumentPrior>,
    #[serde(default)]
    pub detail_render_plan: Option<DetailRenderPlan>,
    pub outputs: Vec<PageOutput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestV3 {
    pub version: u32,
    pub operation: Operation,
    pub analysis_purpose: AnalysisPurpose,
    pub render_mode: RenderMode,
    pub canvas_scope: CanvasScope,
    pub document_canvas: Option<DocumentCanvas>,
    /// Physical memory of the host that authored this manifest. The sidecar has
    /// no portable way to read it, so the owning process reports it here and the
    /// worker pool and stage cache are sized from it. Absent for direct CLI
    /// invocations, which then size themselves conservatively.
    pub host_memory_bytes: Option<u64>,
    /// Bounded streamed-raster look-ahead. Direct CLI callers that do not
    /// coordinate producers retain the one-page acknowledgement turnstile.
    pub raster_window: usize,
    /// Number of Analyze page inputs the owning process keeps staged at once.
    ///
    /// Present only when that process stages replayable page rasters through
    /// the lease protocol: the sidecar announces `page-input-required` for an
    /// absent input, waits for the producer to publish it, and announces
    /// `page-input-released` once it has finished reading it. Because the
    /// producer can always re-render the same deterministic raster, an input
    /// released here is replayable rather than consumed, which is what keeps a
    /// bounded window from changing any classification. Absent means every
    /// Analyze input must already exist, which is the direct-CLI contract.
    pub staged_input_window: Option<usize>,
    /// Largest staged Analyze input the owning process will publish, in pixels.
    ///
    /// The sidecar sizes its page pool from the largest input it can measure,
    /// but under a staged window most inputs are still unrendered when that
    /// decision is made. The producer already knows every page's raster
    /// geometry, so it declares the document's peak here and the memory-derived
    /// bound stays a document fact instead of a staging-order accident.
    pub staged_input_peak_pixels: Option<u64>,
    pub pages: Vec<Page>,
}

const MANIFEST_DIAGNOSTICS_ENV: &str = "EVB_SCAN_CLEANUP_PROTOCOL_DIAGNOSTICS";

fn manifest_diagnostics_enabled() -> bool {
    std::env::var_os(MANIFEST_DIAGNOSTICS_ENV).is_some()
}

#[derive(Default)]
struct ManifestDiagnostics {
    enabled: bool,
    fields: HashSet<String>,
    stderr_lines: Vec<String>,
}

impl ManifestDiagnostics {
    fn from_environment() -> Self {
        Self {
            enabled: manifest_diagnostics_enabled(),
            ..Self::default()
        }
    }

    fn log_unknown_field(&mut self, path: &str) {
        if self.enabled && self.fields.insert(path.to_string()) {
            let line = format!("scan-cleanup manifest ignored unknown field: {path}");
            self.stderr_lines.push(line.clone());
            eprintln!("{line}");
        }
    }
}

fn allowed_manifest_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "manifest" => &[
            "version",
            "operation",
            "analysisPurpose",
            "renderMode",
            "canvasScope",
            "documentCanvas",
            "hostMemoryBytes",
            "rasterWindow",
            "stagedInputWindow",
            "stagedInputPeakPixels",
            "pages",
        ],
        "canvas" => &["widthPoints", "heightPoints", "widthPx", "heightPx"],
        "page" => &[
            "inputPath",
            "analysisInputPath",
            "analysisDpi",
            "trustedForegroundMaskPath",
            "trustedMrcBackgroundPath",
            "sourcePageIndex",
            "pageMetadataPath",
            "options",
            "documentPrior",
            "detailRenderPlan",
            "outputs",
        ],
        "output" => &[
            "outputPath",
            "metadataPath",
            "bilevelOutputPath",
            "backgroundOutputPath",
            "foregroundMaskOutputPath",
            "foregroundAlphaOutputPath",
            "pictureMaskOutputPath",
            "tonePreservationAlphaOutputPath",
        ],
        "detail" => &[
            "baseMetadataPath",
            "baseRasterPath",
            "baseCleanedRasterPath",
            "sourceCrop",
            "fullSourceWidthPx",
            "fullSourceHeightPx",
            "scale",
            "renderRegion",
            "sampledRegion",
        ],
        "rect" => &["xPx", "yPx", "widthPx", "heightPx"],
        "prior" => &[
            "dominantLayout",
            "cutterRatioMedian",
            "clusterDims",
            "agreementStrength",
            "strokeWidthMedianPx",
            "xHeightMedianPx",
        ],
        "cluster" => &["widthPx", "heightPx"],
        "options" => &[
            "dpi",
            "sourceDpi",
            "sourceHasBilevelLayer",
            "sourceBackgroundDpi",
            "trustedSelectionIncomplete",
            "requestedRenderDpi",
            "renderCrop",
            "binarization",
            "thickness",
            "normalizeIllumination",
            "despeckle",
            "despeckleLevel",
            "outputMode",
            "preferSoftAlphaForeground",
            "resolvedTextToneDiagnostics",
            "ocrMode",
            "layout",
            "manualSplit",
            "automaticSplit",
            "manualSkewDegrees",
            "manualContentBoxes",
            "automaticSkewDegrees",
            "automaticContentBoxes",
            "manualZones",
            "cropContent",
            "matchPageSize",
            "pageAlignment",
            "placementOverrides",
            "placementAnchors",
            "margins",
            "dewarp",
            "experimental",
            "rotationDegrees",
            "excluded",
            "skipBlankPages",
            "maxPixels",
            "maxDimensionPx",
        ],
        "normalizedRect" => &[
            "xNormalized",
            "yNormalized",
            "widthNormalized",
            "heightNormalized",
            "rotationDegrees",
        ],
        "normalizedSplit" => &["xNormalized", "rotationDegrees"],
        "contentBoxes" | "placementOverrides" | "placementAnchors" => &["full", "left", "right"],
        "automaticSkew" => &["full", "left", "right"],
        "manualZones" => &["picture", "fill"],
        "pictureZone" => &["polygon", "layer"],
        "polygon" => &["points", "rotationDegrees"],
        "point" => &["x", "y"],
        "normalizedPoint" => &["xNormalized", "yNormalized"],
        "anchor" => &["yNormalized"],
        "margins" => &["leftMm", "topMm", "rightMm", "bottomMm"],
        "dewarp" => &["topCurve", "bottomCurve", "depth"],
        "experimental" => &["autoDewarp", "autoDewarpDepth"],
        "textDiagnostics" => &["full", "left", "right"],
        "textDiagnostic" => &[
            "applied",
            "rule",
            "textLineCount",
            "textInkPixels",
            "pictureFraction",
            "outsideMidtoneFraction",
            "outsideMidtoneLargestComponentFraction",
            "outsideMidtoneLargestComponentWidthFraction",
            "outsideMidtoneLargestComponentHeightFraction",
            "inkAnchor",
            "blackPoint",
            "slope",
        ],
        _ => &[],
    }
}

fn sanitize_manifest_value(
    value: &mut serde_json::Value,
    kind: &str,
    path: &str,
    diagnostics: &mut ManifestDiagnostics,
) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let allowed = allowed_manifest_fields(kind);
    let unknown = object
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    for key in unknown {
        object.remove(&key);
        diagnostics.log_unknown_field(&format!("{path}.{key}"));
    }
    let child_kind = |key: &str| match (kind, key) {
        ("manifest", "documentCanvas") => Some("canvas"),
        ("manifest", "pages") => Some("page[]"),
        ("page", "options") => Some("options"),
        ("page", "documentPrior") => Some("prior"),
        ("page", "detailRenderPlan") => Some("detail"),
        ("page", "outputs") => Some("output[]"),
        ("detail", "sourceCrop" | "renderRegion" | "sampledRegion") => Some("rect"),
        ("prior", "clusterDims") => Some("cluster"),
        ("options", "renderCrop") => Some("normalizedRect"),
        ("options", "manualSplit" | "automaticSplit") => Some("normalizedSplit"),
        ("options", "manualContentBoxes" | "automaticContentBoxes") => Some("contentBoxes"),
        ("options", "automaticSkewDegrees") => Some("automaticSkew"),
        ("options", "manualZones") => Some("manualZones"),
        ("options", "placementOverrides") => Some("placementOverrides"),
        ("options", "placementAnchors") => Some("placementAnchors"),
        ("options", "margins") => Some("margins"),
        ("options", "dewarp") => Some("dewarp"),
        ("options", "experimental") => Some("experimental"),
        ("options", "resolvedTextToneDiagnostics") => Some("textDiagnostics"),
        ("contentBoxes" | "automaticSkew" | "placementOverrides", "full" | "left" | "right") => {
            Some(if kind == "placementOverrides" {
                "scalar"
            } else {
                "normalizedRect"
            })
        }
        ("placementAnchors", "full" | "left" | "right") => Some("anchor"),
        ("manualZones", "picture") => Some("pictureZone[]"),
        ("manualZones", "fill") => Some("polygon[]"),
        ("pictureZone", "polygon") => Some("polygon"),
        ("polygon", "points") => Some("normalizedPoint[]"),
        ("dewarp", "topCurve" | "bottomCurve") => Some("point[]"),
        ("textDiagnostics", "full" | "left" | "right") => Some("textDiagnostic"),
        ("polygon", "rotationDegrees") => Some("scalar"),
        _ => None,
    };
    for (key, child) in object.iter_mut() {
        let Some(child_kind) = child_kind(key) else {
            continue;
        };
        let child_path = format!("{path}.{key}");
        if let Some(array_kind) = child_kind.strip_suffix("[]") {
            if let Some(items) = child.as_array_mut() {
                for (index, item) in items.iter_mut().enumerate() {
                    sanitize_manifest_value(
                        item,
                        array_kind,
                        &format!("{child_path}[{index}]"),
                        diagnostics,
                    );
                }
            }
        } else if child_kind != "scalar" {
            sanitize_manifest_value(child, child_kind, &child_path, diagnostics);
        }
    }
}

fn deserialize_manifest_value(
    mut value: serde_json::Value,
    diagnostics: &mut ManifestDiagnostics,
) -> Result<ManifestV3, String> {
    sanitize_manifest_value(&mut value, "manifest", "$", diagnostics);
    ManifestV3Wire::deserialize(value)
        .map(Into::into)
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestV3Wire {
    version: u32,
    operation: Operation,
    #[serde(default)]
    analysis_purpose: AnalysisPurpose,
    render_mode: RenderMode,
    canvas_scope: CanvasScope,
    #[serde(default)]
    document_canvas: Option<DocumentCanvas>,
    #[serde(default)]
    host_memory_bytes: Option<u64>,
    #[serde(default = "default_raster_window")]
    raster_window: usize,
    #[serde(default)]
    staged_input_window: Option<usize>,
    #[serde(default)]
    staged_input_peak_pixels: Option<u64>,
    #[serde(deserialize_with = "deserialize_manifest_pages")]
    pages: Vec<Page>,
}

impl From<ManifestV3Wire> for ManifestV3 {
    fn from(value: ManifestV3Wire) -> Self {
        Self {
            version: value.version,
            operation: value.operation,
            analysis_purpose: value.analysis_purpose,
            render_mode: value.render_mode,
            canvas_scope: value.canvas_scope,
            document_canvas: value.document_canvas,
            host_memory_bytes: value.host_memory_bytes,
            raster_window: value.raster_window,
            staged_input_window: value.staged_input_window,
            staged_input_peak_pixels: value.staged_input_peak_pixels,
            pages: value.pages,
        }
    }
}

impl<'de> Deserialize<'de> for ManifestV3 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut diagnostics = ManifestDiagnostics::from_environment();
        let value = serde_json::Value::deserialize(deserializer)?;
        deserialize_manifest_value(value, &mut diagnostics).map_err(serde::de::Error::custom)
    }
}

impl ManifestV3 {
    pub fn validate(&self) -> Result<(), NativeError> {
        if self.version != VERSION {
            return Err(invalid(format!(
                "Unsupported scan-cleanup manifest version {}; expected {VERSION}",
                self.version
            )));
        }
        if self.pages.is_empty() {
            return Err(invalid("Batch manifest contains no pages"));
        }
        if self.pages.len() > MAX_MANIFEST_PAGES_PER_BATCH {
            return Err(NativeError::new(
                NativeErrorCode::TooLarge,
                format!(
                    "Native scan-cleanup manifest batch exceeds the {MAX_MANIFEST_PAGES_PER_BATCH}-page admission limit"
                ),
            ));
        }
        if self.document_canvas.is_some_and(|canvas| {
            !canvas.width_points.is_finite()
                || canvas.width_points <= 0.0
                || !canvas.height_points.is_finite()
                || canvas.height_points <= 0.0
                || canvas.width_px == 0
                || canvas.height_px == 0
        }) {
            return Err(invalid(
                "Document canvas dimensions must be positive finite points and pixels",
            ));
        }
        if self.host_memory_bytes == Some(0) {
            return Err(invalid("Host memory must be a positive byte count"));
        }
        if !(1..=MAX_RASTER_WINDOW).contains(&self.raster_window) {
            return Err(invalid(format!(
                "Raster window must be between 1 and {MAX_RASTER_WINDOW}",
            )));
        }
        if let Some(window) = self.staged_input_window {
            if self.operation != Operation::Analyze {
                return Err(invalid(
                    "stagedInputWindow is only valid for analyze manifests",
                ));
            }
            if !(1..=MAX_STAGED_INPUT_WINDOW).contains(&window) {
                return Err(invalid(format!(
                    "Staged input window must be between 1 and {MAX_STAGED_INPUT_WINDOW}",
                )));
            }
        }
        match (self.staged_input_window, self.staged_input_peak_pixels) {
            (Some(_), Some(pixels)) if (1..=MAX_STAGED_INPUT_PEAK_PIXELS).contains(&pixels) => {}
            (Some(_), None) | (None, None) => {}
            (None, Some(_)) => {
                return Err(invalid(
                    "stagedInputPeakPixels requires a stagedInputWindow",
                ));
            }
            (Some(_), Some(_)) => {
                return Err(invalid(format!(
                    "Staged input peak pixels must be between 1 and {MAX_STAGED_INPUT_PEAK_PIXELS}",
                )));
            }
        }
        if self.operation == Operation::Render
            && self.document_canvas.is_none()
            && self
                .pages
                .iter()
                .any(|page| page.options.match_page_size && !page.options.ocr_mode)
        {
            return Err(invalid(
                "A matched page-size render requires a documentCanvas plan",
            ));
        }
        if self.operation != Operation::Analyze
            && self.analysis_purpose != AnalysisPurpose::PagePlan
        {
            return Err(invalid(
                "analysisPurpose is only valid for analyze manifests",
            ));
        }
        for page in &self.pages {
            let page_number = page.source_page_index.saturating_add(1);
            if self.operation == Operation::Analyze {
                validate_existing_regular_path(&page.input_path, page_number, "inputPath")?;
            }
            for (field, path) in [
                ("analysisInputPath", page.analysis_input_path.as_deref()),
                (
                    "trustedForegroundMaskPath",
                    page.trusted_foreground_mask_path.as_deref(),
                ),
                (
                    "trustedMrcBackgroundPath",
                    page.trusted_mrc_background_path.as_deref(),
                ),
            ] {
                if let Some(path) = path {
                    validate_existing_regular_path(path, page_number, field)?;
                }
            }
            match (page.analysis_input_path.as_ref(), page.analysis_dpi) {
                (Some(_), Some(dpi)) if dpi.is_finite() && dpi > 0.0 => {}
                (None, None) => {}
                _ => {
                    return Err(invalid(
                        "analysisInputPath and a positive finite analysisDpi must be provided together",
                    ));
                }
            }
            page.options.validate().map_err(|error| {
                invalid(format!(
                    "Page {}: {error}",
                    page.source_page_index.saturating_add(1),
                ))
            })?;
            if page.options.render_crop.is_some()
                && (self.operation != Operation::Render || self.render_mode != RenderMode::Preview)
            {
                return Err(invalid(
                    "Render crop is supported only by preview render manifests",
                ));
            }
            if page.options.render_crop.is_some() && page.options.match_page_size {
                return Err(invalid(
                    "Render crop cannot be combined with matched page-size output",
                ));
            }
            if let Some(detail) = &page.detail_render_plan {
                if self.operation != Operation::Render || self.render_mode != RenderMode::Preview {
                    return Err(invalid(
                        "Detail source rendering is supported only by preview render manifests",
                    ));
                }
                if page.options.render_crop.is_some() || page.options.match_page_size {
                    return Err(invalid(
                        "Detail source rendering cannot combine with render crop or matched page size",
                    ));
                }
                if !detail.scale.is_finite()
                    || detail.scale <= 0.0
                    || detail.full_source_width_px == 0
                    || detail.full_source_height_px == 0
                    || !valid_detail_rect(&detail.source_crop)
                    || !valid_detail_rect(&detail.render_region)
                    || !valid_detail_rect(&detail.sampled_region)
                {
                    return Err(invalid("Detail render plan dimensions are invalid"));
                }
                let source = detail.source_crop.as_rect();
                if source.right() > detail.full_source_width_px as f64
                    || source.bottom() > detail.full_source_height_px as f64
                {
                    return Err(invalid("Detail source crop exceeds the full source raster"));
                }
                let render = detail.render_region.as_rect();
                let sampled = detail.sampled_region.as_rect();
                if render.x < sampled.x
                    || render.y < sampled.y
                    || render.right() > sampled.right()
                    || render.bottom() > sampled.bottom()
                {
                    return Err(invalid(
                        "Detail render region must be contained by the sampled region",
                    ));
                }
            }
            if let Some(prior) = page.document_prior {
                prior.validate().map_err(invalid)?;
            }
            if self.operation == Operation::Render && page.outputs.is_empty() {
                return Err(invalid(
                    "Render page requires at least one output destination",
                ));
            }
        }
        for path in self
            .input_paths()
            .into_iter()
            .chain(self.destination_paths())
        {
            if path.as_os_str().to_string_lossy().len() > MAX_MANIFEST_PATH_BYTES {
                return Err(NativeError::new(
                    NativeErrorCode::TooLarge,
                    format!(
                        "Manifest path exceeds the {MAX_MANIFEST_PATH_BYTES}-byte admission ceiling"
                    ),
                ));
            }
        }
        self.validate_destination_paths()?;
        Ok(())
    }

    /// Validate the filesystem contract before starting a native operation.
    ///
    /// Analyze pages are replayed by more than one native stage, so their
    /// primary input must already be an existing regular file. Render keeps
    /// its one-shot FIFO input contract, and producer-created auxiliary paths
    /// remain optional until the corresponding Render stage consumes them.
    ///
    /// A manifest that declares `stagedInputWindow` is the one exception: its
    /// owning process stages a bounded window of replayable rasters and
    /// publishes each page on request, so an input that is absent at admission
    /// is expected rather than missing. Replayability is preserved because the
    /// producer re-renders the identical raster whenever the sidecar asks for
    /// it again.
    pub(crate) fn validate_for_execution(&self) -> Result<(), NativeError> {
        self.validate()?;
        for path in self
            .input_paths()
            .into_iter()
            .chain(self.destination_paths())
        {
            if !path.is_absolute() {
                return Err(invalid(format!(
                    "Manifest path must be absolute: {}",
                    path.display()
                )));
            }
        }
        if self.operation == Operation::Analyze && self.staged_input_window.is_none() {
            for page in &self.pages {
                validate_required_regular_path(
                    &page.input_path,
                    page.source_page_index.saturating_add(1),
                    "inputPath",
                )?;
            }
        }
        Ok(())
    }

    /// Every path the batch may read. Keeping this list beside the wire
    /// protocol prevents new auxiliary inputs from being missed by the output
    /// alias preflight.
    pub(crate) fn input_paths(&self) -> Vec<&Path> {
        self.pages
            .iter()
            .flat_map(|page| {
                let mut paths = vec![page.input_path.as_path()];
                paths.extend(page.analysis_input_path.as_deref());
                paths.extend(page.trusted_foreground_mask_path.as_deref());
                paths.extend(page.trusted_mrc_background_path.as_deref());
                if let Some(detail) = &page.detail_render_plan {
                    paths.push(detail.base_metadata_path.as_path());
                    paths.push(detail.base_raster_path.as_path());
                    paths.extend(detail.base_cleaned_raster_path.as_deref());
                }
                paths
            })
            .collect()
    }

    /// Every path the batch may publish, including per-page metadata and all
    /// optional layered outputs.
    pub(crate) fn destination_paths(&self) -> Vec<&Path> {
        self.pages
            .iter()
            .flat_map(|page| {
                let mut paths = vec![page.page_metadata_path.as_path()];
                if self.operation == Operation::Render {
                    for output in &page.outputs {
                        paths.push(output.output_path.as_path());
                        paths.push(output.metadata_path.as_path());
                        paths.extend(output.bilevel_output_path.as_deref());
                        paths.extend(output.background_output_path.as_deref());
                        paths.extend(output.foreground_mask_output_path.as_deref());
                        paths.extend(output.foreground_alpha_output_path.as_deref());
                        paths.extend(output.picture_mask_output_path.as_deref());
                        paths.extend(output.tone_preservation_alpha_output_path.as_deref());
                    }
                }
                paths
            })
            .collect()
    }

    fn validate_destination_paths(&self) -> Result<(), NativeError> {
        let inputs = self
            .input_paths()
            .into_iter()
            .map(normalized_path)
            .collect::<HashSet<_>>();
        let mut destinations = HashSet::new();
        for path in self.destination_paths() {
            let normalized = normalized_path(path);
            if inputs.contains(&normalized) {
                return Err(invalid(format!(
                    "Output destination aliases an input path: {}",
                    path.display()
                )));
            }
            if !destinations.insert(normalized) {
                return Err(invalid(format!(
                    "Output destinations must be unique: {}",
                    path.display()
                )));
            }
        }
        Ok(())
    }
}

/// Render may receive a one-shot FIFO through `inputPath`, but every other
/// raster the native worker may read must be replayable. Producer-created
/// files can legitimately be absent during shape validation, so only an
/// existing path is checked here; execution admission applies the stricter
/// Analyze input contract below.
fn validate_existing_regular_path(
    path: &Path,
    page_number: usize,
    field: &str,
) -> Result<(), NativeError> {
    validate_regular_path(path, page_number, field, true)
}

fn validate_required_regular_path(
    path: &Path,
    page_number: usize,
    field: &str,
) -> Result<(), NativeError> {
    validate_regular_path(path, page_number, field, false)
}

fn validate_regular_path(
    path: &Path,
    page_number: usize,
    field: &str,
    allow_missing: bool,
) -> Result<(), NativeError> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(invalid(format!(
            "Page {page_number} {field} must be a regular file"
        ))),
        Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(invalid(format!(
            "Page {page_number} {field} must be an existing regular file: {error}"
        ))),
    }
}

pub(crate) fn normalized_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    #[cfg(windows)]
    {
        // Windows paths are case-insensitive for the desktop filesystems we
        // support. Canonical/inode checks in the adapter provide the stronger
        // check for paths which already exist.
        return PathBuf::from(normalized.to_string_lossy().to_lowercase());
    }
    #[cfg(not(windows))]
    normalized
}

fn valid_detail_rect(rect: &DetailPixelRect) -> bool {
    rect.x_px.is_finite()
        && rect.y_px.is_finite()
        && rect.width_px.is_finite()
        && rect.height_px.is_finite()
        && rect.x_px >= 0.0
        && rect.y_px >= 0.0
        && rect.width_px > 0.0
        && rect.height_px > 0.0
}

fn invalid(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::InvalidRequest, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_canvas_can_keep_points_without_upscaling_continuous_tone_pixels() {
        let canvas = DocumentCanvas {
            width_points: 612.0,
            height_points: 792.0,
            width_px: 2_550,
            height_px: 3_300,
        };
        let at_source_dpi = canvas.at_dpi(100.0);
        assert_eq!(at_source_dpi.width_px, 850);
        assert_eq!(at_source_dpi.height_px, 1_100);
        assert_eq!(at_source_dpi.width_points, 612.0);
        assert_eq!(at_source_dpi.height_points, 792.0);
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SplitGeometryResult {
        cutter_x_px: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        split_seam: Option<SplitSeamPolyline>,
    }

    #[test]
    fn shared_golden_manifests_deserialize_and_validate() {
        let fixture_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protocol");
        for name in [
            "preview-raster-v3.json",
            "detect-all-v3.json",
            "raster-final-v3.json",
            "lossless-final-v3.json",
            "populated-raster-v3.json",
        ] {
            let bytes = std::fs::read(fixture_dir.join(name)).unwrap();
            let manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
            manifest.validate().unwrap();
        }
    }

    #[test]
    fn shipped_skew_fixtures_round_trip_through_the_same_manifest_contract() {
        let fixture_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol-fixtures");
        let older = serde_json::from_slice::<ManifestV3>(
            &std::fs::read(fixture_dir.join("scan-cleanup-manifest-v3-older-to-newer.json"))
                .unwrap(),
        )
        .unwrap();
        let newer = serde_json::from_slice::<ManifestV3>(
            &std::fs::read(fixture_dir.join("scan-cleanup-manifest-v3-newer-to-older.json"))
                .unwrap(),
        )
        .unwrap();
        older.validate().unwrap();
        newer.validate().unwrap();
        assert_eq!(
            serde_json::to_value(&older).unwrap(),
            serde_json::to_value(&newer).unwrap(),
        );
        assert_eq!(older.pages.len(), newer.pages.len());
        assert_eq!(older.pages[0].input_path, newer.pages[0].input_path);
        assert_eq!(
            serde_json::to_value(&older.pages[0].options).unwrap(),
            serde_json::to_value(&newer.pages[0].options).unwrap(),
        );
    }

    #[test]
    fn additive_manifest_fields_preserve_every_authored_option() {
        let fixture = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/populated-raster-v3.json"),
        )
        .unwrap();
        let baseline: ManifestV3 = serde_json::from_slice(&fixture).unwrap();
        let mut additive: serde_json::Value = serde_json::from_slice(&fixture).unwrap();
        let root = additive.as_object_mut().unwrap();
        root.insert(
            "futureRootField".into(),
            serde_json::json!({"ignored": true}),
        );
        let page = &mut root["pages"][0];
        page.as_object_mut()
            .unwrap()
            .insert("futurePageField".into(), serde_json::json!(true));
        page["options"]
            .as_object_mut()
            .unwrap()
            .insert("futureOptionField".into(), serde_json::json!("ignored"));
        page["options"]["experimental"]
            .as_object_mut()
            .unwrap()
            .insert("futureExperimentalField".into(), serde_json::json!(7));

        let parsed: ManifestV3 = serde_json::from_value(additive).unwrap();
        assert_eq!(
            serde_json::to_value(&baseline).unwrap(),
            serde_json::to_value(&parsed).unwrap(),
        );
    }

    #[test]
    fn manifest_page_limit_is_per_batch_and_page_numbers_have_no_20000_cap() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.pages[0].source_page_index = MAX_MANIFEST_PAGES_PER_BATCH;
        manifest.validate().unwrap();

        manifest.pages =
            std::iter::repeat_n(manifest.pages[0].clone(), MAX_MANIFEST_PAGES_PER_BATCH + 1)
                .collect();
        let error = manifest.validate().unwrap_err();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(error.message.contains("manifest batch"));
    }

    #[test]
    fn additive_unknown_fields_are_ignored_at_every_manifest_level() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"in.png","sourcePageIndex":0,"pageMetadataPath":"page.json",
              "outputs":[],"options":{"unknownOption":true}}]
        }"#;
        let field_free = json.replace(",\"options\":{\"unknownOption\":true}", ",\"options\":{}");
        let with_nested_unknown = json.replace(
            "\"unknownOption\":true",
            "\"unknownOption\":true,\"nested\":{\"unknown\":true}",
        );
        let baseline = serde_json::from_str::<ManifestV3>(&field_free).unwrap();
        let nested = serde_json::from_str::<ManifestV3>(&with_nested_unknown).unwrap();
        assert_eq!(nested.pages.len(), baseline.pages.len());
        assert_eq!(nested.pages[0].input_path, baseline.pages[0].input_path);
        let root_unknown = json.replace("\"pages\"", "\"unknownRoot\":true,\"pages\"");
        assert!(serde_json::from_str::<ManifestV3>(&root_unknown).is_ok());
        let page_unknown = json.replace("\"outputs\":[]", "\"unknownPage\":true,\"outputs\":[]");
        assert!(serde_json::from_str::<ManifestV3>(&page_unknown).is_ok());
    }

    #[test]
    fn duplicate_known_keys_use_materialized_last_value_and_remain_validation_visible() {
        let duplicate_version = r#"{
            "version":3,"version":2,"operation":"analyze","renderMode":"preview",
            "canvasScope":"page","pages":[]
        }"#;
        let manifest: ManifestV3 = serde_json::from_str(duplicate_version).unwrap();

        assert_eq!(manifest.version, 2);
        let error = manifest.validate().unwrap_err();
        assert_eq!(error.code, NativeErrorCode::InvalidRequest);
        assert!(error
            .message
            .contains("Unsupported scan-cleanup manifest version 2"));
    }

    #[test]
    fn diagnostics_are_opt_in_and_deduplicate_unknown_paths_per_run() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "futureRoot":true,"pages":[{"inputPath":"in.png","sourcePageIndex":0,
            "pageMetadataPath":"page.json","futurePage":true,"outputs":[],"options":{}}]
        }"#;
        let mut disabled = ManifestDiagnostics {
            enabled: false,
            ..ManifestDiagnostics::default()
        };
        let disabled_value: serde_json::Value = serde_json::from_str(json).unwrap();
        deserialize_manifest_value(disabled_value, &mut disabled).unwrap();
        assert!(disabled.stderr_lines.is_empty());

        let mut first_run = ManifestDiagnostics {
            enabled: true,
            ..ManifestDiagnostics::default()
        };
        let first_value: serde_json::Value = serde_json::from_str(json).unwrap();
        deserialize_manifest_value(first_value, &mut first_run).unwrap();
        assert_eq!(first_run.stderr_lines.len(), 2);
        assert_eq!(
            first_run.stderr_lines[0],
            "scan-cleanup manifest ignored unknown field: $.futureRoot"
        );
        first_run.log_unknown_field("$.futureRoot");
        assert_eq!(first_run.stderr_lines.len(), 2);

        let mut second_run = ManifestDiagnostics {
            enabled: true,
            ..ManifestDiagnostics::default()
        };
        let second_value: serde_json::Value = serde_json::from_str(json).unwrap();
        deserialize_manifest_value(second_value, &mut second_run).unwrap();
        assert_eq!(second_run.stderr_lines, first_run.stderr_lines);
    }

    #[test]
    fn additive_option_defaults_are_derived_when_new_fields_are_absent() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[
              {"inputPath":"enabled.png","sourcePageIndex":0,"pageMetadataPath":"enabled.json",
               "outputs":[],"options":{"despeckle":true}},
              {"inputPath":"disabled.png","sourcePageIndex":1,"pageMetadataPath":"disabled.json",
               "outputs":[],"options":{"despeckle":false}}
            ]
        }"#;
        let manifest: ManifestV3 = serde_json::from_str(json).unwrap();

        assert_eq!(
            manifest.pages[0].options.effective_despeckle_level(),
            crate::DespeckleLevel::Normal
        );
        assert_eq!(
            manifest.pages[1].options.effective_despeckle_level(),
            crate::DespeckleLevel::Off
        );
        for page in &manifest.pages {
            assert_eq!(page.options.render_crop, None);
            assert!(page.options.manual_zones.picture.is_empty());
            assert!(page.options.manual_zones.fill.is_empty());
            assert_eq!(page.options.manual_skew_degrees, None);
            assert_eq!(page.options.experimental.auto_dewarp_depth, None);
        }
    }

    #[test]
    fn direct_manifests_default_to_page_plan_and_retain_classification_purpose() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"in.png","sourcePageIndex":0,"pageMetadataPath":"page.json",
              "outputs":[],"options":{}}
            ]
        }"#;
        let page_plan: ManifestV3 = serde_json::from_str(json).unwrap();
        page_plan.validate().unwrap();
        assert_eq!(page_plan.analysis_purpose, AnalysisPurpose::PagePlan);

        let classification_json = json.replace(
            "\"pages\"",
            "\"analysisPurpose\":\"classification\",\"pages\"",
        );
        let classification: ManifestV3 = serde_json::from_str(&classification_json).unwrap();
        classification.validate().unwrap();
        assert_eq!(
            classification.analysis_purpose,
            AnalysisPurpose::Classification
        );
    }

    #[test]
    fn option_validation_error_names_the_source_page() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"in.png","sourcePageIndex":336,"pageMetadataPath":"page.json",
              "outputs":[],"options":{"automaticContentBoxes":{"right":{
                "xNormalized":0.72,"yNormalized":0.1,"widthNormalized":0.29,
                "heightNormalized":0.8,"rotationDegrees":0
              }}}}]
        }"#;
        let manifest: ManifestV3 = serde_json::from_str(json).unwrap();
        let error = manifest.validate().unwrap_err().to_string();

        assert!(error.contains("Page 337"));
        assert!(error.contains("automatic right content box"));
    }

    #[test]
    fn host_memory_and_raster_window_are_bounded_additive_fields() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"in.png","sourcePageIndex":0,"pageMetadataPath":"page.json",
              "outputs":[],"options":{}}]
        }"#;
        let absent: ManifestV3 = serde_json::from_str(json).unwrap();
        absent.validate().unwrap();
        assert_eq!(absent.host_memory_bytes, None);
        assert_eq!(absent.raster_window, 1);

        let reported: ManifestV3 = serde_json::from_str(
            &json.replace("\"pages\"", "\"hostMemoryBytes\":34359738368,\"pages\""),
        )
        .unwrap();
        reported.validate().unwrap();
        assert_eq!(reported.host_memory_bytes, Some(34_359_738_368));

        let zeroed: ManifestV3 =
            serde_json::from_str(&json.replace("\"pages\"", "\"hostMemoryBytes\":0,\"pages\""))
                .unwrap();
        assert!(zeroed
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Host memory"));

        let windowed: ManifestV3 =
            serde_json::from_str(&json.replace("\"pages\"", "\"rasterWindow\":3,\"pages\""))
                .unwrap();
        windowed.validate().unwrap();
        assert_eq!(windowed.raster_window, 3);

        let oversized: ManifestV3 =
            serde_json::from_str(&json.replace("\"pages\"", "\"rasterWindow\":17,\"pages\""))
                .unwrap();
        assert!(oversized
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Raster window"));
    }

    #[test]
    fn staged_input_window_is_an_analyze_only_bounded_additive_field() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"in.png","sourcePageIndex":0,"pageMetadataPath":"page.json",
              "outputs":[],"options":{}}]
        }"#;
        let absent: ManifestV3 = serde_json::from_str(json).unwrap();
        absent.validate().unwrap();
        assert_eq!(absent.staged_input_window, None);
        assert_eq!(absent.staged_input_peak_pixels, None);

        let windowed: ManifestV3 = serde_json::from_str(&json.replace(
            "\"pages\"",
            "\"stagedInputWindow\":4,\"stagedInputPeakPixels\":7000000,\"pages\"",
        ))
        .unwrap();
        windowed.validate().unwrap();
        assert_eq!(windowed.staged_input_window, Some(4));
        assert_eq!(windowed.staged_input_peak_pixels, Some(7_000_000));

        let oversized: ManifestV3 =
            serde_json::from_str(&json.replace("\"pages\"", "\"stagedInputWindow\":17,\"pages\""))
                .unwrap();
        assert!(oversized
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Staged input window"));

        let empty: ManifestV3 =
            serde_json::from_str(&json.replace("\"pages\"", "\"stagedInputWindow\":0,\"pages\""))
                .unwrap();
        assert!(empty
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Staged input window"));

        let unwindowed_peak: ManifestV3 = serde_json::from_str(
            &json.replace("\"pages\"", "\"stagedInputPeakPixels\":7000000,\"pages\""),
        )
        .unwrap();
        assert!(unwindowed_peak
            .validate()
            .unwrap_err()
            .to_string()
            .contains("requires a stagedInputWindow"));

        let oversized_peak: ManifestV3 = serde_json::from_str(&json.replace(
            "\"pages\"",
            "\"stagedInputWindow\":4,\"stagedInputPeakPixels\":1000000001,\"pages\"",
        ))
        .unwrap();
        assert!(oversized_peak
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Staged input peak pixels"));

        let rendering: ManifestV3 = serde_json::from_str(
            &json
                .replace("\"operation\":\"analyze\"", "\"operation\":\"render\"")
                .replace(
                    "\"outputs\":[]",
                    "\"outputs\":[{\"outputPath\":\"out.png\",\"metadataPath\":\"out.json\"}]",
                )
                .replace("\"pages\"", "\"stagedInputWindow\":4,\"pages\""),
        )
        .unwrap();
        assert!(rendering
            .validate()
            .unwrap_err()
            .to_string()
            .contains("only valid for analyze manifests"));
    }

    /// Whole-document staging is the direct-CLI contract, and a staged window
    /// is the one documented exception to it.
    #[test]
    fn only_a_staged_window_admits_an_analyze_input_that_is_not_on_disk_yet() {
        let json = r#"{
            "version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page",
            "pages":[{"inputPath":"absent-page.png","sourcePageIndex":0,
              "pageMetadataPath":"page.json","outputs":[],"options":{}}]
        }"#;
        let direct: ManifestV3 = serde_json::from_str(json).unwrap();
        assert!(direct
            .validate_for_execution()
            .unwrap_err()
            .to_string()
            .contains("must be an existing regular file"));

        let staged: ManifestV3 =
            serde_json::from_str(&json.replace("\"pages\"", "\"stagedInputWindow\":2,\"pages\""))
                .unwrap();
        staged.validate_for_execution().unwrap();
    }

    #[test]
    fn execution_rejects_relative_manifest_paths() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.pages[0].input_path = PathBuf::from("relative-input.png");

        let error = manifest.validate_for_execution().unwrap_err();
        assert!(error.message.contains("must be absolute"));
    }

    #[test]
    fn output_destinations_are_unique_and_disjoint_from_every_input() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();

        let mut input_alias = manifest.clone();
        input_alias.pages[0].outputs[0].output_path =
            PathBuf::from("/fixtures/input/temporary/../page-1.png");
        assert!(input_alias
            .validate()
            .unwrap_err()
            .to_string()
            .contains("aliases an input"));

        let mut alpha_alias = manifest;
        alpha_alias.pages[0].outputs[0].foreground_alpha_output_path =
            Some(alpha_alias.pages[0].outputs[0].metadata_path.clone());
        assert!(alpha_alias
            .validate()
            .unwrap_err()
            .to_string()
            .contains("must be unique"));
    }

    #[test]
    fn manifest_paths_have_the_native_protocol_byte_ceiling() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.pages[0].input_path = PathBuf::from("x".repeat(MAX_MANIFEST_PATH_BYTES + 1));

        let error = manifest.validate().unwrap_err();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(error.message.contains("4096-byte admission ceiling"));
    }

    #[test]
    fn canonical_analysis_input_and_dpi_are_a_required_pair() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();

        manifest.pages[0].analysis_input_path = Some(PathBuf::from("analysis.ppm"));
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("analysisInputPath and a positive finite analysisDpi"));

        manifest.pages[0].analysis_dpi = Some(150.0);
        manifest.validate().unwrap();

        manifest.pages[0].analysis_dpi = Some(0.0);
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("positive finite"));
    }

    #[test]
    fn analyze_rejects_nonregular_input_but_render_keeps_stream_input_allowed() {
        let scratch = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-manifest-contract-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        let nonregular = scratch.join("input-directory");
        std::fs::create_dir(&nonregular).unwrap();

        let analyze_bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/detect-all-v3.json"),
        )
        .unwrap();
        let mut analyze: ManifestV3 = serde_json::from_slice(&analyze_bytes).unwrap();
        analyze.pages[0].input_path = nonregular.clone();
        let input_error = analyze.validate().unwrap_err();
        assert!(input_error.message.contains("Page 1"));
        assert!(input_error.message.contains("inputPath"));
        assert!(input_error.message.contains("regular file"));

        let mut missing_analyze = analyze.clone();
        missing_analyze.pages[0].input_path = scratch.join("missing-input.png");
        missing_analyze.validate().unwrap();
        let missing_error = missing_analyze.validate_for_execution().unwrap_err();
        assert!(missing_error.message.contains("Page 1"));
        assert!(missing_error.message.contains("inputPath"));
        assert!(missing_error.message.contains("existing regular file"));

        let render_bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut render: ManifestV3 = serde_json::from_slice(&render_bytes).unwrap();
        render.pages[0].input_path = nonregular.clone();
        render.pages[0].analysis_input_path = Some(nonregular.clone());
        render.pages[0].analysis_dpi = Some(150.0);
        let analysis_error = render.validate().unwrap_err();
        assert!(analysis_error.message.contains("Page 1"));
        assert!(analysis_error.message.contains("analysisInputPath"));
        assert!(analysis_error.message.contains("regular file"));

        render.pages[0].analysis_input_path = None;
        render.pages[0].analysis_dpi = None;
        render.pages[0].trusted_foreground_mask_path = Some(nonregular.clone());
        let trusted_error = render.validate().unwrap_err();
        assert!(trusted_error.message.contains("Page 1"));
        assert!(trusted_error.message.contains("trustedForegroundMaskPath"));
        assert!(trusted_error.message.contains("regular file"));

        render.pages[0].trusted_foreground_mask_path = None;
        render.validate_for_execution().unwrap();

        let _ = std::fs::remove_dir_all(scratch);
    }

    #[test]
    fn render_crop_is_additive_and_preview_only() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.validate().unwrap();
        assert_eq!(
            manifest.pages[0].options.render_crop,
            Some(crate::NormalizedRect {
                x: 0.25,
                y: 0.2,
                width: 0.5,
                height: 0.4,
                rotation: crate::OrthogonalRotation::None,
            })
        );

        manifest.render_mode = RenderMode::Final;
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("preview render"));

        manifest.render_mode = RenderMode::Preview;
        manifest.pages[0].options.match_page_size = true;
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("matched page-size"));
    }

    #[test]
    fn manifest_validation_rejects_self_intersecting_manual_zone_polygon() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.pages[0].options.manual_zones.fill = vec![crate::NormalizedZonePolygon {
            points: vec![
                crate::NormalizedZonePoint { x: 0.1, y: 0.1 },
                crate::NormalizedZonePoint { x: 0.9, y: 0.9 },
                crate::NormalizedZonePoint { x: 0.1, y: 0.9 },
                crate::NormalizedZonePoint { x: 0.9, y: 0.1 },
            ],
            rotation: crate::OrthogonalRotation::None,
        }];

        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Page 1"));
    }

    #[test]
    fn matched_render_requires_a_document_canvas_at_manifest_decode() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/raster-final-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.document_canvas = None;

        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("documentCanvas"));
    }

    #[test]
    fn detail_render_plan_is_preview_only_and_bounded() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/protocol/preview-raster-v3.json"),
        )
        .unwrap();
        let mut manifest: ManifestV3 = serde_json::from_slice(&bytes).unwrap();
        manifest.pages[0].options.render_crop = None;
        manifest.pages[0].detail_render_plan = Some(DetailRenderPlan {
            base_metadata_path: PathBuf::from("base.json"),
            base_raster_path: PathBuf::from("base.png"),
            base_cleaned_raster_path: None,
            source_crop: DetailPixelRect {
                x_px: 10.0,
                y_px: 20.0,
                width_px: 100.0,
                height_px: 120.0,
            },
            full_source_width_px: 400,
            full_source_height_px: 600,
            scale: 4.0,
            render_region: DetailPixelRect {
                x_px: 80.0,
                y_px: 100.0,
                width_px: 120.0,
                height_px: 160.0,
            },
            sampled_region: DetailPixelRect {
                x_px: 64.0,
                y_px: 84.0,
                width_px: 152.0,
                height_px: 192.0,
            },
        });
        manifest.validate().unwrap();

        manifest.pages[0]
            .detail_render_plan
            .as_mut()
            .unwrap()
            .source_crop
            .width_px = 1_000.0;
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("full source raster"));
        manifest.pages[0]
            .detail_render_plan
            .as_mut()
            .unwrap()
            .source_crop
            .width_px = 100.0;
        manifest.render_mode = RenderMode::Final;
        assert!(manifest
            .validate()
            .unwrap_err()
            .to_string()
            .contains("preview render"));
    }

    #[test]
    fn advanced_controls_parse_additively_and_validate() {
        let json = r#"{
            "version":3,"operation":"render","renderMode":"preview","canvasScope":"page",
            "pages":[{
                "inputPath":"in.png","sourcePageIndex":0,"pageMetadataPath":"page.json",
                "outputs":[{"outputPath":"out.png","metadataPath":"out.json"}],
                "options":{
                    "matchPageSize":false,
                    "manualSkewDegrees":-2.5,
                    "experimental":{"autoDewarp":true,"autoDewarpDepth":1.75}
                }
            }]
        }"#;
        let manifest: ManifestV3 = serde_json::from_str(json).unwrap();
        manifest.validate().unwrap();
        assert_eq!(manifest.pages[0].options.manual_skew_degrees, Some(-2.5));
        assert_eq!(
            manifest.pages[0].options.experimental.auto_dewarp_depth,
            Some(1.75)
        );
    }

    #[test]
    fn optional_split_seam_is_omitted_when_absent_and_additive_when_present() {
        let straight = serde_json::to_value(SplitGeometryResult {
            cutter_x_px: Some(120.0),
            split_seam: None,
        })
        .unwrap();
        assert_eq!(straight, serde_json::json!({"cutterXPx": 120.0}));

        let curved = serde_json::to_value(SplitGeometryResult {
            cutter_x_px: Some(120.0),
            split_seam: Some(SplitSeamPolyline {
                points: vec![Point::new(119.0, 0.5), Point::new(121.0, 9.5)],
            }),
        })
        .unwrap();
        assert_eq!(curved["splitSeam"]["points"].as_array().unwrap().len(), 2);
    }
}
