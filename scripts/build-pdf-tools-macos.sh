#!/usr/bin/env bash
# Build the Darwin PDF/DjVu payloads and their dependency closure from source.
# Homebrew supplies build tools only; none of its bottles enter the archives.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
[ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || { echo 'Apple Silicon macOS is required.' >&2; exit 1; }
MACOSX_DEPLOYMENT_TARGET="$(awk '/^  minimumSystemVersion:/ {gsub(/"/, "", $2); print $2}' "$PROJECT_ROOT/electron-builder.yml")"
[ -n "$MACOSX_DEPLOYMENT_TARGET" ] || { echo 'Missing macOS minimumSystemVersion.' >&2; exit 1; }
TMP_ROOT="${TMPDIR:-$PROJECT_ROOT/.devkit/tmp}"
mkdir -p "$TMP_ROOT"
BUILD_DIR="$(mktemp -d "$TMP_ROOT/pdf-tools-macos-XXXXXX")"
trap 'rm -rf -- "$BUILD_DIR"' EXIT
PREFIX="$BUILD_DIR/prefix"
JOBS="${CMAKE_BUILD_PARALLEL_LEVEL:-2}"
CC="$(xcrun --find clang)"
CXX="$(xcrun --find clang++)"
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export MACOSX_DEPLOYMENT_TARGET CC CXX SDKROOT
export CFLAGS="-O2 -ffile-prefix-map=$BUILD_DIR=." CXXFLAGS="-O2 -ffile-prefix-map=$BUILD_DIR=."
export CPPFLAGS="-I$PREFIX/include" LDFLAGS="-L$PREFIX/lib"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig" PKG_CONFIG_PATH=
mkdir -p "$PREFIX"
fetch() {
  local url="$1" sha="$2" archive="$BUILD_DIR/${1##*/}"
  curl --connect-timeout 30 --max-time 300 -fsSL "$url" -o "$archive"
  echo "$sha  $archive" | shasum -a 256 -c -
  tar -xf "$archive" -C "$BUILD_DIR"
}
fetch https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
fetch https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.2.0/libjpeg-turbo-3.2.0.tar.gz 6f30092cef9fb839779646608f4ee14ae3cbac989c47fa05e841b0841f09878e
fetch https://download.osgeo.org/libtiff/tiff-4.7.2.tar.gz 672bd7d10aee4606171afb864f3570b83340f6a33e2c186dc0512f7145ffdf6a
fetch https://downloads.sourceforge.net/project/libpng/libpng16/1.6.58/libpng-1.6.58.tar.xz 28eb403f51f0f7405249132cecfe82ea5c0ef97f1b32c5a65828814ae0d34775
fetch https://downloads.sourceforge.net/project/freetype/freetype2/2.15.0/freetype-2.15.0.tar.xz 93cd47eb719c325107f2d3cf087d06299e944c3b48a40b55537302304dea1dd5
fetch https://gitlab.freedesktop.org/fontconfig/fontconfig/-/archive/2.17.1/fontconfig-2.17.1.tar.gz 82e73b26adad651b236e5f5d4b3074daf8ff0910188808496326bd3449e5261d
fetch https://downloads.sourceforge.net/project/lcms/lcms/2.19.1/lcms2-2.19.1.tar.gz bfc54f7bab59fbc921012014a8032e4cba4abd46db47d46b76416a8c0b2815c8
fetch https://github.com/uclouvain/openjpeg/archive/refs/tags/v2.5.4.tar.gz a695fbe19c0165f295a8531b1e4e855cd94d0875d2f88ec4b61080677e27188a
fetch https://poppler.freedesktop.org/poppler-26.02.0.tar.xz dded8621f7b2f695c91063aab1558691c8418374cd583501e89ed39487e7ab77
fetch https://poppler.freedesktop.org/poppler-data-0.4.12.tar.gz c835b640a40ce357e1b83666aabd95edffa24ddddd49b8daff63adb851cdab74
fetch https://github.com/qpdf/qpdf/releases/download/v12.3.2/qpdf-12.3.2.tar.gz 6cba2f9f2cd887d905faeb99e0e51a307b217920d1bbf3e9cfbb2e8178a2deda
fetch https://downloads.sourceforge.net/djvu/djvulibre-3.5.30.tar.gz ee5e457d4cfebe566f94b99e5e3d3cc7f5c79ddb741c2ac2ba2e456f00329644
cmake_configure() {
  local source="$1"; shift
  cmake -S "$BUILD_DIR/$source" -B "$BUILD_DIR/$source/build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_PREFIX_PATH="$PREFIX" \
    -DCMAKE_IGNORE_PREFIX_PATH='/opt/homebrew;/usr/local' \
    -DCMAKE_SYSTEM_IGNORE_PREFIX_PATH='/opt/homebrew;/usr/local' \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DBUILD_SHARED_LIBS=ON "$@"
}
cmake_install() {
  local source="$1"; shift
  cmake_configure "$source" "$@"
  cmake --build "$BUILD_DIR/$source/build" --parallel "$JOBS"
  cmake --install "$BUILD_DIR/$source/build"
}
cmake_install zlib-1.3.2 -DZLIB_BUILD_TESTING=OFF -DZLIB_BUILD_STATIC=OFF
cmake_install libjpeg-turbo-3.2.0 -DENABLE_SHARED=ON -DENABLE_STATIC=OFF -DWITH_TURBOJPEG=OFF
cmake_install libpng-1.6.58 -DPNG_TESTS=OFF -DPNG_TOOLS=OFF -DPNG_STATIC=OFF -DPNG_FRAMEWORK=OFF
cmake_install tiff-4.7.2 \
  -Dtiff-tools=OFF -Dtiff-tests=OFF -Dtiff-contrib=OFF -Dtiff-docs=OFF -Dtiff-cxx=OFF \
  -Djbig=OFF -Dlerc=OFF -Dlzma=OFF -Dzstd=OFF -Dwebp=OFF -Dlibdeflate=OFF
cmake_install freetype-2.15.0 -DFT_DISABLE_BROTLI=ON -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BZIP2=ON
cmake_install openjpeg-2.5.4 -DBUILD_CODEC=OFF -DBUILD_TESTING=OFF
(
  cd "$BUILD_DIR/lcms2-2.19.1"
  ./configure --prefix="$PREFIX" --disable-static --without-jpeg --without-tiff
  make -j"$JOBS"
  make install
)
meson setup "$BUILD_DIR/fontconfig-build" "$BUILD_DIR/fontconfig-2.17.1" \
  --prefix="$PREFIX" --libdir=lib --default-library=shared --buildtype=release --wrap-mode=nofallback \
  -Dnls=disabled -Ddoc=disabled -Dtests=disabled \
  -Dtools=disabled -Dcache-build=disabled -Dxml-backend=expat \
  -Ddefault-fonts-dirs=/System/Library/Fonts,/Library/Fonts,~/Library/Fonts \
  -Dadditional-fonts-dirs=no
meson compile -C "$BUILD_DIR/fontconfig-build" -j "$JOBS"
meson install -C "$BUILD_DIR/fontconfig-build"
# Keep raster, JPEG 2000, color management, font substitution and CMap support.
# GUI wrappers, HTTP, signatures and Cairo are unused by our four CLI tools.
cmake_configure poppler-26.02.0 \
  -DENABLE_BOOST=OFF -DENABLE_CPP=OFF -DENABLE_GLIB=OFF -DENABLE_QT5=OFF -DENABLE_QT6=OFF \
  -DENABLE_LIBCURL=OFF -DENABLE_NSS3=OFF -DENABLE_GPGME=OFF \
  -DCMAKE_DISABLE_FIND_PACKAGE_Cairo=ON -DCMAKE_DISABLE_FIND_PACKAGE_Intl=ON \
  -DBUILD_GTK_TESTS=OFF -DBUILD_QT5_TESTS=OFF -DBUILD_QT6_TESTS=OFF \
  -DBUILD_CPP_TESTS=OFF -DBUILD_MANUAL_TESTS=OFF \
  -DCMAKE_INSTALL_DATADIR=share
cmake --build "$BUILD_DIR/poppler-26.02.0/build" --parallel "$JOBS" --target pdfinfo pdftoppm pdftotext pdfimages
# Only the four utilities were built, so stage their library without installing
# the unbuilt GUI/test/utility targets.
cp -P "$BUILD_DIR/poppler-26.02.0/build/"libpoppler*.dylib "$PREFIX/lib/"
# qpdf's built-in crypto removes the OpenSSL bottle dependency (as on Linux).
# libqpdf stays a shared library: pdf-page-ops loads it beside qpdf to read a
# large document's metadata selectively, and without it falls back to reading
# every object, which the largest documents exceed. The CLI links it, so the
# dylib closure below ships it.
cmake_configure qpdf-12.3.2 -DBUILD_STATIC_LIBS=OFF \
  -DREQUIRE_CRYPTO_NATIVE=ON -DUSE_IMPLICIT_CRYPTO=OFF -DBUILD_DOC=OFF -DINSTALL_EXAMPLES=OFF
cmake --build "$BUILD_DIR/qpdf-12.3.2/build" --parallel "$JOBS" --target qpdf
find "$BUILD_DIR/qpdf-12.3.2/build/libqpdf" -maxdepth 1 -name 'libqpdf*.dylib' -exec cp -P {} "$PREFIX/lib/" \;
(
  cd "$BUILD_DIR/djvulibre-3.5.30"
  ./configure --prefix="$PREFIX" --disable-static --enable-shared --disable-xmltools --disable-desktopfiles \
    JPEG_LIBS="-L$PREFIX/lib -ljpeg" TIFF_LIBS="-L$PREFIX/lib -ltiff -ljpeg -lz"
  make -j"$JOBS" -C libdjvu
  make -j"$JOBS" -C tools ddjvu djvused djvudump
  make -C libdjvu install
)
# shellcheck source=scripts/lib/macos-dylib-bundle.sh
source "$SCRIPT_DIR/lib/macos-dylib-bundle.sh"
for family in poppler qpdf djvulibre; do
  stage="$BUILD_DIR/$family-stage"
  mkdir -p "$stage/bin" "$stage/lib"
  case "$family" in
    poppler)
      for tool in pdfinfo pdftoppm pdftotext pdfimages; do
        cp "$BUILD_DIR/poppler-26.02.0/build/utils/$tool" "$stage/bin/"
      done
      mkdir -p "$stage/share/poppler" "$stage/etc"
      cp -R "$BUILD_DIR/poppler-data-0.4.12/" "$stage/share/poppler/"
      cp -RL "$PREFIX/etc/fonts" "$stage/etc/"
      # Drop build-host paths. FONTCONFIG_PATH/FILE are supplied by the app.
      sed -i '' -e "s|$PREFIX/etc/fonts/conf.d|conf.d|g" \
        -e "\|<cachedir>$PREFIX/|d" "$stage/etc/fonts/fonts.conf"
      # Fontconfig includes its conf.d snippets relatively within the bundle.
      ;;
    qpdf) cp "$BUILD_DIR/qpdf-12.3.2/build/qpdf/qpdf" "$stage/bin/" ;;
    djvulibre)
      for tool in ddjvu djvused djvudump; do
        cp "$BUILD_DIR/djvulibre-3.5.30/tools/.libs/$tool" "$stage/bin/"
      done
      ;;
  esac
  macos_bundle_dylib_closure "$stage/lib" "$PREFIX" "$stage/bin/"*
  destination="$PROJECT_ROOT/resources/$family/darwin-arm64"
  mkdir -p "$(dirname "$destination")"
  rm -rf "$destination"
  mv "$stage" "$destination"
done
smoke_tool() {
  local tool="$1" family="$2" status=0
  shift 2
  local output="$BUILD_DIR/$tool-smoke.log"
  "$PROJECT_ROOT/resources/$family/darwin-arm64/bin/$tool" "$@" >"$output" 2>&1 || status=$?
  node "$SCRIPT_DIR/release/assert-packaged-tool-smoke.mjs" "$tool" "$status" "$output"
  cat "$output"
}
smoke_tool qpdf qpdf --version
compgen -G "$PROJECT_ROOT/resources/qpdf/darwin-arm64/lib/libqpdf*.dylib" >/dev/null \
  || { echo "Error: the qpdf bundle has no libqpdf for pdf-page-ops" >&2; exit 1; }
smoke_tool pdftoppm poppler -v
smoke_tool ddjvu djvulibre --help
