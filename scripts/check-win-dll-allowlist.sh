#!/bin/bash
set -euo pipefail

# Validates that all known Windows system DLL dependencies are matched
# by the shared allowlist regex. Catches the exact class of bug where
# new native tools depend on system DLLs not yet in the allowlist.
#
# The KNOWN_SYSTEM_DLLS list is harvested from CI build logs — every
# system DLL our bundled tools actually import at link time.

script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/win-system-dll-pattern.sh"

KNOWN_SYSTEM_DLLS=(
  # Core Windows
  kernel32.dll
  kernelbase.dll
  ntdll.dll
  user32.dll
  gdi32.dll
  advapi32.dll
  shell32.dll
  ole32.dll
  oleaut32.dll
  shlwapi.dll
  imm32.dll
  version.dll

  # Networking
  ws2_32.dll
  iphlpapi.dll
  dnsapi.dll
  mswsock.dll
  wldap32.dll
  normaliz.dll

  # Security / crypto
  crypt32.dll
  secur32.dll
  bcrypt.dll
  bcryptprimitives.dll
  cryptbase.dll
  wintrust.dll
  msasn1.dll
  ncrypt.dll
  sspicli.dll

  # RPC / COM
  rpcrt4.dll
  comctl32.dll
  comdlg32.dll
  propsys.dll

  # C runtime
  msvcrt.dll
  ucrtbase.dll
  vcruntime140.dll
  msvcp140.dll
  concrt140.dll

  # Graphics / display
  dwmapi.dll
  dwrite.dll
  d2d1.dll
  d3d11.dll
  d3d9.dll
  dxgi.dll
  dxva2.dll
  opengl32.dll
  uxtheme.dll
  usp10.dll
  shcore.dll

  # Misc system
  dbghelp.dll
  winmm.dll
  setupapi.dll
  powrprof.dll
  cfgmgr32.dll
  winspool.drv
  netapi32.dll
  userenv.dll
  mpr.dll
  wtsapi32.dll
  psapi.dll

  # Wildcard-matched families (test representative names)
  api-ms-win-crt-runtime-l1-1-0.dll
  api-ms-win-core-synch-l1-2-0.dll
  ext-ms-win-ntuser-uicontext-ext-l1-1-0.dll
  xinput1_4.dll
  xinput9_1_0.dll
  d3dcompiler_47.dll
  vcruntime140_1.dll
  msvcp140_1.dll
  concrt140_1.dll
)

# DLLs that bundled tools import WITHOUT the lib prefix, but we bundle
# WITH the lib prefix (MinGW naming convention). These validate the
# lib-prefix fallback logic in verify-packaged-native-tools.sh.
KNOWN_LIBPREFIX_ALIASES=(
  glib-2.0-0.dll
  gobject-2.0-0.dll
  gio-2.0-0.dll
  gmodule-2.0-0.dll
  intl-8.dll
)

echo "== Checking Windows system DLL allowlist =="

failures=0

for dll in "${KNOWN_SYSTEM_DLLS[@]}"; do
  dll_lc="$(printf '%s' "$dll" | tr '[:upper:]' '[:lower:]')"
  if ! [[ "$dll_lc" =~ $system_dll_pattern ]]; then
    echo "  FAIL  System DLL not matched by allowlist: $dll"
    failures=$((failures + 1))
  fi
done

if [ "$failures" -ne 0 ]; then
  echo "ERROR: $failures known system DLL(s) not matched by the allowlist regex."
  echo "Update scripts/win-system-dll-pattern.sh to include the missing DLLs."
  exit 1
fi

echo "  OK    All ${#KNOWN_SYSTEM_DLLS[@]} known system DLLs matched by allowlist"
echo "  INFO  ${#KNOWN_LIBPREFIX_ALIASES[@]} lib-prefix aliases documented (validated at CI time)"
echo "Windows DLL allowlist check passed."
