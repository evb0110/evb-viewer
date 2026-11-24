use std::ffi::{c_void, OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER,
    ERROR_INVALID_PARAMETER, ERROR_IO_PENDING, ERROR_PATH_NOT_FOUND, FILETIME, HANDLE,
    INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_OVERLAPPED};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectAssociateCompletionPortInformation,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateProcessW, GetExitCodeProcess, GetProcessId, GetProcessTimes, OpenProcess,
    QueryFullProcessImageNameW, ResumeThread, TerminateProcess, WaitForSingleObject,
    CREATE_NO_WINDOW, CREATE_SUSPENDED, INFINITE, PROCESS_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES, STARTUPINFOW,
};
use windows_sys::Win32::System::IO::{
    CreateIoCompletionPort, GetOverlappedResult, GetQueuedCompletionStatus,
    PostQueuedCompletionStatus, OVERLAPPED,
};

use crate::{
    format_filetime_iso8601, format_process_identity_json, parse_windows_command_line,
    quote_argument, ProcessIdentity, StartTimeResult,
};

// Standard Win32 job completion messages from <winnt.h>.
const JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO: u32 = 4;
const JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT: u32 = 9;
const JOB_OBJECT_MSG_JOB_MEMORY_LIMIT: u32 = 10;
const SHUTDOWN_COMPLETION_KEY: usize = 1;

// Native NT process info classes requiring only PROCESS_QUERY_LIMITED_INFORMATION.
const PROCESS_BASIC_INFORMATION_CLASS: u32 = 0;
const PROCESS_COMMAND_LINE_INFORMATION_CLASS: u32 = 60;
const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023_u32 as i32;
const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005_u32 as i32;

#[repr(C)]
struct NtProcessBasicInformation {
    exit_status: i32,
    peb_base_address: *mut c_void,
    affinity_mask: usize,
    base_priority: i32,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

#[repr(C)]
struct NtUnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}

#[link(name = "ntdll")]
extern "system" {
    fn NtQueryInformationProcess(
        process_handle: HANDLE,
        process_information_class: u32,
        process_information: *mut c_void,
        process_information_length: u32,
        return_length: *mut u32,
    ) -> i32;
}

fn handle(value: HANDLE) -> io::Result<OwnedHandle> {
    if value.is_null() || value == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // Every caller supplies a fresh, non-inheritable owning handle.
        Ok(unsafe { OwnedHandle::from_raw_handle(value) })
    }
}

fn check(success: i32) -> io::Result<()> {
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn control_io(control: &File, bytes: &mut [u8], writing: bool) -> io::Result<()> {
    let event = handle(unsafe { CreateEventW(null(), 1, 0, null()) })?;
    let mut overlapped: OVERLAPPED = unsafe { zeroed() };
    overlapped.hEvent = event.as_raw_handle();
    let started = unsafe {
        if writing {
            WriteFile(
                control.as_raw_handle(),
                bytes.as_ptr(),
                bytes.len() as u32,
                null_mut(),
                &mut overlapped,
            )
        } else {
            ReadFile(
                control.as_raw_handle(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                null_mut(),
                &mut overlapped,
            )
        }
    };
    if started == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
        return Err(io::Error::last_os_error());
    }
    let mut transferred = 0;
    check(unsafe {
        GetOverlappedResult(control.as_raw_handle(), &overlapped, &mut transferred, 1)
    })?;
    if writing && transferred as usize != bytes.len() {
        return Err(io::Error::from(io::ErrorKind::WriteZero));
    }
    Ok(())
}

fn query_active_processes(job: HANDLE) -> io::Result<u32> {
    let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
    check(unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            null_mut(),
        )
    })?;
    Ok(accounting.ActiveProcesses)
}

fn query_peak_memory_bytes(job: HANDLE) -> u64 {
    let mut extended: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    let ok = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&mut extended as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            null_mut(),
        )
    };
    if ok == 0 {
        return 0;
    }
    (extended
        .PeakJobMemoryUsed
        .max(extended.PeakProcessMemoryUsed)) as u64
}

fn launch_suspended(
    job: HANDLE,
    arguments: &[OsString],
    hide: bool,
) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let mut command_line = Vec::new();
    for argument in arguments {
        if !command_line.is_empty() {
            command_line.push(b' ' as u16);
        }
        let wide: Vec<_> = argument.encode_wide().collect();
        if wide.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NUL in argument",
            ));
        }
        quote_argument(&wide, &mut command_line);
    }
    command_line.push(0);
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.wShowWindow = if hide { 0 } else { 10 };
    // The launcher passes the target's pipes directly, including stdin
    // backpressure. Its separate control pipe and job handle are not inherited.
    startup.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    startup.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    startup.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    check(unsafe {
        CreateProcessW(
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED | if hide { CREATE_NO_WINDOW } else { 0 },
            null(),
            null(),
            &startup,
            &mut process,
        )
    })?;
    let root = handle(process.hProcess)?;
    let thread = handle(process.hThread)?;
    if unsafe { AssignProcessToJobObject(job, root.as_raw_handle()) } == 0 {
        let error = io::Error::last_os_error();
        // Assignment failure must never run uncontained command code.
        check(unsafe { TerminateProcess(root.as_raw_handle(), 1) })?;
        if unsafe { WaitForSingleObject(root.as_raw_handle(), INFINITE) } != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        return Err(error);
    }
    Ok((root, thread))
}

fn format_windows_spawn_error(error: &io::Error) -> String {
    let code = match error.raw_os_error().map(|v| v as u32) {
        Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) => "ENOENT",
        Some(ERROR_ACCESS_DENIED) => "EACCES",
        _ => "ESPAWN",
    };
    let detail = error.to_string().replace(['\r', '\n'], " ");
    format!("{code}: {detail}").chars().take(384).collect()
}

fn run_job(
    control: &mut File,
    arguments: &[OsString],
    hide: bool,
    memory_limit_bytes: Option<u64>,
) -> io::Result<u32> {
    let job = Arc::new(handle(unsafe { CreateJobObjectW(null(), null()) })?);
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if let Some(limit_bytes) = memory_limit_bytes {
        let limit = usize::try_from(limit_bytes).unwrap_or(usize::MAX);
        limits.BasicLimitInformation.LimitFlags |=
            JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.ProcessMemoryLimit = limit;
        limits.JobMemoryLimit = limit;
    }
    check(unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    })?;
    let completion = Arc::new(handle(unsafe {
        CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1)
    })?);
    let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
        CompletionKey: null_mut(),
        CompletionPort: completion.as_raw_handle(),
    };
    check(unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectAssociateCompletionPortInformation,
            (&association as *const JOBOBJECT_ASSOCIATE_COMPLETION_PORT).cast(),
            size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
        )
    })?;
    let (root, thread) = match launch_suspended(job.as_raw_handle(), arguments, hide) {
        Ok(handles) => handles,
        Err(error) => {
            let mut message = format!(
                "spawn_error={}\nempty\n",
                format_windows_spawn_error(&error)
            )
            .into_bytes();
            let _ = control_io(control, &mut message, true);
            return Ok(1);
        }
    };
    control_io(
        control,
        &mut format!("pid={}\n", unsafe { GetProcessId(root.as_raw_handle()) }).into_bytes(),
        true,
    )?;

    let memory_limit_exceeded = Arc::new(AtomicBool::new(false));
    let root_exited = Arc::new(AtomicBool::new(false));
    let iocp_job = Arc::clone(&job);
    let iocp_completion = Arc::clone(&completion);
    let iocp_memory_exceeded = Arc::clone(&memory_limit_exceeded);
    let iocp_root_exited = Arc::clone(&root_exited);
    let iocp_thread = std::thread::spawn(move || -> io::Result<()> {
        loop {
            let mut message = 0u32;
            let mut key = 0usize;
            let mut overlapped = null_mut();
            check(unsafe {
                GetQueuedCompletionStatus(
                    iocp_completion.as_raw_handle(),
                    &mut message,
                    &mut key,
                    &mut overlapped,
                    INFINITE,
                )
            })?;
            if key == 0
                && (message == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT
                    || message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT)
            {
                iocp_memory_exceeded.store(true, Ordering::SeqCst);
                unsafe { TerminateJobObject(iocp_job.as_raw_handle(), 1) };
            }
            if iocp_root_exited.load(Ordering::SeqCst)
                && (key == SHUTDOWN_COMPLETION_KEY || message == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO)
                && query_active_processes(iocp_job.as_raw_handle())? == 0
            {
                return Ok(());
            }
        }
    });

    let reader = control.try_clone()?;
    let control_job = Arc::clone(&job);
    std::thread::spawn(move || {
        let mut request = [0];
        // A termination byte, EOF, or a failed read all end ownership.
        // This also covers abrupt Electron death and worker termination.
        let _ = control_io(&reader, &mut request, false);
        unsafe { TerminateJobObject(control_job.as_raw_handle(), 1) };
    });
    if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    drop(thread);
    if unsafe { WaitForSingleObject(root.as_raw_handle(), INFINITE) } != WAIT_OBJECT_0 {
        return Err(io::Error::last_os_error());
    }
    let mut exit_code = 1;
    check(unsafe { GetExitCodeProcess(root.as_raw_handle(), &mut exit_code) })?;
    // No descendant may outlive its native invocation, including root crashes.
    check(unsafe { TerminateJobObject(job.as_raw_handle(), exit_code) })?;
    root_exited.store(true, Ordering::SeqCst);
    check(unsafe {
        PostQueuedCompletionStatus(
            completion.as_raw_handle(),
            0,
            SHUTDOWN_COMPLETION_KEY,
            null_mut(),
        )
    })?;
    iocp_thread
        .join()
        .map_err(|_| io::Error::other("Windows job completion watcher panicked"))??;

    if memory_limit_exceeded.load(Ordering::SeqCst) {
        let reported =
            query_peak_memory_bytes(job.as_raw_handle()).max(memory_limit_bytes.unwrap_or(0));
        let mut limit_message = format!("memory_limit={reported}\n").into_bytes();
        control_io(control, &mut limit_message, true)?;
    }

    // Only a fresh ActiveProcesses == 0 query permits the owner to reclaim
    // scratch and capacity. Root exit or closing a handle is not proof.
    let mut message = *b"empty\n";
    control_io(control, &mut message, true)?;
    Ok(exit_code)
}

pub fn run_job_mode(
    control_pipe: &OsStr,
    hide: bool,
    memory_limit_bytes: Option<u64>,
    command_args: &[OsString],
) -> io::Result<u32> {
    let mut control = OpenOptions::new()
        // Overlapped I/O lets the lifetime read stay pending while an exit
        // proof is written. Synchronous duplicate handles serialize duplex I/O.
        .custom_flags(FILE_FLAG_OVERLAPPED)
        .read(true)
        .write(true)
        .open(control_pipe)?;
    run_job(&mut control, command_args, hide, memory_limit_bytes)
}

fn open_process_query(pid: u32) -> Result<OwnedHandle, StartTimeResult> {
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        let code = unsafe { GetLastError() };
        return Err(if code == ERROR_INVALID_PARAMETER {
            StartTimeResult::Gone
        } else {
            StartTimeResult::Denied
        });
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn read_handle_start_time(process: HANDLE) -> Option<String> {
    let mut creation: FILETIME = unsafe { zeroed() };
    let mut exit: FILETIME = unsafe { zeroed() };
    let mut kernel: FILETIME = unsafe { zeroed() };
    let mut user: FILETIME = unsafe { zeroed() };
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return None;
    }
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    format_filetime_iso8601(ticks)
}

fn read_start_time(pid: u32) -> StartTimeResult {
    if pid == 0 {
        return StartTimeResult::Gone;
    }
    let process = match open_process_query(pid) {
        Ok(handle) => handle,
        Err(result) => return result,
    };
    match read_handle_start_time(process.as_raw_handle()) {
        Some(start_time) => StartTimeResult::Found(start_time),
        None => StartTimeResult::Denied,
    }
}

fn read_executable_path(process: HANDLE) -> Option<String> {
    let mut capacity = 1024usize;
    loop {
        let mut buffer = vec![0u16; capacity];
        let mut len = buffer.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len) };
        if ok != 0 {
            buffer.truncate(len as usize);
            return OsString::from_wide(&buffer).into_string().ok();
        }
        if unsafe { GetLastError() } == ERROR_INSUFFICIENT_BUFFER && capacity < 32_768 {
            capacity *= 2;
            continue;
        }
        return None;
    }
}

fn read_parent_pid(process: HANDLE) -> Option<u32> {
    let mut info: NtProcessBasicInformation = unsafe { zeroed() };
    let mut returned = 0u32;
    let status = unsafe {
        NtQueryInformationProcess(
            process,
            PROCESS_BASIC_INFORMATION_CLASS,
            (&mut info as *mut NtProcessBasicInformation).cast(),
            size_of::<NtProcessBasicInformation>() as u32,
            &mut returned,
        )
    };
    if status < 0 {
        return None;
    }
    u32::try_from(info.inherited_from_unique_process_id).ok()
}

fn read_command_line(process: HANDLE) -> Option<String> {
    let mut byte_len = 512u32;
    for _ in 0..4 {
        let word_count = (byte_len as usize).div_ceil(size_of::<usize>()).max(64);
        let mut backing = vec![0usize; word_count];
        let backing_bytes = backing.len() * size_of::<usize>();
        let mut required = 0u32;
        let status = unsafe {
            NtQueryInformationProcess(
                process,
                PROCESS_COMMAND_LINE_INFORMATION_CLASS,
                backing.as_mut_ptr().cast(),
                backing_bytes as u32,
                &mut required,
            )
        };
        if status >= 0 {
            let unicode = unsafe { &*(backing.as_ptr() as *const NtUnicodeString) };
            if unicode.length == 0 || unicode.buffer.is_null() {
                return Some(String::new());
            }
            let length_bytes = unicode.length as usize;
            if length_bytes % 2 != 0 {
                return None;
            }
            let base = backing.as_ptr() as usize;
            let end = base.checked_add(backing_bytes)?;
            let buf_addr = unicode.buffer as usize;
            let buf_end = buf_addr.checked_add(length_bytes)?;
            if buf_addr < base || buf_end > end || buf_addr % std::mem::align_of::<u16>() != 0 {
                return None;
            }
            let units = length_bytes / 2;
            let slice = unsafe { std::slice::from_raw_parts(unicode.buffer, units) };
            return Some(String::from_utf16_lossy(slice));
        }
        if (status == STATUS_INFO_LENGTH_MISMATCH
            || status == STATUS_BUFFER_TOO_SMALL
            || status == STATUS_BUFFER_OVERFLOW)
            && required > backing_bytes as u32
            && required <= 2 * 1024 * 1024
        {
            byte_len = required;
            continue;
        }
        return None;
    }
    None
}

pub fn read_process_identity(pid: u32) -> Option<ProcessIdentity> {
    if pid == 0 {
        return None;
    }
    let process = open_process_query(pid).ok()?;
    let start_time = read_handle_start_time(process.as_raw_handle())?;
    let executable_path = read_executable_path(process.as_raw_handle())?;
    let parent_pid = read_parent_pid(process.as_raw_handle());
    let command_line = read_command_line(process.as_raw_handle()).unwrap_or_default();
    let arguments = parse_windows_command_line(&command_line);
    Some(ProcessIdentity {
        executable_path,
        arguments,
        start_time,
        parent_pid,
        environment: None,
    })
}

pub fn run_start_time_host() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if let Some(pid_text) = trimmed.strip_prefix("identity ") {
            if let Ok(pid) = pid_text.trim().parse::<u32>() {
                if pid > 0 {
                    if let Some(identity) = read_process_identity(pid) {
                        writeln!(out, "{}", format_process_identity_json(&identity))?;
                        out.flush()?;
                        continue;
                    }
                }
            }
            writeln!(out)?;
            out.flush()?;
            continue;
        }
        if let Ok(pid) = trimmed.parse::<u32>() {
            if pid > 0 {
                match read_start_time(pid) {
                    StartTimeResult::Found(value) => writeln!(out, "{value}")?,
                    StartTimeResult::Gone => writeln!(out)?,
                    StartTimeResult::Denied => writeln!(out, "denied")?,
                }
            } else {
                writeln!(out)?;
            }
        } else {
            writeln!(out)?;
        }
        out.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn assignment_failure_refuses_execution_and_reaps_the_suspended_process() {
        let executable = std::env::current_exe().unwrap().into_os_string();
        let error = super::launch_suspended(std::ptr::null_mut(), &[executable], true).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(6));
    }

    #[test]
    fn reads_current_process_start_time_and_identity() {
        let pid = std::process::id();
        let start = super::read_start_time(pid);
        assert!(matches!(start, crate::StartTimeResult::Found(_)));
        let identity = super::read_process_identity(pid).expect("current process identity");
        assert!(!identity.executable_path.is_empty());
        assert!(!identity.start_time.is_empty());
    }
}
