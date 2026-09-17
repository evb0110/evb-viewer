use evb_scan_cleanup::split::LayoutClassification;
use serde::Deserialize;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetectionMetadata {
    layout_classification: LayoutClassification,
    layout_confidence: f64,
    cutter_x_px: Option<f64>,
    tier1_verdict: LayoutClassification,
    reconciled: bool,
    cluster_agreement: f64,
    document_prior: Option<DocumentPrior>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentPrior {
    dominant_layout: LayoutClassification,
    cutter_ratio_median: Option<f64>,
    agreement_strength: f64,
}

fn page_options() -> serde_json::Value {
    json!({
        "dpi": 81.7067635043123,
        "binarization": "auto",
        "thickness": 0,
        "normalizeIllumination": true,
        "despeckle": true,
        "outputMode": "bw",
        "ocrMode": false,
        "layout": "auto",
        "manualSplit": null,
        "manualContentBoxes": {},
        "cropContent": true,
        "matchPageSize": true,
        "pageAlignment": "top-center",
        "placementOverrides": {},
        "margins": { "leftMm": 5, "topMm": 5, "rightMm": 5, "bottomMm": 5 },
        "experimental": { "autoDewarp": false },
        "rotationDegrees": 0,
        "excluded": false,
        "skipBlankPages": false,
        "maxPixels": 160000000,
        "maxDimensionPx": 40000
    })
}

fn unique_scratch() -> PathBuf {
    static NEXT_SCRATCH_ID: AtomicU64 = AtomicU64::new(0);

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let sequence = NEXT_SCRATCH_ID.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "evb-scan-cleanup-document-consistency-{}-{nonce}-{sequence}",
        std::process::id(),
    ))
}

#[test]
fn luther_soft_gutter_batch_is_consistently_high_confidence() {
    let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/split");
    let scratch = unique_scratch();
    fs::create_dir_all(&scratch).unwrap();

    let pages = (1..=4)
        .map(|page| {
            json!({
                "inputPath": fixture_root.join(format!("spread-luther-soft-gutter-p{page:05}.png")),
                "sourcePageIndex": page - 1,
                "pageMetadataPath": scratch.join(format!("page-{page}.json")),
                "options": page_options(),
                "outputs": []
            })
        })
        .collect::<Vec<_>>();
    let manifest = scratch.join("manifest.json");
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&json!({
            "version": 3,
            "operation": "analyze",
            "renderMode": "preview",
            "canvasScope": "page",
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    for page in 1..=4 {
        let result: DetectionMetadata =
            serde_json::from_slice(&fs::read(scratch.join(format!("page-{page}.json"))).unwrap())
                .unwrap();
        assert_eq!(
            result.layout_classification,
            LayoutClassification::TwoPageSpread,
            "page {page}: {result:?}"
        );
        assert_eq!(
            result.tier1_verdict,
            LayoutClassification::TwoPageSpread,
            "page {page}: {result:?}"
        );
        assert!(result.layout_confidence >= 0.8, "page {page}: {result:?}");
        let cutter_ratio = result.cutter_x_px.unwrap() / 1200.0;
        assert!(
            (cutter_ratio - 0.54).abs() <= 0.03,
            "page {page}: {result:?}"
        );
        assert!(!result.reconciled, "page {page}: {result:?}");
        assert!(result.cluster_agreement >= 0.6, "page {page}: {result:?}");
        let document_prior = result.document_prior.unwrap();
        assert_eq!(
            document_prior.dominant_layout,
            LayoutClassification::TwoPageSpread
        );
        assert!(document_prior.cutter_ratio_median.is_some());
        assert!(document_prior.agreement_strength >= 0.6);
    }

    fs::remove_dir_all(&scratch).unwrap();
}

#[test]
fn document_reconciliation_never_touches_manual_layouts() {
    let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/split");
    let scratch = unique_scratch();
    fs::create_dir_all(&scratch).unwrap();
    let mut manual_options = page_options();
    manual_options["layout"] = json!("force-single");
    let pages = (1..=4)
        .map(|page| {
            json!({
                "inputPath": fixture_root.join(format!("spread-luther-soft-gutter-p{page:05}.png")),
                "sourcePageIndex": page - 1,
                "pageMetadataPath": scratch.join(format!("page-{page}.json")),
                "options": if page == 2 { manual_options.clone() } else { page_options() },
                "outputs": []
            })
        })
        .collect::<Vec<_>>();
    let manifest = scratch.join("manifest.json");
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&json!({
            "version": 3,
            "operation": "analyze",
            "renderMode": "preview",
            "canvasScope": "page",
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let manual: DetectionMetadata =
        serde_json::from_slice(&fs::read(scratch.join("page-2.json")).unwrap()).unwrap();
    assert_eq!(
        manual.layout_classification,
        LayoutClassification::SingleUncutPage
    );
    assert_eq!(manual.tier1_verdict, LayoutClassification::SingleUncutPage);
    assert_eq!(manual.layout_confidence, 1.0);
    assert!(!manual.reconciled);
    assert_eq!(manual.cluster_agreement, 0.0);
    assert!(manual.document_prior.is_none());

    fs::remove_dir_all(&scratch).unwrap();
}
