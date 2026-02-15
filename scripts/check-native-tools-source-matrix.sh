#!/bin/bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"

usage() {
  cat <<'EOF'
Usage: scripts/check-native-tools-source-matrix.sh [--all]

Default mode:
- Validate native tool resources for the current host platform/arch

--all mode:
- Validate the full source matrix: darwin/win32/linux x x64/arm64
EOF
}

check_all=0
if [ "$#" -gt 1 ]; then
  usage
  exit 1
fi
if [ "$#" -eq 1 ]; then
  case "$1" in
    --all)
      check_all=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
fi

missing=0
tag_file="$(mktemp)"
trap 'rm -f "$tag_file"' EXIT

check_file() {
  local path="$1"
  local label="$2"
  if [ ! -f "$path" ]; then
    echo "  MISSING $label: $path"
    missing=1
  else
    echo "  OK      $label: $path"
  fi
}

resolve_host_tag() {
  local uname_s
  local uname_m
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"

  local platform=""
  local arch=""

  case "$uname_s" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) platform="win32" ;;
    *)
      echo "Error: Unsupported host platform: $uname_s"
      exit 1
      ;;
  esac

  case "$uname_m" in
    x86_64|amd64|x64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "Error: Unsupported host architecture: $uname_m"
      exit 1
      ;;
  esac

  echo "${platform}-${arch}"
}

check_tag() {
  local tag="$1"
  local platform="${tag%-*}"
  local exe_suffix=""
  if [ "$platform" = "win32" ]; then
    exe_suffix=".exe"
  fi

  echo "== Checking $tag =="
  check_file "resources/tesseract/$tag/bin/tesseract$exe_suffix" "tesseract"
  check_file "resources/poppler/$tag/bin/pdftoppm$exe_suffix" "pdftoppm"
  check_file "resources/poppler/$tag/bin/pdftotext$exe_suffix" "pdftotext"
  check_file "resources/qpdf/$tag/bin/qpdf$exe_suffix" "qpdf"
  check_file "resources/djvulibre/$tag/bin/ddjvu$exe_suffix" "ddjvu"
  check_file "resources/djvulibre/$tag/bin/djvused$exe_suffix" "djvused"
}

if [ "$check_all" -eq 1 ]; then
  for platform in darwin win32 linux; do
    for arch in x64 arm64; do
      echo "${platform}-${arch}" >> "$tag_file"
    done
  done
else
  resolve_host_tag >> "$tag_file"
fi

sort -u "$tag_file" -o "$tag_file"

while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  check_tag "$tag"
done < "$tag_file"

if [ ! -d "resources/tesseract/tessdata" ]; then
  echo "MISSING tessdata directory: resources/tesseract/tessdata"
  missing=1
elif ! find "resources/tesseract/tessdata" -maxdepth 1 -type f -name '*.traineddata' -print -quit | grep -q .; then
  echo "MISSING traineddata files in resources/tesseract/tessdata"
  missing=1
else
  echo "OK tessdata directory and traineddata files present"
fi

if [ "$missing" -ne 0 ]; then
  if [ "$check_all" -eq 1 ]; then
    echo "Native tool source matrix check failed (--all)."
  else
    echo "Native tool source matrix check failed (host tag)."
  fi
  exit 1
fi

if [ "$check_all" -eq 1 ]; then
  echo "Native tool source matrix check passed (--all)."
else
  echo "Native tool source matrix check passed (host tag)."
fi
