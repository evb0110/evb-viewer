#!/bin/sh

set -eu

mode=${1:-}
output_root=${2:-.devkit/scratch/scan-cleanup-oracles}

run_catastrophe_oracle() {
  cargo run --manifest-path native/Cargo.toml --locked --release \
    --package evb-scan-cleanup --bin scan-cleanup-harness -- \
    --baseline native/scan-cleanup/harness-baseline.json \
    --out "$output_root/native"
}

build_scan_cleanup_tool() {
  pnpm run build:scan-cleanup
}

resolve_scan_cleanup_tool() {
  node --input-type=module -e '
    import path from "node:path";
    import { getRequestedNativeRustTarget } from "./scripts/native-rust-targets.mjs";
    const target = getRequestedNativeRustTarget();
    process.stdout.write(path.join(
      ".tmp",
      "scan-cleanup",
      target.platformArch,
      "bin",
      `evb-scan-cleanup${target.binaryExtension}`,
    ));
  '
}

run_stroke_weight_oracle() {
  stroke_output="$output_root/stroke-weight"
  scan_cleanup_tool=$(resolve_scan_cleanup_tool)
  mkdir -p "$stroke_output"
  mkdir -p .devkit/tmp/stroke-weight-oracle
  node --test scripts/diagnostics/stroke-weight-oracle/stroke-weight-oracle.test.mjs
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    const manifest = JSON.parse(readFileSync("scripts/diagnostics/stroke-weight-oracle/calibration/render-manifest.json", "utf8"));
    const absolute = value => path.resolve(value);
    for (const page of manifest.pages) {
      page.inputPath = absolute(page.inputPath);
      page.pageMetadataPath = absolute(page.pageMetadataPath);
      for (const output of page.outputs) {
        output.outputPath = absolute(output.outputPath);
        output.metadataPath = absolute(output.metadataPath);
      }
    }
    writeFileSync(".devkit/tmp/stroke-weight-oracle/render-manifest.json", JSON.stringify(manifest));
  '
  "$scan_cleanup_tool" \
    --manifest "$PWD/.devkit/tmp/stroke-weight-oracle/render-manifest.json"
  node scripts/diagnostics/stroke-weight-oracle/stroke-weight-oracle.mjs \
    --image .devkit/tmp/stroke-weight-oracle/diyarbakir-clean.png \
    --image .devkit/tmp/stroke-weight-oracle/wahrscheinlich-clean.png \
    --image .devkit/tmp/stroke-weight-oracle/handschrift-clean.png \
    --dpi 300 \
    --out "$stroke_output/report.json"
  node scripts/diagnostics/stroke-weight-oracle/assert-calibration.mjs \
    --report "$stroke_output/report.json" \
    --reference scripts/diagnostics/stroke-weight-oracle/calibration/s5-line-stroke-budget-green.json
}

supports_type_stripping() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1);
  '
}

run_export_oracles() {
  local rgb_output="$output_root/rgb-camera"
  mkdir -p "$rgb_output"
  node scripts/diagnostics/generate-scan-cleanup-rgb-fixture.mjs \
    --out "$rgb_output/source.pdf"

  node scripts/diagnostics/scan-cleanup-preview-harness.mjs \
    --source tests/fixtures/electron/test-scanned.pdf \
    --pages 1 \
    --out "$output_root/preview" \
    --check

  node scripts/diagnostics/scan-cleanup-word-loss-audit.mjs \
    --source tests/fixtures/electron/test-scanned.pdf \
    --cleaned "$output_root/preview/final-reference.pdf" \
    --mapping "$output_root/preview/final-reference.pdf.summary.json" \
    --from 1 \
    --to 1 \
    --out "$output_root/word-loss.json" \
    --fail-on text-loss

  node scripts/diagnostics/scan-cleanup-preview-harness.mjs \
    --source "$rgb_output/source.pdf" \
    --pages 1 \
    --out "$rgb_output/preview"

  node scripts/diagnostics/scan-cleanup-word-loss-audit.mjs \
    --source "$rgb_output/source.pdf" \
    --cleaned "$rgb_output/preview/final-reference.pdf" \
    --mapping "$rgb_output/preview/final-reference.pdf.summary.json" \
    --from 1 \
    --to 1 \
    --out "$rgb_output/word-loss.json" \
    --fail-on text-loss
}

run_affected_oracles() {
  remote_name=$1
  upstream_ref=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
  if [ -z "$upstream_ref" ]; then
    upstream_ref="$remote_name/main"
  fi
  scan_cleanup_changed=1
  native_changed=1
  if ! git rev-parse --verify "$upstream_ref^{commit}" >/dev/null 2>&1; then
    printf '%s\n' "warning: cannot resolve upstream ref $upstream_ref; running all scan-cleanup oracles conservatively" >&2
    scan_cleanup_changed=1
    native_changed=1
  else
    classifier_output=$(mktemp "${TMPDIR:-/tmp}/evb-scan-cleanup-classifier.XXXXXX")
    cleanup_classifier_output() {
      rm -f "$classifier_output"
    }
    trap cleanup_classifier_output EXIT
    trap 'exit 1' HUP INT TERM
    if GITHUB_OUTPUT="$classifier_output" node scripts/ci/classify-changed-areas.mjs \
      --base="$upstream_ref" --head=HEAD --include-worktree >/dev/null; then
      if grep -qE '^scan_cleanup_export=(true|false)$' "$classifier_output" \
        && grep -qE '^native_or_build=(true|false)$' "$classifier_output"; then
        scan_cleanup_changed=0
        native_changed=0
        grep -qx 'scan_cleanup_export=true' "$classifier_output" && scan_cleanup_changed=1
        grep -qx 'native_or_build=true' "$classifier_output" && native_changed=1
      else
        printf '%s\n' 'warning: expected changed-area outputs missing; running all scan-cleanup oracles conservatively' >&2
        scan_cleanup_changed=1
        native_changed=1
      fi
    else
      printf '%s\n' 'warning: changed-area classification failed; running all scan-cleanup oracles conservatively' >&2
      scan_cleanup_changed=1
      native_changed=1
    fi
    cleanup_classifier_output
    trap - EXIT HUP INT TERM
  fi

  if [ "$scan_cleanup_changed" -eq 0 ] && [ "$native_changed" -eq 0 ]; then
    printf '%s\n' "No scan-cleanup oracle inputs changed relative to $upstream_ref; skipping."
    return
  fi

  if [ "$scan_cleanup_changed" -eq 1 ] && ! supports_type_stripping; then
    printf '%s\n' 'scan-cleanup affected oracles require Node >= 22.18 for TypeScript stripping.' >&2
    exit 1
  fi
  if [ "$native_changed" -eq 1 ]; then
    run_catastrophe_oracle
  fi
  if [ "$scan_cleanup_changed" -eq 0 ]; then
    printf '%s\n' "No scan-cleanup export oracle inputs changed relative to $upstream_ref; native catastrophe oracle complete."
    return
  fi
  build_scan_cleanup_tool
  run_stroke_weight_oracle
  run_export_oracles
}

case "$mode" in
  native)
    run_catastrophe_oracle
    ;;
  export)
    if ! supports_type_stripping; then
      printf '%s\n' 'scan-cleanup export oracles require Node >= 22.18 for TypeScript stripping.' >&2
      exit 1
    fi
    build_scan_cleanup_tool
    run_stroke_weight_oracle
    run_export_oracles
    ;;
  affected)
    remote_name=${3:-origin}
    run_affected_oracles "$remote_name"
    ;;
  *)
    printf '%s\n' 'usage: scripts/ci/scan-cleanup-oracles.sh <native|export|affected> [output-root] [remote]' >&2
    exit 2
    ;;
esac
