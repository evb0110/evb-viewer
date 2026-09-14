#!/bin/bash
# Shared relocation policy for Homebrew-backed macOS native-tool bundles.
# Callers seed their tool-specific binaries and primary dylibs, then invoke
# macos_bundle_dylib_closure to copy, rewrite, and verify every non-system dylib.

macos_is_system_dylib_reference() {
  case "$1" in
    /usr/lib/*|/System/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

macos_list_dylib_dependencies() {
  otool -L "$1" | awk 'NR > 1 {print $1}'
}

macos_resolve_dylib_source() {
  local dependency="$1"
  local search_root="$2"
  local dependency_name
  dependency_name="$(basename "$dependency")"

  if [ -f "$dependency" ]; then
    printf '%s\n' "$dependency"
    return 0
  fi

  local search_directory
  for search_directory in "$search_root/Cellar" "$search_root/lib" "$search_root/opt"; do
    [ -d "$search_directory" ] || continue
    local candidate
    candidate="$(find "$search_directory" \( -type f -o -type l \) \
      -name "$dependency_name" -print -quit 2>/dev/null || true)"
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

macos_copy_dylib_closure() {
  local destination_lib="$1"
  local search_root="$2"
  shift 2
  local files=("$@")
  local added=1

  while [ "$added" -gt 0 ]; do
    added=0
    local file
    for file in "${files[@]}"; do
      [ -f "$file" ] || continue

      local dependency
      for dependency in $(macos_list_dylib_dependencies "$file"); do
        if macos_is_system_dylib_reference "$dependency"; then
          continue
        fi

        local dependency_name
        dependency_name="$(basename "$dependency")"
        if [ -f "$destination_lib/$dependency_name" ]; then
          continue
        fi

        local dependency_source
        dependency_source="$(macos_resolve_dylib_source "$dependency" "$search_root" || true)"
        if [ -z "$dependency_source" ]; then
          echo "Error: Unable to resolve non-system dependency $dependency (referenced by $file)"
          return 1
        fi

        cp -L "$dependency_source" "$destination_lib/$dependency_name"
        echo "    Copied transitive dependency: $dependency_name"
        files+=("$destination_lib/$dependency_name")
        added=1
      done
    done
  done
}

macos_rewrite_library_paths() {
  local destination_lib="$1"
  local library="$2"
  local library_name
  library_name="$(basename "$library")"

  install_name_tool -id "@loader_path/$library_name" "$library"

  local dependency
  for dependency in $(macos_list_dylib_dependencies "$library"); do
    macos_is_system_dylib_reference "$dependency" && continue

    local dependency_name
    dependency_name="$(basename "$dependency")"
    if [ ! -f "$destination_lib/$dependency_name" ]; then
      echo "Error: Bundled dependency closure is missing $dependency_name (referenced by $library)"
      return 1
    fi

    local relocated_dependency="@loader_path/$dependency_name"
    if [ "$dependency" != "$relocated_dependency" ]; then
      install_name_tool -change "$dependency" "$relocated_dependency" "$library"
    fi
  done
}

macos_rewrite_binary_paths() {
  local destination_lib="$1"
  local binary="$2"

  local dependency
  for dependency in $(macos_list_dylib_dependencies "$binary"); do
    macos_is_system_dylib_reference "$dependency" && continue

    local dependency_name
    dependency_name="$(basename "$dependency")"
    if [ ! -f "$destination_lib/$dependency_name" ]; then
      echo "Error: Bundled dependency closure is missing $dependency_name (referenced by $binary)"
      return 1
    fi

    local relocated_dependency="@executable_path/../lib/$dependency_name"
    if [ "$dependency" != "$relocated_dependency" ]; then
      install_name_tool -change "$dependency" "$relocated_dependency" "$binary"
    fi
  done
}

macos_verify_relocated_file() {
  local destination_lib="$1"
  local file_kind="$2"
  local file="$3"

  local dependency
  for dependency in $(macos_list_dylib_dependencies "$file"); do
    macos_is_system_dylib_reference "$dependency" && continue

    local dependency_name
    dependency_name="$(basename "$dependency")"
    if [ ! -f "$destination_lib/$dependency_name" ]; then
      echo "Error: Bundled dependency closure is missing $dependency_name (referenced by $file)"
      return 1
    fi

    local expected_dependency
    if [ "$file_kind" = "library" ]; then
      expected_dependency="@loader_path/$dependency_name"
    else
      expected_dependency="@executable_path/../lib/$dependency_name"
    fi
    if [ "$dependency" != "$expected_dependency" ]; then
      echo "Error: Unrelocated dependency $dependency remains in $file (expected $expected_dependency)"
      return 1
    fi
  done
}

macos_bundle_dylib_closure() {
  local destination_lib="$1"
  local search_root="$2"
  shift 2
  local binaries=("$@")

  macos_copy_dylib_closure "$destination_lib" "$search_root" \
    "${binaries[@]}" "$destination_lib/"*.dylib

  local library
  for library in "$destination_lib/"*.dylib; do
    [ -f "$library" ] || continue
    macos_rewrite_library_paths "$destination_lib" "$library"
  done

  local binary
  for binary in "${binaries[@]}"; do
    [ -f "$binary" ] || continue
    macos_rewrite_binary_paths "$destination_lib" "$binary"
  done

  for library in "$destination_lib/"*.dylib; do
    [ -f "$library" ] || continue
    macos_verify_relocated_file "$destination_lib" library "$library"
  done
  for binary in "${binaries[@]}"; do
    [ -f "$binary" ] || continue
    macos_verify_relocated_file "$destination_lib" binary "$binary"
  done
}
