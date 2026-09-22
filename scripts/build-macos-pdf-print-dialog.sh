#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
case "$(uname -m)" in
  arm64) platform_arch="darwin-arm64" ;;
  x86_64) platform_arch="darwin-x64" ;;
  *) echo "Unsupported macOS print-helper architecture: $(uname -m)" >&2; exit 1 ;;
esac

output_dir="$project_root/.tmp/pdf-print-dialog/$platform_arch/bin"
mkdir -p "$output_dir"
xcrun swiftc \
  -O \
  -framework AppKit \
  -framework PDFKit \
  "$project_root/native/macos-pdf-print-dialog/main.swift" \
  -o "$output_dir/pdf-print-dialog"
chmod 755 "$output_dir/pdf-print-dialog"
"$output_dir/pdf-print-dialog" --version >/dev/null
