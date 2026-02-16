#!/bin/bash
# Shared Windows system DLL allowlist pattern.
# Sourced by verify-packaged-native-tools.sh (CI) and check-win-dll-allowlist.sh (local).
# Single source of truth — edit HERE when adding new system DLLs.

system_dll_pattern='^(api-ms-win-.*\.dll|ext-ms-.*\.dll|kernel32\.dll|kernelbase\.dll|user32\.dll|gdi32\.dll|advapi32\.dll|shell32\.dll|ole32\.dll|oleaut32\.dll|ws2_32\.dll|comdlg32\.dll|comctl32\.dll|shlwapi\.dll|crypt32\.dll|secur32\.dll|rpcrt4\.dll|imm32\.dll|version\.dll|bcrypt\.dll|bcryptprimitives\.dll|ntdll\.dll|dbghelp\.dll|iphlpapi\.dll|winmm\.dll|setupapi\.dll|wldap32\.dll|normaliz\.dll|powrprof\.dll|cfgmgr32\.dll|winspool\.drv|netapi32\.dll|userenv\.dll|wintrust\.dll|dnsapi\.dll|msasn1\.dll|cryptbase\.dll|uxtheme\.dll|msvcrt\.dll|ucrtbase\.dll|vcruntime[0-9_]*\.dll|msvcp[0-9_]*\.dll|concrt[0-9_]*\.dll|usp10\.dll|dwrite\.dll|dwmapi\.dll|wtsapi32\.dll|d2d1\.dll|d3d11\.dll|d3d9\.dll|dxgi\.dll|dxva2\.dll|mpr\.dll|opengl32\.dll|xinput[0-9_]*\.dll|d3dcompiler_[0-9]*\.dll|mswsock\.dll|psapi\.dll|sspicli\.dll|ncrypt\.dll|propsys\.dll|shcore\.dll|wininet\.dll|msimg32\.dll)$'
