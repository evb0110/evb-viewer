#!/bin/bash
# Download Tesseract language data files from tessdata_best
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TESSDATA_DIR="$PROJECT_ROOT/resources/tesseract/tessdata"
TESSDATA_BEST_REF="e12c65a915945e4c28e237a9b52bc4a8f39a0cec"
TESSDATA_BASE_URL="https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/${TESSDATA_BEST_REF}"

mkdir -p "$TESSDATA_DIR"

# Local model codes, digests and upstream paths all come from the registry.
MODELS="$(
  cd "$PROJECT_ROOT" && pnpm exec tsx scripts/printOcrLanguageCodes.ts --sha256
)"

echo "Downloading tessdata_best language files to $TESSDATA_DIR..."
echo "Pinned tessdata_best ref: $TESSDATA_BEST_REF"

while read -r lang expected_sha256 source_path; do
  FILE="$TESSDATA_DIR/${lang}.traineddata"
  if [ -z "$expected_sha256" ]; then
    echo "Error: no pinned SHA-256 digest registered for $lang" >&2
    exit 1
  fi
  if [ -f "$FILE" ] && [ "$(shasum -a 256 "$FILE" | awk '{print $1}')" = "$expected_sha256" ]; then
    echo "  $lang: already exists ($(du -h "$FILE" | cut -f1))"
  else
    rm -f "$FILE"
    echo "  $lang: downloading..."
    TMP_FILE="$(mktemp "$TESSDATA_DIR/${lang}.traineddata.XXXXXX")"
    cleanup_download_tmp() {
      rm -f "$TMP_FILE"
    }
    if ! curl --fail --location --show-error --silent --retry 3 --retry-delay 2 --output "$TMP_FILE" \
      "$TESSDATA_BASE_URL/${source_path}.traineddata"; then
      cleanup_download_tmp
      exit 1
    fi
    if [ ! -s "$TMP_FILE" ]; then
      echo "Error: downloaded tessdata for $lang is empty"
      cleanup_download_tmp
      exit 1
    fi
    bytes="$(wc -c < "$TMP_FILE" | tr -d '[:space:]')"
    if [ "$bytes" -lt 1024 ]; then
      echo "Error: downloaded tessdata for $lang is unexpectedly small ($bytes bytes)"
      cleanup_download_tmp
      exit 1
    fi
    actual_sha256="$(shasum -a 256 "$TMP_FILE" | awk '{print $1}')"
    if [ "$actual_sha256" != "$expected_sha256" ]; then
      echo "Error: tessdata SHA-256 mismatch for $lang" >&2
      cleanup_download_tmp
      exit 1
    fi
    mv "$TMP_FILE" "$FILE"
    echo "  $lang: done ($(du -h "$FILE" | cut -f1))"
  fi
done <<< "$MODELS"

echo ""
echo "Done! Language files:"
ls -lh "$TESSDATA_DIR/"
echo ""
echo "Total size: $(du -sh "$TESSDATA_DIR" | cut -f1)"
