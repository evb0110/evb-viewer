use crate::{calibration::CalibrationConfig, CleanupOptions};
use serde::Serialize;
use std::{
    any::Any,
    collections::{BTreeMap, HashMap},
    fs,
    mem::size_of,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

pub(crate) const DEFAULT_CACHE_BUDGET_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct SourceFingerprint {
    path: PathBuf,
    file_size: u64,
    modified_nanos: i128,
    page_index: usize,
}

impl SourceFingerprint {
    pub(crate) fn from_path(path: &Path, page_index: usize) -> Result<Self, std::io::Error> {
        let metadata = fs::metadata(path)?;
        let modified = metadata.modified()?;
        let modified_nanos = match modified.duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_nanos().min(i128::MAX as u128) as i128,
            Err(error) => -(error.duration().as_nanos().min(i128::MAX as u128) as i128),
        };
        Ok(Self {
            path: path.to_path_buf(),
            file_size: metadata.len(),
            modified_nanos,
            page_index,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum CacheStage {
    DecodedGray,
    DecodedColor,
    Analysis,
    Split,
    Deskew,
    Content,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct StageCacheKey {
    source: SourceFingerprint,
    stage: CacheStage,
    options: Vec<u8>,
}

fn serialized(value: &impl Serialize) -> Vec<u8> {
    serde_json::to_vec(value).expect("cache key serialization uses finite validated options")
}

impl StageCacheKey {
    fn resident_bytes(&self) -> usize {
        size_of::<Self>()
            .saturating_add(self.source.path.as_os_str().len())
            .saturating_add(self.options.len())
    }

    /// Decode is independent of cleanup behavior. Guardrails remain in the key
    /// because a raster accepted under one request must not bypass stricter
    /// max-pixel or max-dimension limits in another request.
    pub(crate) fn decoded(
        source: &SourceFingerprint,
        color: bool,
        options: &CleanupOptions,
    ) -> Self {
        Self {
            source: source.clone(),
            stage: if color {
                CacheStage::DecodedColor
            } else {
                CacheStage::DecodedGray
            },
            options: serialized(&(options.max_pixels, options.max_dimension)),
        }
    }

    /// Analysis-level construction and layout normalization consume source DPI,
    /// orthogonal rotation, illumination normalization, and calibration policy.
    /// Manual content, picture, and fill regions veto automatic blank-page
    /// cleanup, so they are included for every output mode. The quality raster,
    /// layout analysis, and recommendation flags decide which artifact fields
    /// are computed at all, so all three belong in the key. Margins, placement,
    /// binarization, thickness, and despeckling are later-stage concerns
    /// and intentionally do not invalidate this artifact.
    pub(crate) fn analysis(
        source: &SourceFingerprint,
        options: &CleanupOptions,
        prepare_quality_raster: bool,
        recommend_output_mode: bool,
        analyze_layout: bool,
        create_mixed_layers: bool,
        calibration: CalibrationConfig,
    ) -> Self {
        Self {
            source: source.clone(),
            stage: CacheStage::Analysis,
            options: serialized(&(
                (
                    options.dpi.to_bits(),
                    options.source_dpi().to_bits(),
                    options.source_background_dpi.map(f64::to_bits),
                    options.trusted_mrc_source_available,
                ),
                options.rotation,
                options.normalize_illumination,
                options.output_mode,
                &options.manual_content_boxes,
                &options.automatic_content_boxes,
                options.crop_content,
                options.prefer_soft_alpha_foreground,
                &options.manual_zones.picture,
                &options.manual_zones.fill,
                prepare_quality_raster,
                recommend_output_mode,
                analyze_layout,
                create_mixed_layers,
                calibration_key(calibration),
            )),
        }
    }

    /// Split detection consumes the analysis artifact plus layout policy, OCR
    /// single-page routing, manual cutter, and the optional document prior.
    /// It does not consume margins, placement, crop, thickness, or despeckling.
    pub(crate) fn split(
        source: &SourceFingerprint,
        options: &CleanupOptions,
        prepare_quality_raster: bool,
        recommend_output_mode: bool,
        analyze_layout: bool,
        create_mixed_layers: bool,
        calibration: CalibrationConfig,
        document_prior: Option<crate::split::DocumentPrior>,
    ) -> Self {
        Self {
            source: source.clone(),
            stage: CacheStage::Split,
            options: serialized(&(
                Self::analysis(
                    source,
                    options,
                    prepare_quality_raster,
                    recommend_output_mode,
                    analyze_layout,
                    create_mixed_layers,
                    calibration,
                )
                .options,
                options.ocr_mode,
                options.layout,
                options.manual_split_x,
                options.automatic_split,
                document_prior,
            )),
        }
    }

    /// Per-region deskew consumes the normalized analysis raster, calibration,
    /// and split-derived region geometry. Output margins, placement, thickness,
    /// binarization, and despeckling cannot affect it.
    pub(crate) fn deskew(
        source: &SourceFingerprint,
        options: &CleanupOptions,
        split_key: &Self,
        region: scan_primitives::Rect,
    ) -> Self {
        Self {
            source: source.clone(),
            stage: CacheStage::Deskew,
            options: serialized(&(
                &split_key.options,
                rect_key(region),
                options.dpi.to_bits(),
                options.manual_skew_degrees.map(f64::to_bits),
                serialized(&options.automatic_skew_degrees),
            )),
        }
    }

    /// Content detection consumes the deskewed/dewarped analysis raster and
    /// manual content geometry. Dewarp policy is included because it changes
    /// the coordinate space being inspected. Margins, crop enablement,
    /// placement, match-page-size, binarization, thickness, and despeckling are
    /// deliberately excluded: they are applied after content is detected.
    pub(crate) fn content(
        source: &SourceFingerprint,
        options: &CleanupOptions,
        deskew_key: &Self,
        half: crate::pipeline::PageHalf,
    ) -> Self {
        Self {
            source: source.clone(),
            stage: CacheStage::Content,
            options: serialized(&(
                &deskew_key.options,
                half,
                &options.manual_content_boxes,
                &options.automatic_content_boxes,
                &options.dewarp,
                options.experimental.auto_dewarp,
                options.experimental.auto_dewarp_depth.map(f64::to_bits),
            )),
        }
    }
}

fn rect_key(rect: scan_primitives::Rect) -> [u64; 4] {
    [
        rect.x.to_bits(),
        rect.y.to_bits(),
        rect.width.to_bits(),
        rect.height.to_bits(),
    ]
}

fn calibration_key(config: CalibrationConfig) -> [bool; 9] {
    [
        config.content_neighborhood,
        config.content_dilation,
        config.content_block_gaps,
        config.content_min_block_area,
        config.content_dirt_radius,
        config.despeckle_substantial_area,
        config.despeckle_analysis_scale,
        config.local_threshold_radius,
        config.multiscale_local_threshold,
    ]
}

struct CacheEntry {
    value: Arc<dyn Any + Send + Sync>,
    bytes: usize,
    last_used: u64,
}

pub(crate) struct ByteLru {
    budget_bytes: usize,
    resident_bytes: usize,
    clock: u64,
    entries: HashMap<StageCacheKey, CacheEntry>,
    lru_order: BTreeMap<u64, StageCacheKey>,
}

impl ByteLru {
    pub(crate) fn new(budget_bytes: usize) -> Self {
        Self {
            budget_bytes,
            resident_bytes: 0,
            clock: 0,
            entries: HashMap::new(),
            lru_order: BTreeMap::new(),
        }
    }

    pub(crate) fn get<T: Any + Send + Sync>(&mut self, key: &StageCacheKey) -> Option<Arc<T>> {
        let previous_clock = self.entries.get(key)?.last_used;
        let clock = self.next_clock();
        self.lru_order.remove(&previous_clock);
        self.lru_order.insert(clock, key.clone());
        let entry = self
            .entries
            .get_mut(key)
            .expect("cache entry remains present while it is being touched");
        entry.last_used = clock;
        Arc::clone(&entry.value).downcast::<T>().ok()
    }

    pub(crate) fn insert<T: Any + Send + Sync>(
        &mut self,
        key: StageCacheKey,
        value: Arc<T>,
        bytes: usize,
    ) {
        self.remove_key(&key);
        let resident_bytes = bytes.saturating_add(key.resident_bytes());
        if resident_bytes > self.budget_bytes {
            return;
        }
        let clock = self.next_clock();
        self.resident_bytes = self.resident_bytes.saturating_add(resident_bytes);
        self.lru_order.insert(clock, key.clone());
        self.entries.insert(
            key,
            CacheEntry {
                value,
                bytes: resident_bytes,
                last_used: clock,
            },
        );
        while self.resident_bytes > self.budget_bytes {
            let Some((oldest_clock, oldest)) = self
                .lru_order
                .first_key_value()
                .map(|(clock, key)| (*clock, key.clone()))
            else {
                break;
            };
            self.lru_order.remove(&oldest_clock);
            if let Some(evicted) = self.entries.remove(&oldest) {
                self.resident_bytes = self.resident_bytes.saturating_sub(evicted.bytes);
            }
        }
    }

    fn remove_key(&mut self, key: &StageCacheKey) {
        if let Some(replaced) = self.entries.remove(key) {
            self.lru_order.remove(&replaced.last_used);
            self.resident_bytes = self.resident_bytes.saturating_sub(replaced.bytes);
        }
    }

    fn next_clock(&mut self) -> u64 {
        if self.clock == u64::MAX {
            let mut ordered = self
                .entries
                .iter()
                .map(|(key, entry)| (entry.last_used, key.clone()))
                .collect::<Vec<_>>();
            ordered.sort_unstable_by_key(|(clock, _)| *clock);
            self.lru_order.clear();
            self.clock = 0;
            for (_, key) in ordered {
                self.clock += 1;
                if let Some(entry) = self.entries.get_mut(&key) {
                    entry.last_used = self.clock;
                    self.lru_order.insert(self.clock, key);
                }
            }
        }
        self.clock += 1;
        self.clock
    }

    #[cfg(test)]
    fn contains(&self, key: &StageCacheKey) -> bool {
        self.entries.contains_key(key)
    }
}

#[derive(Clone)]
pub(crate) struct PageCache {
    pub(crate) shared: Arc<Mutex<ByteLru>>,
    pub(crate) source: SourceFingerprint,
}

impl PageCache {
    pub(crate) fn new(shared: Arc<Mutex<ByteLru>>, source: SourceFingerprint) -> Self {
        Self { shared, source }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        engine::render::{analyze_page_with_color_and_document_prior_cached, PageAnalysisResult},
        protocol::progress::PageStageTimings,
        split::DocumentPrior,
        MarginsMm, OrthogonalRotation,
    };
    use scan_primitives::GrayImage;

    fn source(page_index: usize) -> SourceFingerprint {
        SourceFingerprint {
            path: PathBuf::from("/tmp/source.png"),
            file_size: 123,
            modified_nanos: 456,
            page_index,
        }
    }

    fn analyze_page_with_document_prior_cached(
        source: &GrayImage,
        options: &CleanupOptions,
        document_prior: Option<DocumentPrior>,
        cache: &PageCache,
        timings: &mut PageStageTimings,
    ) -> Result<PageAnalysisResult, String> {
        analyze_page_with_color_and_document_prior_cached(
            source,
            None,
            options,
            document_prior,
            true,
            true,
            cache,
            timings,
        )
        .map_err(|error| error.to_string())
    }

    #[test]
    fn evicts_least_recently_used_entries_by_bytes() {
        let options = CleanupOptions::default();
        let key_a = StageCacheKey::decoded(&source(0), false, &options);
        let key_b = StageCacheKey::decoded(&source(1), false, &options);
        let key_c = StageCacheKey::decoded(&source(2), false, &options);
        let entry_bytes = key_a.resident_bytes() + 4;
        let mut cache = ByteLru::new(entry_bytes * 2);
        cache.insert(key_a.clone(), Arc::new(1_u32), 4);
        cache.insert(key_b.clone(), Arc::new(2_u32), 4);
        assert_eq!(*cache.get::<u32>(&key_a).unwrap(), 1);
        cache.insert(key_c.clone(), Arc::new(3_u32), 4);
        assert!(cache.contains(&key_a));
        assert!(!cache.contains(&key_b));
        assert!(cache.contains(&key_c));
        assert_eq!(cache.resident_bytes, entry_bytes * 2);
    }

    #[test]
    fn key_mismatch_and_type_mismatch_are_isolated() {
        let options = CleanupOptions::default();
        let key_a = StageCacheKey::decoded(&source(0), false, &options);
        let key_b = StageCacheKey::decoded(&source(1), false, &options);
        let mut cache = ByteLru::new(key_a.resident_bytes() + 4);
        cache.insert(key_a.clone(), Arc::new(7_u32), 4);
        assert!(cache.get::<u32>(&key_b).is_none());
        assert!(cache.get::<String>(&key_a).is_none());
        assert_eq!(*cache.get::<u32>(&key_a).unwrap(), 7);
    }

    #[test]
    fn analysis_key_ignores_margins_but_not_rotation() {
        let source = source(0);
        let mut options = CleanupOptions::default();
        let baseline = StageCacheKey::analysis(
            &source,
            &options,
            true,
            true,
            true,
            true,
            CalibrationConfig::default(),
        );
        options.margins_mm = Some(MarginsMm {
            left_mm: 25.0,
            ..MarginsMm::default()
        });
        assert_eq!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &options,
                true,
                true,
                true,
                true,
                CalibrationConfig::default()
            )
        );
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &options,
                true,
                false,
                true,
                true,
                CalibrationConfig::default()
            )
        );
        // A layout-free artifact carries no picture mask, text axis or split,
        // so it must never be served to a caller that asked for them.
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &options,
                true,
                true,
                false,
                true,
                CalibrationConfig::default()
            )
        );
        options.rotation = OrthogonalRotation::Clockwise90;
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &options,
                true,
                true,
                true,
                true,
                CalibrationConfig::default()
            )
        );
    }

    #[test]
    fn analysis_key_tracks_manual_blank_page_vetoes() {
        let source = source(0);
        let baseline_options = CleanupOptions::default();
        let baseline = StageCacheKey::analysis(
            &source,
            &baseline_options,
            true,
            true,
            true,
            true,
            CalibrationConfig::default(),
        );

        let mut content_options = baseline_options.clone();
        content_options.manual_content_boxes.full = Some(crate::NormalizedRect {
            x: 0.2,
            y: 0.2,
            width: 0.6,
            height: 0.6,
            rotation: crate::OrthogonalRotation::None,
        });
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &content_options,
                true,
                true,
                true,
                true,
                CalibrationConfig::default(),
            ),
        );

        let mut source_dpi_options = baseline_options.clone();
        source_dpi_options.source_dpi = Some(150.0);
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &source_dpi_options,
                true,
                true,
                true,
                true,
                CalibrationConfig::default(),
            ),
        );

        let mut source_background_dpi_options = baseline_options.clone();
        source_background_dpi_options.source_background_dpi = Some(120.0);
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &source_background_dpi_options,
                true,
                true,
                true,
                true,
                CalibrationConfig::default(),
            ),
        );

        let mut trusted_mrc_options = baseline_options.clone();
        trusted_mrc_options.trusted_mrc_source_available = true;
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &trusted_mrc_options,
                true,
                true,
                true,
                true,
                CalibrationConfig::default(),
            ),
        );

        let mut crop_options = baseline_options.clone();
        crop_options.crop_content = false;
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &crop_options,
                true,
                true,
                true,
                true,
                CalibrationConfig::default(),
            ),
        );

        let mut automatic_content_options = baseline_options.clone();
        automatic_content_options.automatic_content_boxes.full = Some(crate::NormalizedRect {
            x: 0.2,
            y: 0.2,
            width: 0.6,
            height: 0.6,
            rotation: crate::OrthogonalRotation::None,
        });
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &automatic_content_options,
                true,
                true,
                true,
                true,
                CalibrationConfig::default(),
            ),
        );

        let mut alpha_options = baseline_options.clone();
        alpha_options.prefer_soft_alpha_foreground = Some(true);
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &alpha_options,
                true,
                true,
                true,
                true,
                CalibrationConfig::default(),
            ),
        );
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &baseline_options,
                true,
                true,
                true,
                false,
                CalibrationConfig::default(),
            ),
        );

        let mut picture_options = baseline_options;
        picture_options
            .manual_zones
            .picture
            .push(crate::PictureZone {
                polygon: crate::NormalizedZonePolygon {
                    points: vec![
                        crate::NormalizedZonePoint { x: 0.2, y: 0.2 },
                        crate::NormalizedZonePoint { x: 0.8, y: 0.2 },
                        crate::NormalizedZonePoint { x: 0.8, y: 0.8 },
                    ],
                    rotation: crate::OrthogonalRotation::None,
                },
                layer: crate::PictureZoneLayer::Painter2,
            });
        assert_ne!(
            baseline,
            StageCacheKey::analysis(
                &source,
                &picture_options,
                true,
                true,
                true,
                true,
                CalibrationConfig::default(),
            ),
        );
    }

    #[test]
    fn cached_analysis_is_transparent_and_margin_changes_reuse_early_stages() {
        let mut image = GrayImage::new(160, 100, 245);
        for y in 20..80 {
            for x in 30..130 {
                if x % 13 < 3 || y % 17 < 2 {
                    image.set(x, y, 30);
                }
            }
        }
        let shared = Arc::new(Mutex::new(ByteLru::new(8 * 1024 * 1024)));
        let cache = PageCache::new(shared, source(0));
        let options = CleanupOptions::default();
        let mut cold_timings = PageStageTimings::default();
        let cold = analyze_page_with_document_prior_cached(
            &image,
            &options,
            None,
            &cache,
            &mut cold_timings,
        )
        .unwrap();

        let mut margin_options = options.clone();
        margin_options.margins_mm = Some(MarginsMm {
            left_mm: 12.0,
            top_mm: 9.0,
            right_mm: 7.0,
            bottom_mm: 5.0,
        });
        let mut cached_timings = PageStageTimings::default();
        let cached = analyze_page_with_document_prior_cached(
            &image,
            &margin_options,
            None,
            &cache,
            &mut cached_timings,
        )
        .unwrap();

        assert!(cold_timings.analysis_level_ms > 0.0);
        assert!(cold_timings.normalization_ms > 0.0);
        assert_eq!(cached_timings.analysis_level_ms, 0.0);
        assert_eq!(cached_timings.normalization_ms, 0.0);
        assert_eq!(cold.classification, cached.classification);
        assert_eq!(cold.confidence, cached.confidence);
        assert_eq!(cold.cutter_x, cached.cutter_x);
        assert_eq!(cold.split_seam, cached.split_seam);

        let mut repeat_timings = PageStageTimings::default();
        let repeat = analyze_page_with_document_prior_cached(
            &image,
            &options,
            None,
            &cache,
            &mut repeat_timings,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&cold.outputs).unwrap(),
            serde_json::to_value(&repeat.outputs).unwrap()
        );
        assert_eq!(cold.classification, repeat.classification);
        assert_eq!(cold.confidence, repeat.confidence);
        assert_eq!(cold.cutter_x, repeat.cutter_x);
        assert_eq!(cold.split_seam, repeat.split_seam);
    }
}
