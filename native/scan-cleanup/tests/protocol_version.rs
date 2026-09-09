use std::process::Command;

#[test]
fn protocol_version_flag_prints_supported_protocol() {
    let output = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .arg("--protocol-version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "{\"protocolVersion\":10,\"capabilities\":[\"manifest-v3\",\"structured-warning-events\"]}\n"
    );
    assert_eq!(String::from_utf8(output.stderr).unwrap(), "");
}

#[test]
fn standard_version_flags_print_descriptor_name_and_package_version() {
    for flag in ["--version", "-V"] {
        let output = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .arg(flag)
            .output()
            .unwrap();
        assert!(output.status.success(), "{flag} failed");
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "{} {}\n",
                evb_native_support::generated_native_tool_protocols::SCAN_CLEANUP.binary_name,
                env!("CARGO_PKG_VERSION"),
            ),
        );
        assert_eq!(String::from_utf8(output.stderr).unwrap(), "");
    }
}

#[test]
fn manifest_diagnostics_are_opt_in_and_reset_between_runs() {
    let path = std::env::temp_dir().join(format!(
        "evb-scan-cleanup-diagnostics-{}.json",
        std::process::id()
    ));
    std::fs::write(
        &path,
        r#"{"version":3,"operation":"analyze","renderMode":"preview","canvasScope":"page","futureRoot":true,"pages":[]}"#,
    )
    .unwrap();

    let run = |enabled: bool| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"));
        command.arg("--manifest").arg(&path);
        if enabled {
            command.env("EVB_SCAN_CLEANUP_PROTOCOL_DIAGNOSTICS", "1");
        } else {
            command.env_remove("EVB_SCAN_CLEANUP_PROTOCOL_DIAGNOSTICS");
        }
        command.output().unwrap()
    };

    let disabled = run(false);
    assert!(!String::from_utf8_lossy(&disabled.stderr).contains("ignored unknown field"));
    let enabled = run(true);
    let enabled_stderr = String::from_utf8_lossy(&enabled.stderr);
    assert_eq!(enabled_stderr.matches("$.futureRoot").count(), 1);
    let enabled_again = run(true);
    assert_eq!(
        String::from_utf8_lossy(&enabled_again.stderr)
            .matches("$.futureRoot")
            .count(),
        1
    );
    std::fs::remove_file(path).unwrap();
}
