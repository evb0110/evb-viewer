#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(any(windows, test))]
fn quote_argument(argument: &[u16], output: &mut Vec<u16>) {
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

#[cfg(windows)]
mod windows {
    use std::ffi::OsString;
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::{null, null_mut};
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_IO_PENDING, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
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
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateProcessW, GetExitCodeProcess, GetProcessId, ResumeThread,
        TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, INFINITE,
        PROCESS_INFORMATION, STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES, STARTUPINFOW,
    };
    use windows_sys::Win32::System::IO::{
        CreateIoCompletionPort, GetOverlappedResult, GetQueuedCompletionStatus, OVERLAPPED,
    };

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

    fn wait_empty(job: HANDLE, completion: HANDLE) -> io::Result<()> {
        loop {
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
            if accounting.ActiveProcesses == 0 {
                return Ok(());
            }
            let mut message = 0;
            let mut key = 0;
            let mut overlapped = null_mut();
            check(unsafe {
                GetQueuedCompletionStatus(
                    completion,
                    &mut message,
                    &mut key,
                    &mut overlapped,
                    INFINITE,
                )
            })?;
        }
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
            super::quote_argument(&wide, &mut command_line);
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

    fn run_job(control: &mut File, arguments: &[OsString], hide: bool) -> io::Result<u32> {
        let job = Arc::new(handle(unsafe { CreateJobObjectW(null(), null()) })?);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        check(unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        })?;
        let completion =
            handle(unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) })?;
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
        let (root, thread) = launch_suspended(job.as_raw_handle(), arguments, hide)?;
        control_io(
            control,
            &mut format!("pid={}\n", unsafe { GetProcessId(root.as_raw_handle()) }).into_bytes(),
            true,
        )?;
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
        wait_empty(job.as_raw_handle(), completion.as_raw_handle())?;
        // Only a fresh ActiveProcesses == 0 query permits the owner to reclaim
        // scratch and capacity. Root exit or closing a handle is not proof.
        let mut message = *b"empty\n";
        control_io(control, &mut message, true)?;
        Ok(exit_code)
    }

    pub fn run() -> io::Result<u32> {
        let arguments: Vec<_> = std::env::args_os().skip(1).collect();
        if arguments.len() < 4 || arguments[2] != "--" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected CONTROL HIDE -- COMMAND [ARGS]",
            ));
        }
        let mut control = OpenOptions::new()
            // Overlapped I/O lets the lifetime read stay pending while an exit
            // proof is written. Synchronous duplicate handles serialize duplex I/O.
            .custom_flags(FILE_FLAG_OVERLAPPED)
            .read(true)
            .write(true)
            .open(&arguments[0])?;
        run_job(&mut control, &arguments[3..], arguments[1] == "1")
    }
    #[cfg(test)]
    mod tests {
        #[test]
        fn assignment_failure_refuses_execution_and_reaps_the_suspended_process() {
            let executable = std::env::current_exe().unwrap().into_os_string();
            let error =
                super::launch_suspended(std::ptr::null_mut(), &[executable], true).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(6));
        }
    }
}

fn main() {
    #[cfg(windows)]
    match windows::run() {
        Ok(code) => std::process::exit(code as i32),
        Err(error) => {
            eprintln!("Windows job launch failed: {error}");
            std::process::exit(1);
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("Windows Job Objects require Windows");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
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
            super::quote_argument(&input.encode_utf16().collect::<Vec<_>>(), &mut actual);
            assert_eq!(String::from_utf16(&actual).unwrap(), expected);
        }
    }
}
