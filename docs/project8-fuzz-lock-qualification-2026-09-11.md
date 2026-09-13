# Project 8 fuzz-lock qualification

Review date: 2026-09-11

Source under review: `19830bd36` (`origin/project8/integration`)

Ticket: [#536](https://github.com/evb0110/evb-viewer/issues/536)

## Current lock state

The affected development-only package is
`native/pdf-page-ops/fuzz`, whose manifest has `publish = false`. Its checked-in
lock resolves the former yanked entry to:

```text
chacha20 0.10.2
rand 0.10.2
```

The production `native/Cargo.lock` resolves the same `chacha20 0.10.2` version.
No lockfile or native source change was needed in this qualification.

## Checks

```text
cargo metadata --manifest-path native/pdf-page-ops/fuzz/Cargo.toml --locked --no-deps --format-version 1
PASS

cargo check --manifest-path native/pdf-page-ops/fuzz/Cargo.toml --locked --bins
Finished `dev` profile [unoptimized + debuginfo]
```

The bounded check compiled both declared fuzz binaries and their page-operations
dependency graph from the checked-in lock. The build used Rust 1.89.0.

The requested advisory command could not run because this VPS does not have the
`cargo-deny` subcommand installed:

```text
cargo deny check advisories --manifest-path native/pdf-page-ops/fuzz/Cargo.toml
error: no such command: `deny`
```

## Result and gap

The lock and bounded compilation acceptance are green, and the result is
development lock hygiene rather than a security advisory claim. Fresh
cargo-deny database-backed advisory proof remains a hosted/tooling gap. This
lane did not edit native source, production dependencies, fuzz targets, browser
code, OCR code, or assistant code.
