#![cfg_attr(windows, windows_subsystem = "windows")]

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

mod exchange_paths;
#[cfg(unix)]
mod posix;
#[cfg(windows)]
mod windows;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    ProcessStartTimeHost,
    ProcessIdentity {
        pid: u32,
    },
    ExchangePaths {
        staged: PathBuf,
        destination: PathBuf,
    },
    #[cfg_attr(not(windows), allow(dead_code))]
    WindowsJob {
        control_pipe: OsString,
        hide: bool,
        memory_limit_bytes: Option<u64>,
        command_args: Vec<OsString>,
    },
    #[cfg_attr(not(unix), allow(dead_code))]
    PosixJob {
        event_fd: i32,
        command_fd: i32,
        memory_limit_bytes: Option<u64>,
        command_args: Vec<OsString>,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ProcessIdentity {
    pub executable_path: String,
    pub arguments: Vec<String>,
    pub start_time: String,
    pub parent_pid: Option<u32>,
    pub environment: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartTimeResult {
    Found(String),
    Gone,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Denied,
}

fn parse_positive_u64(value: &OsString, flag: &str) -> io::Result<u64> {
    let text = value.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{flag} value must be UTF-8"),
        )
    })?;
    let parsed = text.parse::<u64>().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{flag} must be a positive integer"),
        )
    })?;
    if parsed == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{flag} must be greater than zero"),
        ));
    }
    Ok(parsed)
}

fn parse_pid(value: &OsString) -> io::Result<u32> {
    let text = value
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "pid must be UTF-8"))?;
    let parsed = text.parse::<u32>().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "pid must be a positive integer",
        )
    })?;
    if parsed == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pid must be greater than zero",
        ));
    }
    Ok(parsed)
}

fn parse_posix_fd(value: &OsString, flag: &str) -> io::Result<i32> {
    let fd_text = value.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, format!("{flag} must be UTF-8"))
    })?;
    let fd = fd_text.parse::<i32>().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{flag} must be a valid integer"),
        )
    })?;
    if fd < 3 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{flag} must be >= 3"),
        ));
    }
    Ok(fd)
}

fn parse_optional_flags(
    arguments: &[OsString],
    start_index: usize,
    allow_posix_command_fd: bool,
) -> io::Result<(Option<u64>, Option<i32>, usize)> {
    let mut index = start_index;
    let mut memory_limit_bytes = None;
    let mut command_fd = None;
    while index < arguments.len() {
        if arguments[index] == "--" {
            return Ok((memory_limit_bytes, command_fd, index));
        }
        if arguments[index] == "--memory-limit-bytes" {
            let value = arguments.get(index + 1).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "--memory-limit-bytes requires a value",
                )
            })?;
            memory_limit_bytes = Some(parse_positive_u64(value, "--memory-limit-bytes")?);
            index += 2;
            continue;
        }
        if allow_posix_command_fd && arguments[index] == "--posix-command-fd" {
            let value = arguments.get(index + 1).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "--posix-command-fd requires a file descriptor",
                )
            })?;
            command_fd = Some(parse_posix_fd(value, "--posix-command-fd")?);
            index += 2;
            continue;
        }
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unexpected launcher option before --",
        ));
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "missing -- command separator",
    ))
}

pub(crate) fn parse_mode(arguments: &[OsString]) -> io::Result<Mode> {
    let first = arguments.first().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected launcher arguments or --process-start-time-host / --process-identity <pid>",
        )
    })?;

    if first == "--process-start-time-host" {
        if arguments.len() != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "--process-start-time-host accepts no additional arguments",
            ));
        }
        return Ok(Mode::ProcessStartTimeHost);
    }

    if first == "--process-identity" {
        if arguments.len() != 2 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected --process-identity <pid>",
            ));
        }
        return Ok(Mode::ProcessIdentity {
            pid: parse_pid(&arguments[1])?,
        });
    }

    if first == "--exchange-paths" {
        if arguments.len() != 3 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected --exchange-paths <staged> <destination>",
            ));
        }
        return Ok(Mode::ExchangePaths {
            staged: PathBuf::from(&arguments[1]),
            destination: PathBuf::from(&arguments[2]),
        });
    }

    if first == "--posix-fd" {
        let fd_arg = arguments.get(1).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "--posix-fd requires a file descriptor",
            )
        })?;
        let event_fd = parse_posix_fd(fd_arg, "--posix-fd")?;
        let (memory_limit_bytes, command_fd, separator_index) =
            parse_optional_flags(arguments, 2, true)?;
        let command_args = arguments[separator_index + 1..].to_vec();
        if command_args.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected COMMAND after --",
            ));
        }
        return Ok(Mode::PosixJob {
            event_fd,
            command_fd: command_fd.unwrap_or(event_fd),
            memory_limit_bytes,
            command_args,
        });
    }

    if arguments.len() < 4 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected CONTROL HIDE [--memory-limit-bytes BYTES] -- COMMAND [ARGS]",
        ));
    }
    let (memory_limit_bytes, _, separator_index) = parse_optional_flags(arguments, 2, false)?;
    let command_args = arguments[separator_index + 1..].to_vec();
    if command_args.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected COMMAND after --",
        ));
    }
    Ok(Mode::WindowsJob {
        control_pipe: arguments[0].clone(),
        hide: arguments[1] == "1",
        memory_limit_bytes,
        command_args,
    })
}

#[cfg(any(windows, test))]
pub(crate) fn quote_argument(argument: &[u16], output: &mut Vec<u16>) {
    output.push(b'"' as u16);
    let mut slashes = 0;
    for &character in argument {
        if character == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        if character == b'"' as u16 {
            output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2 + 1));
        } else {
            output.extend(std::iter::repeat_n(b'\\' as u16, slashes));
        }
        slashes = 0;
        output.push(character);
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    output.push(b'"' as u16);
}

/// Parses a Windows command line following Win32 `CommandLineToArgvW` rules.
#[cfg(any(windows, test))]
pub(crate) fn parse_windows_command_line(command_line: &str) -> Vec<String> {
    let chars: Vec<char> = command_line.chars().collect();
    let len = chars.len();
    let mut index = 0;
    let mut args = Vec::new();

    while index < len && (chars[index] == ' ' || chars[index] == '\t') {
        index += 1;
    }
    if index >= len {
        return args;
    }

    // argv[0] uses simpler quoting rules (no backslash escaping).
    let mut argv0 = String::new();
    let mut in_quotes = false;
    while index < len {
        let ch = chars[index];
        if ch == '"' {
            in_quotes = !in_quotes;
        } else if !in_quotes && (ch == ' ' || ch == '\t') {
            break;
        } else {
            argv0.push(ch);
        }
        index += 1;
    }
    args.push(argv0);

    loop {
        while index < len && (chars[index] == ' ' || chars[index] == '\t') {
            index += 1;
        }
        if index >= len {
            break;
        }
        let mut arg = String::new();
        let mut quoted = false;
        while index < len {
            let mut slashes = 0;
            while index < len && chars[index] == '\\' {
                slashes += 1;
                index += 1;
            }
            if index < len && chars[index] == '"' {
                for _ in 0..(slashes / 2) {
                    arg.push('\\');
                }
                if slashes % 2 == 1 {
                    arg.push('"');
                    index += 1;
                } else {
                    index += 1;
                    if quoted && index < len && chars[index] == '"' {
                        // Doubled quote inside quoted section emits a literal quote.
                        arg.push('"');
                        index += 1;
                    } else {
                        quoted = !quoted;
                    }
                }
                continue;
            }
            for _ in 0..slashes {
                arg.push('\\');
            }
            if index >= len {
                break;
            }
            let ch = chars[index];
            if !quoted && (ch == ' ' || ch == '\t') {
                break;
            }
            arg.push(ch);
            index += 1;
        }
        args.push(arg);
    }

    args
}

/// Converts Windows `FILETIME` (100-nanosecond intervals since 1601-01-01T00:00:00Z)
/// into the exact UTC ISO 8601 format produced by .NET `ToString("o")`.
#[cfg(any(windows, test))]
pub(crate) fn format_filetime_iso8601(ticks_100ns: u64) -> Option<String> {
    const TICKS_PER_SECOND: u64 = 10_000_000;
    const SECONDS_PER_DAY: u64 = 86_400;
    // Days between 1601-01-01 and 1970-01-01 (Unix epoch).
    const DAYS_1601_TO_1970: i64 = 134_774;

    let total_seconds = ticks_100ns / TICKS_PER_SECOND;
    let frac_ticks = ticks_100ns % TICKS_PER_SECOND;
    let days_since_1601 = i64::try_from(total_seconds / SECONDS_PER_DAY).ok()?;
    let secs_of_day = total_seconds % SECONDS_PER_DAY;
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;

    // Howard Hinnant's civil-from-days algorithm (days relative to 1970-01-01).
    let z = days_since_1601 - DAYS_1601_TO_1970 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = y + i64::from(month <= 2);
    if !(0..=9999).contains(&year) {
        return None;
    }

    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{frac_ticks:07}Z"
    ))
}

fn push_json_string(value: &str, out: &mut String) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write as _;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub(crate) fn format_process_identity_json(identity: &ProcessIdentity) -> String {
    let mut out = String::with_capacity(256);
    out.push_str("{\"executablePath\":");
    push_json_string(&identity.executable_path, &mut out);
    out.push_str(",\"arguments\":[");
    for (index, argument) in identity.arguments.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_json_string(argument, &mut out);
    }
    out.push_str("],\"startTime\":");
    push_json_string(&identity.start_time, &mut out);
    if let Some(parent_pid) = identity.parent_pid {
        use std::fmt::Write as _;
        let _ = write!(out, ",\"parentPid\":{parent_pid}");
    }
    if let Some(environment) = &identity.environment {
        out.push_str(",\"environment\":");
        push_json_string(environment, &mut out);
    }
    out.push('}');
    out
}

#[cfg(any(unix, test))]
pub(crate) fn parse_terminate_grace_ms(line: &str) -> u64 {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix("terminate") {
        let rest = rest.trim();
        if !rest.is_empty() {
            if let Ok(grace_ms) = rest.parse::<u64>() {
                return grace_ms;
            }
        }
    }
    0
}

fn run_main() -> io::Result<i32> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let mode = parse_mode(&arguments)?;
    match mode {
        Mode::ProcessStartTimeHost => {
            #[cfg(windows)]
            {
                windows::run_start_time_host()?;
                Ok(0)
            }
            #[cfg(unix)]
            {
                posix::run_start_time_host()?;
                Ok(0)
            }
        }
        Mode::ProcessIdentity { pid } => {
            #[cfg(windows)]
            let identity = windows::read_process_identity(pid);
            #[cfg(unix)]
            let identity = posix::read_process_identity(pid);
            if let Some(identity) = identity {
                println!("{}", format_process_identity_json(&identity));
                Ok(0)
            } else {
                Ok(1)
            }
        }
        Mode::ExchangePaths {
            staged,
            destination,
        } => {
            exchange_paths::run_exchange_paths(&staged, &destination)?;
            Ok(0)
        }
        Mode::WindowsJob {
            control_pipe,
            hide,
            memory_limit_bytes,
            command_args,
        } => {
            #[cfg(windows)]
            {
                windows::run_job_mode(&control_pipe, hide, memory_limit_bytes, &command_args)
                    .map(|code| code as i32)
            }
            #[cfg(not(windows))]
            {
                let _ = (control_pipe, hide, memory_limit_bytes, command_args);
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Windows Job Objects require Windows",
                ))
            }
        }
        Mode::PosixJob {
            event_fd,
            command_fd,
            memory_limit_bytes,
            command_args,
        } => {
            #[cfg(unix)]
            {
                posix::run_job_mode(event_fd, command_fd, memory_limit_bytes, &command_args)
            }
            #[cfg(not(unix))]
            {
                let _ = (event_fd, command_fd, memory_limit_bytes, command_args);
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "POSIX supervisor mode requires Unix",
                ))
            }
        }
    }
}

fn main() {
    match run_main() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Process supervisor failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn preserves_empty_quotes_spaces_and_trailing_backslashes() {
        for (input, expected) in [
            ("", "\"\""),
            ("a b", "\"a b\""),
            ("a\"b", "\"a\\\"b\""),
            ("a\\", "\"a\\\\\""),
            ("a\\\"b", "\"a\\\\\\\"b\""),
        ] {
            let mut actual = Vec::new();
            quote_argument(&input.encode_utf16().collect::<Vec<_>>(), &mut actual);
            assert_eq!(String::from_utf16(&actual).unwrap(), expected);
        }
    }

    #[test]
    fn parses_windows_command_lines_with_quotes_spaces_and_backslashes() {
        assert_eq!(
            parse_windows_command_line(
                r#""C:\Program Files\EVB\evb-scan-cleanup.exe" --manifest "C:\temp\my dir\manifest.json" "a\"b" "c\\""#
            ),
            vec![
                r"C:\Program Files\EVB\evb-scan-cleanup.exe",
                "--manifest",
                r"C:\temp\my dir\manifest.json",
                r#"a"b"#,
                r"c\",
            ]
        );
        assert_eq!(parse_windows_command_line("   "), Vec::<String>::new());
    }

    #[test]
    fn converts_windows_filetime_to_exact_100ns_iso8601() {
        // 1601-01-01T00:00:00.0000000Z
        assert_eq!(
            format_filetime_iso8601(0).as_deref(),
            Some("1601-01-01T00:00:00.0000000Z")
        );
        // 1970-01-01T00:00:00.0000000Z = 116444736000000000 ticks
        assert_eq!(
            format_filetime_iso8601(116_444_736_000_000_000).as_deref(),
            Some("1970-01-01T00:00:00.0000000Z")
        );
        // 2000-02-29T23:59:59.1234567Z (leap day in century divisible by 400)
        // Unix seconds for 2000-02-29T23:59:59Z = 951868799
        let leap_ticks = (11_644_473_600u64 + 951_868_799u64) * 10_000_000 + 1_234_567;
        assert_eq!(
            format_filetime_iso8601(leap_ticks).as_deref(),
            Some("2000-02-29T23:59:59.1234567Z")
        );
        // 2026-10-01T09:59:59.8123456Z (Unix seconds = 1790848799)
        let sample_ticks = (11_644_473_600u64 + 1_790_848_799u64) * 10_000_000 + 8_123_456;
        assert_eq!(
            format_filetime_iso8601(sample_ticks).as_deref(),
            Some("2026-10-01T09:59:59.8123456Z")
        );
    }

    #[test]
    fn parses_all_supervisor_and_identity_modes() {
        assert_eq!(
            parse_mode(&os(&["--process-start-time-host"])).unwrap(),
            Mode::ProcessStartTimeHost
        );
        assert_eq!(
            parse_mode(&os(&["--process-identity", "4242"])).unwrap(),
            Mode::ProcessIdentity { pid: 4242 }
        );
        assert_eq!(
            parse_mode(&os(&["--exchange-paths", "staged.tmp", "dest.pdf"])).unwrap(),
            Mode::ExchangePaths {
                staged: PathBuf::from("staged.tmp"),
                destination: PathBuf::from("dest.pdf"),
            }
        );
        assert!(parse_mode(&os(&["--exchange-paths", "only-one.tmp"])).is_err());
        assert_eq!(
            parse_mode(&os(&[
                r"\\.\pipe\test",
                "1",
                "--memory-limit-bytes",
                "4294967296",
                "--",
                "pdftoppm.exe",
                "in.pdf",
            ]))
            .unwrap(),
            Mode::WindowsJob {
                control_pipe: OsString::from(r"\\.\pipe\test"),
                hide: true,
                memory_limit_bytes: Some(4_294_967_296),
                command_args: os(&["pdftoppm.exe", "in.pdf"]),
            }
        );
        assert_eq!(
            parse_mode(&os(&[
                "--posix-fd",
                "3",
                "--memory-limit-bytes",
                "67108864",
                "--",
                "/usr/bin/pdftoppm",
                "in.pdf",
            ]))
            .unwrap(),
            Mode::PosixJob {
                event_fd: 3,
                command_fd: 3,
                memory_limit_bytes: Some(67_108_864),
                command_args: os(&["/usr/bin/pdftoppm", "in.pdf"]),
            }
        );
        assert_eq!(
            parse_mode(&os(&[
                "--posix-fd",
                "3",
                "--posix-command-fd",
                "4",
                "--memory-limit-bytes",
                "67108864",
                "--",
                "/usr/bin/pdftoppm",
                "in.pdf",
            ]))
            .unwrap(),
            Mode::PosixJob {
                event_fd: 3,
                command_fd: 4,
                memory_limit_bytes: Some(67_108_864),
                command_args: os(&["/usr/bin/pdftoppm", "in.pdf"]),
            }
        );
        assert!(parse_mode(&os(&["--posix-fd", "2", "--", "/bin/true"])).is_err());
        assert!(parse_mode(&os(&[
            "--posix-fd",
            "3",
            "--posix-command-fd",
            "2",
            "--",
            "/bin/true",
        ]))
        .is_err());
        assert!(parse_mode(&os(&[
            "--posix-fd",
            "3",
            "--memory-limit-bytes",
            "0",
            "--",
            "/bin/true"
        ]))
        .is_err());
    }

    #[test]
    fn formats_escaped_process_identity_json() {
        let json = format_process_identity_json(&ProcessIdentity {
            executable_path: "C:\\Program Files\\tool.exe".to_string(),
            arguments: vec!["tool".to_string(), "a\"b\nc".to_string()],
            start_time: "2026-10-01T09:59:59.8123456Z".to_string(),
            parent_pid: Some(1234),
            environment: Some("TMPDIR=/tmp/a\0FOO=1".to_string()),
        });
        assert_eq!(
            json,
            r#"{"executablePath":"C:\\Program Files\\tool.exe","arguments":["tool","a\"b\nc"],"startTime":"2026-10-01T09:59:59.8123456Z","parentPid":1234,"environment":"TMPDIR=/tmp/a\u0000FOO=1"}"#
        );
    }

    #[test]
    fn parses_terminate_grace_values() {
        assert_eq!(parse_terminate_grace_ms("terminate\n"), 0);
        assert_eq!(parse_terminate_grace_ms("terminate 1000\n"), 1000);
        assert_eq!(parse_terminate_grace_ms("terminate invalid\n"), 0);
    }
}
