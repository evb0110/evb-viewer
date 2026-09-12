use crate::domain::geometry::PageHalf;
use crate::ink_consistency::PageInkConsistencyContext;
use crate::text_tone::TextToneDiagnostics;
use scan_primitives::Rect;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const DEFAULT_MAX_PIXELS: u64 = 160_000_000;
pub const DEFAULT_MAX_DIMENSION: u32 = 40_000;
pub const MIN_THICKNESS: i8 = -5;
pub const MAX_THICKNESS: i8 = 5;
pub const THICKNESS_GRAY_STEP: i16 = 4;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum BinarizationMode {
    Otsu,
    Sauvola,
    Wolf,
    #[default]
    Auto,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum DespeckleLevel {
    Off,
    Cautious,
    #[default]
    Normal,
    Aggressive,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutMode {
    #[default]
    Auto,
    #[serde(rename = "force-single", alias = "single")]
    Single,
    PageWithOffcut,
    KeepLeft,
    KeepRight,
    #[serde(rename = "force-two-page", alias = "two-page")]
    TwoPage,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum OrthogonalRotation {
    #[default]
    None,
    Clockwise90,
    Clockwise180,
    Clockwise270,
}

impl OrthogonalRotation {
    fn from_degrees(degrees: u16) -> Option<Self> {
        match degrees {
            0 => Some(Self::None),
            90 => Some(Self::Clockwise90),
            180 => Some(Self::Clockwise180),
            270 => Some(Self::Clockwise270),
            _ => None,
        }
    }

    pub fn degrees(self) -> u16 {
        match self {
            Self::None => 0,
            Self::Clockwise90 => 90,
            Self::Clockwise180 => 180,
            Self::Clockwise270 => 270,
        }
    }
}

impl Serialize for OrthogonalRotation {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u16(self.degrees())
    }
}

impl<'de> Deserialize<'de> for OrthogonalRotation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum RotationValue {
            Number(u16),
            LegacyString(String),
        }

        let value = RotationValue::deserialize(deserializer)?;
        let degrees = match value {
            RotationValue::Number(degrees) => degrees,
            RotationValue::LegacyString(degrees) => degrees
                .parse()
                .map_err(|_| serde::de::Error::custom("rotation must be 0, 90, 180, or 270"))?,
        };
        Self::from_degrees(degrees)
            .ok_or_else(|| serde::de::Error::custom("rotation must be 0, 90, 180, or 270"))
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum OutputMode {
    #[default]
    Bw,
    Mixed,
    Grayscale,
    Color,
    Auto,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum PageAlignment {
    TopLeft,
    #[default]
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
    /// Content lands where the source ink sat, using the caller's per-half
    /// normalized anchor. Without an anchor this is exactly `TopCenter`: the
    /// anchor is the whole difference, and a page the caller could not measure
    /// must not move relative to the pages it is bound with.
    Ink,
}

impl PageAlignment {
    pub fn offset(self, available_width: usize, available_height: usize) -> (usize, usize) {
        let x = match self {
            Self::TopLeft | Self::CenterLeft | Self::BottomLeft => 0,
            Self::TopCenter | Self::Center | Self::BottomCenter | Self::Ink => available_width / 2,
            Self::TopRight | Self::CenterRight | Self::BottomRight => available_width,
        };
        let y = match self {
            Self::TopLeft | Self::TopCenter | Self::TopRight | Self::Ink => 0,
            Self::CenterLeft | Self::Center | Self::CenterRight => available_height / 2,
            Self::BottomLeft | Self::BottomCenter | Self::BottomRight => available_height,
        };
        (x, y)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualContentBoxes {
    pub full: Option<NormalizedRect>,
    pub left: Option<NormalizedRect>,
    pub right: Option<NormalizedRect>,
}

impl ManualContentBoxes {
    pub(crate) fn is_empty(&self) -> bool {
        self.full.is_none() && self.left.is_none() && self.right.is_none()
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomaticSkewDegrees {
    pub full: Option<f64>,
    pub left: Option<f64>,
    pub right: Option<f64>,
}

impl AutomaticSkewDegrees {
    fn is_empty(&self) -> bool {
        self.full.is_none() && self.left.is_none() && self.right.is_none()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedSplit {
    #[serde(rename = "xNormalized")]
    pub x: f64,
    #[serde(rename = "rotationDegrees")]
    pub rotation: OrthogonalRotation,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedRect {
    #[serde(rename = "xNormalized")]
    pub x: f64,
    #[serde(rename = "yNormalized")]
    pub y: f64,
    #[serde(rename = "widthNormalized")]
    pub width: f64,
    #[serde(rename = "heightNormalized")]
    pub height: f64,
    #[serde(rename = "rotationDegrees")]
    pub rotation: OrthogonalRotation,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedZonePoint {
    #[serde(rename = "xNormalized")]
    pub x: f64,
    #[serde(rename = "yNormalized")]
    pub y: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedZonePolygon {
    pub points: Vec<NormalizedZonePoint>,
    #[serde(rename = "rotationDegrees")]
    pub rotation: OrthogonalRotation,
}

const MANUAL_ZONE_MAX: usize = 256;
const POLYGON_POINT_MAX: usize = 2_048;
const MANUAL_ZONE_POINT_MAX: usize = 8_192;
const POLYGON_EPSILON: f64 = 1e-9;
pub const MANUAL_SPLIT_MIN: f64 = 0.02;
pub const MANUAL_SPLIT_MAX: f64 = 0.98;
/// Complements computed as `1 - x` in a different f64 rounding order can
/// overshoot 1.0 by ~1e-16; a sub-nanometer tolerance rejects real geometry
/// errors while accepting float noise.
const BOUNDS_EPSILON: f64 = 1e-9;
const POLYGON_AREA_EPSILON: f64 = 1e-12;

fn polygon_cross(a: NormalizedZonePoint, b: NormalizedZonePoint, c: NormalizedZonePoint) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

fn point_on_segment(
    point: NormalizedZonePoint,
    start: NormalizedZonePoint,
    end: NormalizedZonePoint,
) -> bool {
    polygon_cross(start, end, point).abs() <= POLYGON_EPSILON
        && point.x >= start.x.min(end.x) - POLYGON_EPSILON
        && point.x <= start.x.max(end.x) + POLYGON_EPSILON
        && point.y >= start.y.min(end.y) - POLYGON_EPSILON
        && point.y <= start.y.max(end.y) + POLYGON_EPSILON
}

fn segments_intersect(
    a: NormalizedZonePoint,
    b: NormalizedZonePoint,
    c: NormalizedZonePoint,
    d: NormalizedZonePoint,
) -> bool {
    let ab_c = polygon_cross(a, b, c);
    let ab_d = polygon_cross(a, b, d);
    let cd_a = polygon_cross(c, d, a);
    let cd_b = polygon_cross(c, d, b);
    ((ab_c > POLYGON_EPSILON && ab_d < -POLYGON_EPSILON)
        || (ab_c < -POLYGON_EPSILON && ab_d > POLYGON_EPSILON))
        && ((cd_a > POLYGON_EPSILON && cd_b < -POLYGON_EPSILON)
            || (cd_a < -POLYGON_EPSILON && cd_b > POLYGON_EPSILON))
        || point_on_segment(c, a, b)
        || point_on_segment(d, a, b)
        || point_on_segment(a, c, d)
        || point_on_segment(b, c, d)
}

impl NormalizedZonePolygon {
    fn has_valid_geometry(&self) -> bool {
        if self.points.len() < 3 || self.points.len() > POLYGON_POINT_MAX {
            return false;
        }
        let mut twice_area = 0.0;
        for index in 0..self.points.len() {
            let point = self.points[index];
            let next = self.points[(index + 1) % self.points.len()];
            let dx = next.x - point.x;
            let dy = next.y - point.y;
            if dx * dx + dy * dy <= POLYGON_EPSILON * POLYGON_EPSILON {
                return false;
            }
            twice_area += point.x * next.y - next.x * point.y;
        }
        if twice_area.abs() <= POLYGON_AREA_EPSILON {
            return false;
        }
        for first in 0..self.points.len() {
            for second in first + 1..self.points.len() {
                if second == first + 1 || (first == 0 && second == self.points.len() - 1) {
                    continue;
                }
                if segments_intersect(
                    self.points[first],
                    self.points[(first + 1) % self.points.len()],
                    self.points[second],
                    self.points[(second + 1) % self.points.len()],
                ) {
                    return false;
                }
            }
        }
        true
    }

    pub fn resolve(&self, width: usize, height: usize) -> scan_primitives::Polygon {
        scan_primitives::Polygon {
            points: self
                .points
                .iter()
                .map(|point| {
                    scan_primitives::Point::new(point.x * width as f64, point.y * height as f64)
                })
                .collect(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum PictureZoneLayer {
    Eraser1,
    #[default]
    Painter2,
    Eraser3,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PictureZone {
    pub polygon: NormalizedZonePolygon,
    #[serde(default)]
    pub layer: PictureZoneLayer,
}

/// Manual mask overrides use ScanTailor's stable three-pass ordering:
/// ERASER1 (force binary), PAINTER2 (force picture), then ERASER3 and fill
/// zones (force binary). Array order therefore cannot change layer priority.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualZones {
    pub picture: Vec<PictureZone>,
    pub fill: Vec<NormalizedZonePolygon>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementOverrides {
    pub full: Option<PageAlignment>,
    pub left: Option<PageAlignment>,
    pub right: Option<PageAlignment>,
}

/// How far down the margin box this leaf's ink top goes, as a fraction of the
/// box's height. `ink` moves content vertically only — horizontally it is
/// centred exactly like `top-center` — so the anchor carries one axis. The
/// caller owns the measurement and any document-wide clustering behind it;
/// native only places what it is told.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementAnchor {
    pub y_normalized: f64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementAnchors {
    pub full: Option<PlacementAnchor>,
    pub left: Option<PlacementAnchor>,
    pub right: Option<PlacementAnchor>,
}

impl PlacementAnchors {
    fn is_empty(&self) -> bool {
        self.full.is_none() && self.left.is_none() && self.right.is_none()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DewarpOptions {
    /// Directrix points use source-rotated page coordinates: after the page's
    /// orthogonal rotation, before region placement, deskew, dewarp, or crop.
    pub top_curve: Vec<scan_primitives::Point>,
    pub bottom_curve: Vec<scan_primitives::Point>,
    #[serde(default)]
    pub depth: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct MarginsMm {
    pub left_mm: f64,
    pub top_mm: f64,
    pub right_mm: f64,
    pub bottom_mm: f64,
}

impl Default for MarginsMm {
    fn default() -> Self {
        Self {
            left_mm: 5.0,
            top_mm: 5.0,
            right_mm: 5.0,
            bottom_mm: 5.0,
        }
    }
}

impl MarginsMm {
    pub fn values(self) -> [f64; 4] {
        [self.left_mm, self.top_mm, self.right_mm, self.bottom_mm]
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentalOptions {
    pub auto_dewarp: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_dewarp_depth: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedTextToneDiagnostics {
    pub full: Option<TextToneDiagnostics>,
    pub left: Option<TextToneDiagnostics>,
    pub right: Option<TextToneDiagnostics>,
}

impl ResolvedTextToneDiagnostics {
    pub fn for_half(self, half: PageHalf) -> Option<TextToneDiagnostics> {
        match half {
            PageHalf::Full => self.full,
            PageHalf::Left => self.left,
            PageHalf::Right => self.right,
        }
    }

    fn is_empty(&self) -> bool {
        self.full.is_none() && self.left.is_none() && self.right.is_none()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupOptions {
    pub dpi: f64,
    pub source_dpi: Option<f64>,
    pub source_has_bilevel_layer: bool,
    pub source_background_dpi: Option<f64>,
    /// The trusted MRC selection mask is known to be an incomplete ink
    /// carrier (the producer authored a full-resolution background and left
    /// detail there). Mixed composition keeps that background underneath and
    /// stays safe; bilevel output must not adopt the selection as its ink.
    #[serde(default)]
    pub trusted_selection_incomplete: bool,
    /// Set by the batch adapter only after both extracted source-MRC layers
    /// pass their aspect-ratio and format checks. A bare trusted selection is
    /// useful as analysis evidence, but cannot authorize publishing the JPX.
    #[serde(skip)]
    pub trusted_mrc_source_available: bool,
    /// Batch-derived stroke prior and this page's uncropped producer-mask
    /// sample. This is runtime state, never caller-authored manifest input.
    #[serde(skip)]
    pub page_ink_consistency: Option<PageInkConsistencyContext>,
    pub requested_render_dpi: Option<f64>,
    /// Optional preview tile in normalized final intrinsic-output space.
    pub render_crop: Option<NormalizedRect>,
    pub binarization: BinarizationMode,
    pub thickness: i8,
    pub normalize_illumination: bool,
    pub despeckle: bool,
    pub despeckle_level: DespeckleLevel,
    pub output_mode: OutputMode,
    /// Locked Auto representation decision. `None` preserves native policy for
    /// an explicitly selected Mixed mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefer_soft_alpha_foreground: Option<bool>,
    #[serde(skip_serializing_if = "ResolvedTextToneDiagnostics::is_empty")]
    pub resolved_text_tone_diagnostics: ResolvedTextToneDiagnostics,
    pub ocr_mode: bool,
    pub layout: LayoutMode,
    #[serde(rename = "manualSplit")]
    pub manual_split_x: Option<NormalizedSplit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automatic_split: Option<NormalizedSplit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_skew_degrees: Option<f64>,
    pub manual_content_boxes: ManualContentBoxes,
    #[serde(skip_serializing_if = "AutomaticSkewDegrees::is_empty")]
    pub automatic_skew_degrees: AutomaticSkewDegrees,
    #[serde(skip_serializing_if = "ManualContentBoxes::is_empty")]
    pub automatic_content_boxes: ManualContentBoxes,
    pub manual_zones: ManualZones,
    pub crop_content: bool,
    pub match_page_size: bool,
    pub page_alignment: PageAlignment,
    pub placement_overrides: PlacementOverrides,
    #[serde(skip_serializing_if = "PlacementAnchors::is_empty")]
    pub placement_anchors: PlacementAnchors,
    #[serde(rename = "margins")]
    pub margins_mm: Option<MarginsMm>,
    #[serde(skip)]
    pub margins_pixels: Option<[f64; 4]>,
    pub dewarp: Option<DewarpOptions>,
    pub experimental: ExperimentalOptions,
    #[serde(rename = "rotationDegrees")]
    pub rotation: OrthogonalRotation,
    pub excluded: bool,
    pub skip_blank_pages: bool,
    pub max_pixels: u64,
    #[serde(rename = "maxDimensionPx")]
    pub max_dimension: u32,
}

impl Default for CleanupOptions {
    fn default() -> Self {
        Self {
            dpi: 300.0,
            source_dpi: None,
            source_has_bilevel_layer: false,
            source_background_dpi: None,
            trusted_selection_incomplete: false,
            trusted_mrc_source_available: false,
            page_ink_consistency: None,
            requested_render_dpi: None,
            render_crop: None,
            binarization: BinarizationMode::Auto,
            thickness: 0,
            normalize_illumination: true,
            despeckle: true,
            despeckle_level: DespeckleLevel::Normal,
            output_mode: OutputMode::Bw,
            prefer_soft_alpha_foreground: None,
            resolved_text_tone_diagnostics: ResolvedTextToneDiagnostics::default(),
            ocr_mode: false,
            layout: LayoutMode::Auto,
            manual_split_x: None,
            automatic_split: None,
            manual_skew_degrees: None,
            manual_content_boxes: ManualContentBoxes::default(),
            automatic_skew_degrees: AutomaticSkewDegrees::default(),
            automatic_content_boxes: ManualContentBoxes::default(),
            manual_zones: ManualZones::default(),
            crop_content: true,
            match_page_size: true,
            page_alignment: PageAlignment::TopCenter,
            placement_overrides: PlacementOverrides::default(),
            placement_anchors: PlacementAnchors::default(),
            margins_mm: Some(MarginsMm::default()),
            margins_pixels: None,
            dewarp: None,
            experimental: ExperimentalOptions::default(),
            rotation: OrthogonalRotation::None,
            excluded: false,
            skip_blank_pages: false,
            max_pixels: DEFAULT_MAX_PIXELS,
            max_dimension: DEFAULT_MAX_DIMENSION,
        }
    }
}

impl CleanupOptions {
    pub fn effective_despeckle_level(&self) -> DespeckleLevel {
        if self.despeckle {
            self.despeckle_level
        } else {
            DespeckleLevel::Off
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.dpi.is_finite() || self.dpi <= 0.0 {
            return Err("DPI must be positive and finite".into());
        }
        if self
            .source_dpi
            .is_some_and(|dpi| !dpi.is_finite() || dpi <= 0.0)
            || self
                .source_background_dpi
                .is_some_and(|dpi| !dpi.is_finite() || dpi <= 0.0)
            || self
                .requested_render_dpi
                .is_some_and(|dpi| !dpi.is_finite() || dpi <= 0.0)
        {
            return Err("Source and requested render DPI must be positive and finite".into());
        }
        if !(MIN_THICKNESS..=MAX_THICKNESS).contains(&self.thickness) {
            return Err(format!(
                "Text thickness must be between {MIN_THICKNESS} and {MAX_THICKNESS}"
            ));
        }
        for (label, margins) in [
            ("millimeter", self.margins_mm.map(MarginsMm::values)),
            ("pixel", self.margins_pixels),
        ] {
            if let Some(margins) = margins {
                if !margins
                    .into_iter()
                    .all(|margin| margin.is_finite() && margin >= 0.0)
                {
                    return Err(format!(
                        "All {label} margins must be finite and nonnegative"
                    ));
                }
            }
        }
        if let Some(dewarp) = &self.dewarp {
            if !dewarp.depth.is_finite()
                || dewarp
                    .top_curve
                    .iter()
                    .chain(&dewarp.bottom_curve)
                    .any(|point| !point.x.is_finite() || !point.y.is_finite())
            {
                return Err("Dewarp curves and depth must contain only finite values".into());
            }
            crate::dewarp::DewarpModel::from_options(dewarp).map_err(|error| error.to_string())?;
        }
        if let Some(split) = self.manual_split_x {
            if !split.x.is_finite()
                || !(MANUAL_SPLIT_MIN..=MANUAL_SPLIT_MAX).contains(&split.x)
                || split.rotation != self.rotation
            {
                return Err(
                    format!(
                        "Manual split x must be between {MANUAL_SPLIT_MIN} and {MANUAL_SPLIT_MAX} and authored under the page rotation"
                    ),
                );
            }
        }
        if let Some(split) = self.automatic_split {
            if !split.x.is_finite()
                || !(0.0..=1.0).contains(&split.x)
                || split.rotation != self.rotation
            {
                return Err(
                    "Automatic split must be normalized and authored under the page rotation"
                        .into(),
                );
            }
        }
        if let Some(angle) = self.manual_skew_degrees {
            if !angle.is_finite() || !(-15.0..=15.0).contains(&angle) {
                return Err(
                    "Manual skew angle must be finite and between -15 and 15 degrees".into(),
                );
            }
        }
        for angle in [
            self.automatic_skew_degrees.full,
            self.automatic_skew_degrees.left,
            self.automatic_skew_degrees.right,
        ]
        .into_iter()
        .flatten()
        {
            if !angle.is_finite() || !(-15.0..=15.0).contains(&angle) {
                return Err(
                    "Automatic skew evidence must be finite and between -15 and 15 degrees".into(),
                );
            }
        }
        for diagnostics in [
            self.resolved_text_tone_diagnostics.full,
            self.resolved_text_tone_diagnostics.left,
            self.resolved_text_tone_diagnostics.right,
        ]
        .into_iter()
        .flatten()
        {
            diagnostics.validate()?;
        }
        if let Some(depth) = self.experimental.auto_dewarp_depth {
            if !depth.is_finite() || !(0.5..=4.0).contains(&depth) {
                return Err("Automatic dewarp depth must be finite and between 0.5 and 4.0".into());
            }
        }
        for (label, rect) in [
            ("render crop", self.render_crop),
            ("manual full content box", self.manual_content_boxes.full),
            ("manual left content box", self.manual_content_boxes.left),
            ("manual right content box", self.manual_content_boxes.right),
            (
                "automatic full content box",
                self.automatic_content_boxes.full,
            ),
            (
                "automatic left content box",
                self.automatic_content_boxes.left,
            ),
            (
                "automatic right content box",
                self.automatic_content_boxes.right,
            ),
        ]
        .into_iter()
        .filter_map(|(label, rect)| rect.map(|rect| (label, rect)))
        {
            if ![rect.x, rect.y, rect.width, rect.height]
                .into_iter()
                .all(f64::is_finite)
                || rect.x < 0.0
                || rect.y < 0.0
                || rect.width <= 0.0
                || rect.height <= 0.0
                || rect.x + rect.width > 1.0 + BOUNDS_EPSILON
                || rect.y + rect.height > 1.0 + BOUNDS_EPSILON
                || rect.rotation != self.rotation
            {
                return Err(format!(
                    "{label} must be positive, bounded, and authored under the page rotation \
                     (x={}, y={}, width={}, height={}, rotation={:?}, page rotation={:?})",
                    rect.x, rect.y, rect.width, rect.height, rect.rotation, self.rotation,
                ));
            }
        }
        for (label, anchor) in [
            ("full", self.placement_anchors.full),
            ("left", self.placement_anchors.left),
            ("right", self.placement_anchors.right),
        ]
        .into_iter()
        .filter_map(|(label, anchor)| anchor.map(|anchor| (label, anchor)))
        {
            let value = anchor.y_normalized;
            if !value.is_finite() || !(-BOUNDS_EPSILON..=1.0 + BOUNDS_EPSILON).contains(&value) {
                return Err(format!(
                    "{label} placement anchor must be finite and normalized (yNormalized={value})",
                ));
            }
        }
        let zone_count = self.manual_zones.picture.len() + self.manual_zones.fill.len();
        let point_count = self
            .manual_zones
            .picture
            .iter()
            .map(|zone| zone.polygon.points.len())
            .chain(
                self.manual_zones
                    .fill
                    .iter()
                    .map(|polygon| polygon.points.len()),
            )
            .sum::<usize>();
        if zone_count > MANUAL_ZONE_MAX || point_count > MANUAL_ZONE_POINT_MAX {
            return Err("Manual zones exceed the supported collection bounds".into());
        }
        for polygon in self
            .manual_zones
            .picture
            .iter()
            .map(|zone| &zone.polygon)
            .chain(&self.manual_zones.fill)
        {
            if !polygon.has_valid_geometry()
                || polygon.rotation != self.rotation
                || polygon.points.iter().any(|point| {
                    !point.x.is_finite()
                        || !point.y.is_finite()
                        || !(0.0..=1.0).contains(&point.x)
                        || !(0.0..=1.0).contains(&point.y)
                })
            {
                return Err("Manual zone polygons must be finite, bounded, non-degenerate, simple, and authored under the page rotation".into());
            }
        }
        Ok(())
    }

    pub fn source_dpi(&self) -> f64 {
        self.source_dpi.unwrap_or(self.dpi)
    }

    pub fn source_background_dpi(&self) -> f64 {
        self.source_background_dpi.unwrap_or(self.source_dpi())
    }

    pub fn requested_render_dpi(&self) -> f64 {
        self.requested_render_dpi.unwrap_or(self.dpi)
    }

    pub fn resolved_render_crop(&self, width: usize, height: usize) -> Option<Rect> {
        let crop = self.render_crop?;
        let left = (crop.x * width as f64).floor() as usize;
        let top = (crop.y * height as f64).floor() as usize;
        let right = ((crop.x + crop.width) * width as f64).ceil() as usize;
        let bottom = ((crop.y + crop.height) * height as f64).ceil() as usize;
        Some(Rect::new(
            left.min(width.saturating_sub(1)) as f64,
            top.min(height.saturating_sub(1)) as f64,
            right
                .clamp(left.saturating_add(1), width)
                .saturating_sub(left) as f64,
            bottom
                .clamp(top.saturating_add(1), height)
                .saturating_sub(top) as f64,
        ))
    }

    /// Converts derived raster geometry into allocation-safe dimensions.
    ///
    /// Input options are validated independently, but combinations such as a
    /// finite millimetre margin and DPI can still overflow while producing
    /// pixel geometry. Keep that distinction explicit: non-finite derived
    /// geometry is an invalid request, while finite geometry beyond the
    /// configured raster bounds is too large to render.
    pub(crate) fn validate_derived_raster_dimensions(
        &self,
        width: f64,
        height: f64,
    ) -> Result<(usize, usize), DerivedRasterError> {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Err(DerivedRasterError::Invalid(
                "Derived raster geometry must be positive and finite".into(),
            ));
        }
        let width = width.ceil();
        let height = height.ceil();
        if width > usize::MAX as f64 || height > usize::MAX as f64 {
            return Err(DerivedRasterError::TooLarge(
                "Derived raster dimensions exceed cleanup guardrails".into(),
            ));
        }
        let (width, height) = (width as usize, height as usize);
        let pixels = (width as u64).checked_mul(height as u64).ok_or_else(|| {
            DerivedRasterError::TooLarge(
                "Derived raster pixel product exceeds cleanup guardrails".to_owned(),
            )
        })?;
        if width > self.max_dimension as usize
            || height > self.max_dimension as usize
            || pixels > self.max_pixels
        {
            return Err(DerivedRasterError::TooLarge(format!(
                "Derived raster {width}x{height} exceeds cleanup guardrails"
            )));
        }
        Ok((width, height))
    }

    pub fn placement_for(&self, half: PageHalf) -> PageAlignment {
        let override_value = match half {
            PageHalf::Full => self.placement_overrides.full,
            PageHalf::Left => self.placement_overrides.left,
            PageHalf::Right => self.placement_overrides.right,
        };
        override_value.unwrap_or(self.page_alignment)
    }

    pub fn placement_anchor_for(&self, half: PageHalf) -> Option<PlacementAnchor> {
        match half {
            PageHalf::Full => self.placement_anchors.full,
            PageHalf::Left => self.placement_anchors.left,
            PageHalf::Right => self.placement_anchors.right,
        }
    }

    pub fn resolved_split_x(&self, analysis_width: usize) -> Option<f64> {
        self.manual_split_x
            .or(self.automatic_split)
            .map(|split| split.x * analysis_width as f64)
    }

    pub fn has_split_evidence(&self) -> bool {
        self.manual_split_x.is_some() || self.automatic_split.is_some()
    }

    pub fn resolved_manual_content_for(
        &self,
        half: PageHalf,
        analysis_width: usize,
        analysis_height: usize,
    ) -> Option<Rect> {
        let normalized = match half {
            PageHalf::Full => self.manual_content_boxes.full,
            PageHalf::Left => self.manual_content_boxes.left,
            PageHalf::Right => self.manual_content_boxes.right,
        }?;
        Some(Rect::new(
            normalized.x * analysis_width as f64,
            normalized.y * analysis_height as f64,
            normalized.width * analysis_width as f64,
            normalized.height * analysis_height as f64,
        ))
    }

    pub fn automatic_skew_for(&self, half: PageHalf) -> Option<f64> {
        match half {
            PageHalf::Full => self.automatic_skew_degrees.full,
            PageHalf::Left => self.automatic_skew_degrees.left,
            PageHalf::Right => self.automatic_skew_degrees.right,
        }
    }

    pub fn resolved_content_for(
        &self,
        half: PageHalf,
        analysis_width: usize,
        analysis_height: usize,
    ) -> Option<Rect> {
        self.resolved_manual_content_for(half, analysis_width, analysis_height)
            .or_else(|| {
                let normalized = match half {
                    PageHalf::Full => self.automatic_content_boxes.full,
                    PageHalf::Left => self.automatic_content_boxes.left,
                    PageHalf::Right => self.automatic_content_boxes.right,
                }?;
                Some(Rect::new(
                    normalized.x * analysis_width as f64,
                    normalized.y * analysis_height as f64,
                    normalized.width * analysis_width as f64,
                    normalized.height * analysis_height as f64,
                ))
            })
    }
}

#[derive(Debug)]
pub(crate) enum DerivedRasterError {
    Invalid(String),
    TooLarge(String),
}

impl std::fmt::Display for DerivedRasterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) | Self::TooLarge(message) => formatter.write_str(message),
        }
    }
}

#[cfg(test)]
#[path = "options_tests.rs"]
mod tests;
