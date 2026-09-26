#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TARGET="win32-arm64"
TMP_ROOT="${TMPDIR:-$PROJECT_ROOT/.devkit/tmp}"
mkdir -p "$TMP_ROOT"
BUILD_DIR="$(mktemp -d "$TMP_ROOT/msys2-arm64-XXXXXX")"
PACKAGE_DIR="$BUILD_DIR/packages"
STAGING="$BUILD_DIR/staging"
PACKAGE_URL="https://repo.msys2.org/mingw/clangarm64"
mkdir -p "$PACKAGE_DIR" "$STAGING"
trap 'rm -rf -- "$BUILD_DIR"' EXIT

PINNED_PACKAGES=(
  "mingw-w64-clang-aarch64-brotli-1.2.0-1-any.pkg.tar.zst 34acb6ac828721c972c99eedb37e098b9e30321ff00103a70b26170bca221afb"
  "mingw-w64-clang-aarch64-bzip2-1.0.8-4-any.pkg.tar.zst 0e684014d7ad49bffe845b33e5bd34944497bbfbed411fe485174b823379d664"
  "mingw-w64-clang-aarch64-c-ares-1.34.8-1-any.pkg.tar.zst caea7a081fe470b4ad2d565df98ada52fd7c5d9b1e73dbf33ff0e051567d0629"
  "mingw-w64-clang-aarch64-ca-certificates-20260816-1-any.pkg.tar.zst fb4cb5b5eab39f5ccce18a00faef6d2d6039465e5946735bb9bf85857ae353c8"
  "mingw-w64-clang-aarch64-cairo-1.18.6-2-any.pkg.tar.zst 4f13aec1744dd5c19bb6549785811e36a1a57fea0527a41e6fc9240aeab34679"
  "mingw-w64-clang-aarch64-curl-8.22.0-1-any.pkg.tar.zst 2506a30acccad307e6fb9b5ebc1049d563f22cf100f5f0f30e84ee860a676a9d"
  "mingw-w64-clang-aarch64-djvulibre-3.5.30-1-any.pkg.tar.zst e5afdc3c9377d88fd14be185018964b45e8318524e748067418fd6a1fdbaabfd"
  "mingw-w64-clang-aarch64-expat-2.8.5-1-any.pkg.tar.zst 274e713d76f3d6cdefd6819465414fe2d2ccabf39510e904be67f3005ff422ce"
  "mingw-w64-clang-aarch64-fontconfig-2.18.3-1-any.pkg.tar.zst f37fa96e3a7965015d0337ad44ad30187129f63cd3c06afb1bc88ad2853e44f0"
  "mingw-w64-clang-aarch64-freetype-2.14.3-1-any.pkg.tar.zst 0f7b1dc85889b861aefbb2e0fa0ad6b93b36039147c05dbdc13d160981dcd86f"
  "mingw-w64-clang-aarch64-gettext-runtime-1.0-1-any.pkg.tar.zst b5364a7c78cc4b73273a4a28e07e3c6d9cc8ec0ce269527409d944ab1c8f5a70"
  "mingw-w64-clang-aarch64-giflib-6.1.3-1-any.pkg.tar.zst 13ffbb7fdc9cb7b6ded845b55d9e576c719fda7532cdd6a6217969c6a47e54f8"
  "mingw-w64-clang-aarch64-glib2-2.90.0-1-any.pkg.tar.zst ccc85cdae8807bcacfda4858b5bf84aeeb95983763022f7f3c1325a5db32b92f"
  "mingw-w64-clang-aarch64-gmp-6.3.0-2-any.pkg.tar.zst edfaa0517787819ec3ad5da2cc4d691563962a576d0102e91eea507abdc3bdfb"
  "mingw-w64-clang-aarch64-gnutls-3.8.13-3-any.pkg.tar.zst e554674a86d3b82b57c2555902554512280e0712c077f1abbdd585e5ee2b84e5"
  "mingw-w64-clang-aarch64-graphite2-1.3.15-1-any.pkg.tar.zst 28490fe4773d50cde27bd5ce5186cb78620afdbdb9665bab01ca89fbd039aaa9"
  "mingw-w64-clang-aarch64-harfbuzz-14.5.0-1-any.pkg.tar.zst 6c19a47fb95985666e726be6f78c994384cd2f6e8039049bf1e2f3873cf43d14"
  "mingw-w64-clang-aarch64-jbigkit-2.1-6-any.pkg.tar.zst 032761178920b78d051b7b3ecfec0b9a772e2e9a447bd03a77825cc3fb1b3f71"
  "mingw-w64-clang-aarch64-lcms2-2.19.1-1-any.pkg.tar.zst c389449ff940d73d24f8d6254c0f84bfa54a493d0e31d696d4e360a4a8a2fb8b"
  "mingw-w64-clang-aarch64-lerc-4.1.1-1-any.pkg.tar.zst be89e9e4fc90672a31fa555d34e2f7aa42723976bfc1ce29835798c999ac09f0"
  "mingw-w64-clang-aarch64-libb2-0.98.1-3-any.pkg.tar.zst 8e2f1a6a3d8a53d1b6fdcb2d9df090c3c162aa1f36084b4f023d4315c52ea545"
  "mingw-w64-clang-aarch64-libc++-22.1.8-1-any.pkg.tar.zst 6755aa5a658d0a906e1e8477858b3518fd87d380ac5c854a226f5a3a2c78d794"
  "mingw-w64-clang-aarch64-libdeflate-1.26-1-any.pkg.tar.zst b08ef23423d085c7ac7bd862bee57e51487cfb57886dda934b2c05a65f2b8a69"
  "mingw-w64-clang-aarch64-libffi-3.8.0-1-any.pkg.tar.zst 6382d1708eff02e0af00d04bdc43d2b8cb74086382052861b1a63963c8e0489a"
  "mingw-w64-clang-aarch64-libiconv-1.19-1-any.pkg.tar.zst 955499bc5cb73d86ea2850ece9bbdbbfd66b213e272e032f28147ecd42897e21"
  "mingw-w64-clang-aarch64-libidn2-2.3.8-4-any.pkg.tar.zst ccca93221517c27bf0cc5d7bd08cd29be18f88192dcf7d03b11cfef2a802fc18"
  "mingw-w64-clang-aarch64-libjpeg-turbo-3.2.0-1-any.pkg.tar.zst 92206cd729d1bc495427ae056fc622d58726f38b462885b0244a4588d63eb986"
  "mingw-w64-clang-aarch64-libpng-1.6.58-1-any.pkg.tar.zst 60c75205d3ec0b0260c2737b93be77f23c1cdb6be9a9c3fb36131e9dc9927f02"
  "mingw-w64-clang-aarch64-libpsl-0.21.5-3-any.pkg.tar.zst 3681ab00f55b15c894d39b8656bb5e598c266cd6d365e0d7daf3b3401d3b41f0"
  "mingw-w64-clang-aarch64-libssh2-1.11.1-2-any.pkg.tar.zst 81534483d4c19df9d85b35b86f21de24ce31fa9983db66604c18f0a280ff69f3"
  "mingw-w64-clang-aarch64-libsystre-1.0.2-3-any.pkg.tar.zst 732f53a5976ab9a6f33c1087e449d84f6f244dbf9c656c2ebfb5617dcb2e1832"
  "mingw-w64-clang-aarch64-libtasn1-4.21.0-1-any.pkg.tar.zst 4a03b40978d2493ba50da1dffb493ec96407311cb677b9537d555a98d2b7eb37"
  "mingw-w64-clang-aarch64-libtiff-4.7.2-1-any.pkg.tar.zst a157d9992863c8ef685e1a7de168cf38b8bd64a9714d5e74e89ef11d4f5ad195"
  "mingw-w64-clang-aarch64-libtre-0.9.0-2-any.pkg.tar.zst ced17adfcbeb9c13daa4f91ad43b5569e715a3ee68c970bb1a5565d464a79bf9"
  "mingw-w64-clang-aarch64-libunistring-1.4.2-1-any.pkg.tar.zst 4527e038e2fe90fde713bfb0980ea2e465e8c84cce7d329119c579906b57e6e7"
  "mingw-w64-clang-aarch64-libunwind-22.1.8-1-any.pkg.tar.zst 539ab7e4dd324094e24616167f3c3ff0ec115c618604b6fc79de91ff915fbfb4"
  "mingw-w64-clang-aarch64-libwebp-1.6.0-1-any.pkg.tar.zst f3be91d8a5c290828c69ad867216229b85c2aafc489807abe9a6bda7f7ffd1cb"
  "mingw-w64-clang-aarch64-libwinpthread-14.0.0.r426.g4564ee4b5-1-any.pkg.tar.zst 5b38d1db22b3c8f0212d9dfb329e6cdf71474d6678da80570435f2a5318ecde7"
  "mingw-w64-clang-aarch64-lzo2-2.10-3-any.pkg.tar.zst 7ed03c3f1f0ded7f5de470a339f11ed2b69aa9979e3ff05c09480b6d4f4d281f"
  "mingw-w64-clang-aarch64-mpdecimal-4.0.1-3-any.pkg.tar.zst 18fbd49a24113a23717f6290091491d28ddc8f1be4a3069c277d003140101e21"
  "mingw-w64-clang-aarch64-ncurses-6.6-4-any.pkg.tar.zst 912e96d800df0574db7ca8213cefa595b4335f0a85c1d4af19b0832de3103063"
  "mingw-w64-clang-aarch64-nettle-4.0-1-any.pkg.tar.zst 247ec52f1db2d5f2a937cfe1165c6e10657555d0d65f3946a8a97d189f155370"
  "mingw-w64-clang-aarch64-nghttp2-1.70.0-1-any.pkg.tar.zst e09233d9121e3233f75071b8b34057ff39b89c9ac65b902320e29786d8b0a887"
  "mingw-w64-clang-aarch64-nghttp3-1.18.0-1-any.pkg.tar.zst 6a73fcf044201c23b54538f68016e31dd381349e9a152cfd5dfe2740f5760552"
  "mingw-w64-clang-aarch64-ngtcp2-1.25.0-1-any.pkg.tar.zst f8d75cef179dc7b1381bc3e449a7d14992a72bbd92a44d4c6343dd7434778907"
  "mingw-w64-clang-aarch64-nspr-4.40-1-any.pkg.tar.zst b989500a96c09a349da9a3923fea146850033892f545304e846f41d69eb6b974"
  "mingw-w64-clang-aarch64-nss-3.129-1-any.pkg.tar.zst 621539e67e345fc3daaadf9f79d1e3da357c71c0480e38c1140d68e30aed3216"
  "mingw-w64-clang-aarch64-openjpeg2-2.5.4-2-any.pkg.tar.zst b0a754d1fa8df785741f012259e4044d17de13791e7d2224f1fd79ecb6f78842"
  "mingw-w64-clang-aarch64-openssl-3.6.4-1-any.pkg.tar.zst 0bac00bb476fa6b545c9b59b292f03abc6730b240e1bb931a54735d00d83ed1d"
  "mingw-w64-clang-aarch64-p11-kit-0.26.5-1-any.pkg.tar.zst 7f8a56fb0e05ab9dd0deaca59e01240bd7a95fb1928d0702bf0dbd9f51048f73"
  "mingw-w64-clang-aarch64-pcre2-10.48-3-any.pkg.tar.zst a36e41bc77a92e055780cdf3043f412bda7905787d483b01e3be8cd2f8f42253"
  "mingw-w64-clang-aarch64-pixman-0.46.4-3-any.pkg.tar.zst c9bf9c5ab01e23a3bf775703be86fc70142431433ce286b06b50956a2b1af9b8"
  "mingw-w64-clang-aarch64-poppler-26.08.0-1-any.pkg.tar.zst 87cc365f9859a090a090b56d90e513d8e1428b43e9741f64d9765a58d2bf38ce"
  "mingw-w64-clang-aarch64-poppler-data-0.4.12-1-any.pkg.tar.zst edfc4431d43b18efcf8a2a0303c6373217e92d64cc2a27f598795a4de147afa1"
  "mingw-w64-clang-aarch64-python-3.14.7-1-any.pkg.tar.zst 71e30c7ca33c64e8bbfdd3bb2cea7abefeb1031d64044f7221cd48298164c8e6"
  "mingw-w64-clang-aarch64-python-packaging-26.3-1-any.pkg.tar.zst 0ec02e5fbbd209ade0fa917f59137f6ae2fa4d1f3511b3c7af52dadadd349d71"
  "mingw-w64-clang-aarch64-qpdf-12.3.2-1-any.pkg.tar.zst 3e977be7545fe77afb95ee9d328b761b2f27d2b6cdcf68c0efbb93db34592dca"
  "mingw-w64-clang-aarch64-sqlite3-3.53.4-1-any.pkg.tar.zst 4fb56701725abb22615e8014d301b91a23f882330e3de9ca9671053d57c97782"
  "mingw-w64-clang-aarch64-tcl-8.6.18-1-any.pkg.tar.zst 0b0115a42fc2624c993f6f217e1430e9990155671e37b71e58bf5320924d43d1"
  "mingw-w64-clang-aarch64-tk-8.6.18-1-any.pkg.tar.zst 8d2567fff7df027b127333dd27e43827311f4fc36d1ee0e34bb302b5a900c870"
  "mingw-w64-clang-aarch64-tzdata-2026d-1-any.pkg.tar.zst 876fa90805dc340ee5ebac6e6b044934e1b496022503421477ba29885a666ac9"
  "mingw-w64-clang-aarch64-wineditline-2.208-1-any.pkg.tar.zst 5c3716e113766072758855f9a2f74f18165dce036e949e8a0e04c2766125fa5a"
  "mingw-w64-clang-aarch64-xz-5.8.4-1-any.pkg.tar.zst 3a9cad5162492a7c2e3dd215cc20e3432f68ffa453e130954cd9fa9bbecf349a"
  "mingw-w64-clang-aarch64-zlib-1.3.2-2-any.pkg.tar.zst 28c111cc05d923ac56faa33aa5d7618c9dc16ac2d7c9e43a87f875403517894a"
  "mingw-w64-clang-aarch64-zstd-1.5.7-2-any.pkg.tar.zst f1444d0e664c6e60b324453ca3158ea159b1e880ba57ea229fbdc58e7ba5d9d2"
)

for package_pin in "${PINNED_PACKAGES[@]}"; do
  read -r package_name package_sha256 <<< "$package_pin"
  package_path="$PACKAGE_DIR/$package_name"
  package_tar="$BUILD_DIR/${package_name%.zst}"
  curl -fsSL "$PACKAGE_URL/$package_name" -o "$package_path"
  echo "$package_sha256  $package_path" | sha256sum -c -
  node -e 'const fs = require("node:fs"); const {zstdDecompressSync} = require("node:zlib"); fs.writeFileSync(process.argv[2], zstdDecompressSync(fs.readFileSync(process.argv[1])))' "$package_path" "$package_tar"
  tar -xf "$package_tar" -C "$STAGING"
done

copy_runtime_dlls() {
  local source_bin="$1"
  local destination_bin="$2"
  local dll_path
  shopt -s nullglob
  for dll_path in "$source_bin"/*.dll; do
    if [ "${dll_path##*/}" = libpango_training.dll ]; then
      continue
    fi
    cp "$dll_path" "$destination_bin/"
  done
  shopt -u nullglob
}

STAGING_BIN="$STAGING/clangarm64/bin"
for family in poppler qpdf djvulibre; do
  rm -rf "$PROJECT_ROOT/resources/$family/$TARGET"
  mkdir -p "$PROJECT_ROOT/resources/$family/$TARGET/bin"
done
mkdir -p "$PROJECT_ROOT/resources/poppler/$TARGET/share" "$PROJECT_ROOT/resources/poppler/$TARGET/etc"
for tool in pdfinfo pdftoppm pdftotext pdfimages pdftocairo; do
  cp "$STAGING_BIN/$tool.exe" "$PROJECT_ROOT/resources/poppler/$TARGET/bin/"
done
cp -R "$STAGING/clangarm64/share/poppler" "$PROJECT_ROOT/resources/poppler/$TARGET/share/"
if [ -d "$STAGING/clangarm64/etc/fonts" ]; then
  cp -R "$STAGING/clangarm64/etc/fonts" "$PROJECT_ROOT/resources/poppler/$TARGET/etc/"
fi
cp "$STAGING_BIN/qpdf.exe" "$PROJECT_ROOT/resources/qpdf/$TARGET/bin/"
for tool in ddjvu djvused djvudump; do
  cp "$STAGING_BIN/$tool.exe" "$PROJECT_ROOT/resources/djvulibre/$TARGET/bin/"
done
for family in poppler qpdf djvulibre; do
  copy_runtime_dlls "$STAGING_BIN" "$PROJECT_ROOT/resources/$family/$TARGET/bin"
  find "$PROJECT_ROOT/resources/$family/$TARGET/bin" -maxdepth 1 -type f \( -iname '*.exe' -o -iname '*.dll' \) > "$BUILD_DIR/$family-pe-files.txt"
  node "$SCRIPT_DIR/release/windows-pe-dependencies.mjs" verify \
    --allowed-machines arm64 \
    --system-dll-pattern-file "$SCRIPT_DIR/win-system-dll-pattern.sh" \
    --file-list "$BUILD_DIR/$family-pe-files.txt"
done

echo "Bundled pinned MSYS2 runtime packages for $TARGET."
