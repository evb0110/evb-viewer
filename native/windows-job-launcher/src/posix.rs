use std::ffi::OsString;
use std::io::{self, BufRead, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::{
    format_process_identity_json, parse_terminate_grace_ms, ProcessIdentity, StartTimeResult,
};

const MEMORY_POLL_INTERVAL_MS: u64 = 100;
const REAP_WAIT_LIMIT: Duration = Duration::from_secs(5);
const REAP_POLL_STEP: Duration = Duration::from_millis(20);

fn format_spawn_error(error: &io::Error) -> String {
    let code = match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EACCES) => "EACCES",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::ENOEXEC) => "ENOEXEC",
        _ => "ESPAWN",
    };
    let detail = error.to_string().replace(['\r', '\n'], " ");
    format!("{code}: {detail}").chars().take(384).collect()
}

fn report_spawn_error_and_empty(control_fd: i32, error: &io::Error) {
    let line = format!("spawn_error={}\nempty\n", format_spawn_error(error));
    let _ = write_all_fd(control_fd, line.as_bytes());
    unsafe {
        libc::shutdown(control_fd, libc::SHUT_WR);
        libc::close(control_fd);
    }
}

fn write_all_fd(fd: i32, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if written == 0 {
            return Err(io::Error::from(io::ErrorKind::WriteZero));
        }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

fn read_control_command(fd: i32) -> Option<u64> {
    let mut buf = [0u8; 64];
    loop {
        let count = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return None;
        }
        if count == 0 {
            return None;
        }
        let text = String::from_utf8_lossy(&buf[..count as usize]);
        return Some(parse_terminate_grace_ms(&text));
    }
}

fn set_cloexec(fd: i32) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn is_pgrp_alive(pgid: libc::pid_t) -> bool {
    let result = unsafe { libc::kill(-pgid, 0) };
    if result == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn signal_group(pgid: libc::pid_t, signal: libc::c_int, child_reaped: bool) {
    let result = unsafe { libc::kill(-pgid, signal) };
    if !child_reaped
        && result != 0
        && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    {
        unsafe {
            libc::kill(pgid, signal);
        }
    }
}

fn try_wait_pid(pid: libc::pid_t) -> Option<libc::c_int> {
    let mut status: libc::c_int = 0;
    loop {
        let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if result == pid {
            return Some(status);
        }
        if result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return None;
    }
}

fn reap_any_descendants(child_pid: libc::pid_t, reaped_status: &mut Option<libc::c_int>) {
    loop {
        let mut status: libc::c_int = 0;
        let waited = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if waited > 0 {
            if waited == child_pid && reaped_status.is_none() {
                *reaped_status = Some(status);
            }
            continue;
        }
        if waited < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        break;
    }
}

fn terminate_group(child_pid: libc::pid_t, grace_ms: u64, reaped_status: &mut Option<libc::c_int>) {
    if grace_ms > 0 {
        signal_group(child_pid, libc::SIGTERM, reaped_status.is_some());
        let deadline = Instant::now() + Duration::from_millis(grace_ms);
        while Instant::now() < deadline {
            if reaped_status.is_none() {
                *reaped_status = try_wait_pid(child_pid);
            }
            reap_any_descendants(child_pid, reaped_status);
            if reaped_status.is_some() && !is_pgrp_alive(child_pid) {
                return;
            }
            std::thread::sleep(REAP_POLL_STEP);
        }
    }

    signal_group(child_pid, libc::SIGKILL, reaped_status.is_some());
}

fn ensure_group_empty(child_pid: libc::pid_t, reaped_status: &mut Option<libc::c_int>) -> bool {
    if is_pgrp_alive(child_pid) {
        signal_group(child_pid, libc::SIGKILL, reaped_status.is_some());
    }
    let deadline = Instant::now() + REAP_WAIT_LIMIT;
    while Instant::now() < deadline {
        if reaped_status.is_none() {
            *reaped_status = try_wait_pid(child_pid);
        }
        reap_any_descendants(child_pid, reaped_status);
        if reaped_status.is_some() && !is_pgrp_alive(child_pid) {
            return true;
        }
        if is_pgrp_alive(child_pid) {
            signal_group(child_pid, libc::SIGKILL, reaped_status.is_some());
        }
        std::thread::sleep(REAP_POLL_STEP);
    }
    if reaped_status.is_none() {
        *reaped_status = try_wait_pid(child_pid);
    }
    reap_any_descendants(child_pid, reaped_status);
    reaped_status.is_some() && !is_pgrp_alive(child_pid)
}

fn exit_with_wait_status(status: libc::c_int) -> ! {
    if libc::WIFEXITED(status) {
        std::process::exit(libc::WEXITSTATUS(status));
    }
    if libc::WIFSIGNALED(status) {
        let signal = libc::WTERMSIG(status);
        unsafe {
            // Never write a core dump when forwarding a child's fatal signal.
            let zero_core = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            libc::setrlimit(libc::RLIMIT_CORE, &zero_core);
            libc::signal(signal, libc::SIG_DFL);
            let mut empty: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut empty);
            libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
            libc::raise(signal);
        }
        std::process::exit(128 + signal);
    }
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};

    const PROC_PGRP_ONLY: u32 = 2;
    const RUSAGE_INFO_V4: libc::c_int = 4;
    const RUSAGE_INFO_V4_SIZE: usize = 296;
    const RUSAGE_INFO_V4_WORDS: usize = RUSAGE_INFO_V4_SIZE / 8;
    const RI_PHYS_FOOTPRINT_WORD_INDEX: usize = 72 / 8;
    const KINFO_PROC_SIZE: usize = 648;
    const KINFO_PROC_WORDS: usize = KINFO_PROC_SIZE / 8;
    const KINFO_PROC_PPID_OFFSET: usize = 560;
    const PROC_PIDPATHINFO_MAXSIZE: u32 = 4096;

    extern "C" {
        fn proc_pid_rusage(
            pid: libc::c_int,
            flavor: libc::c_int,
            buffer: *mut libc::c_void,
        ) -> libc::c_int;
        fn proc_listpids(
            r#type: u32,
            typeinfo: u32,
            buffer: *mut libc::c_void,
            buffersize: libc::c_int,
        ) -> libc::c_int;
        fn proc_pidpath(
            pid: libc::c_int,
            buffer: *mut libc::c_void,
            buffersize: u32,
        ) -> libc::c_int;
    }

    fn read_pid_phys_footprint(pid: libc::pid_t) -> u64 {
        let mut raw = [0u64; RUSAGE_INFO_V4_WORDS];
        let rc = unsafe { proc_pid_rusage(pid, RUSAGE_INFO_V4, raw.as_mut_ptr().cast()) };
        if rc != 0 {
            return 0;
        }
        raw[RI_PHYS_FOOTPRINT_WORD_INDEX]
    }

    pub(super) fn read_pgrp_memory_bytes(pgid: libc::pid_t) -> u64 {
        let estimated = unsafe { proc_listpids(PROC_PGRP_ONLY, pgid as u32, null_mut(), 0) };
        let mut pids = Vec::new();
        if estimated > 0 {
            let count = (estimated as usize / size_of::<libc::pid_t>()) + 16;
            let mut buffer = vec![0 as libc::pid_t; count];
            let filled = unsafe {
                proc_listpids(
                    PROC_PGRP_ONLY,
                    pgid as u32,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * size_of::<libc::pid_t>()) as libc::c_int,
                )
            };
            if filled > 0 {
                let entries = (filled as usize / size_of::<libc::pid_t>()).min(buffer.len());
                for &pid in &buffer[..entries] {
                    if pid > 0 && !pids.contains(&pid) {
                        pids.push(pid);
                    }
                }
            }
        }
        if !pids.contains(&pgid) {
            pids.push(pgid);
        }
        pids.into_iter().fold(0u64, |total, pid| {
            total.saturating_add(read_pid_phys_footprint(pid))
        })
    }

    pub(super) fn run_job(
        control_fd: i32,
        memory_limit_bytes: Option<u64>,
        command_args: &[OsString],
    ) -> io::Result<i32> {
        let parent_pid = unsafe { libc::getppid() };
        if parent_pid <= 1 {
            return Ok(1);
        }
        let mut cmd = Command::new(&command_args[0]);
        cmd.args(&command_args[1..])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        unsafe {
            cmd.pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            });
        }
        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                report_spawn_error_and_empty(control_fd, &error);
                return Ok(1);
            }
        };
        let child_pid = child.id() as libc::pid_t;
        if let Err(error) = write_all_fd(control_fd, format!("pid={child_pid}\n").as_bytes()) {
            let mut status = None;
            terminate_group(child_pid, 0, &mut status);
            let _ = ensure_group_empty(child_pid, &mut status);
            return Err(error);
        }

        let kq = unsafe { libc::kqueue() };
        if kq < 0 {
            let err = io::Error::last_os_error();
            let mut status = None;
            terminate_group(child_pid, 0, &mut status);
            let _ = ensure_group_empty(child_pid, &mut status);
            return Err(err);
        }
        let _ = set_cloexec(kq);

        let changes = [
            libc::kevent {
                ident: parent_pid as usize,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_ADD | libc::EV_ONESHOT,
                fflags: libc::NOTE_EXIT,
                data: 0,
                udata: null_mut(),
            },
            libc::kevent {
                ident: child_pid as usize,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_ADD | libc::EV_ONESHOT,
                fflags: libc::NOTE_EXIT,
                data: 0,
                udata: null_mut(),
            },
            libc::kevent {
                ident: control_fd as usize,
                filter: libc::EVFILT_READ,
                flags: libc::EV_ADD,
                fflags: 0,
                data: 0,
                udata: null_mut(),
            },
        ];

        let mut reaped_status: Option<libc::c_int> = None;
        let mut parent_gone = false;
        let mut child_done = false;

        for change in &changes {
            loop {
                let rc = unsafe { libc::kevent(kq, change, 1, null_mut(), 0, null()) };
                if rc >= 0 {
                    break;
                }
                let error = io::Error::last_os_error();
                let errno = error.raw_os_error();
                if errno == Some(libc::EINTR) {
                    continue;
                }
                if errno == Some(libc::ESRCH) && change.filter == libc::EVFILT_PROC {
                    if change.ident == parent_pid as usize {
                        parent_gone = true;
                        break;
                    }
                    if change.ident == child_pid as usize {
                        child_done = true;
                        break;
                    }
                }
                unsafe {
                    libc::close(kq);
                }
                terminate_group(child_pid, 0, &mut reaped_status);
                let _ = ensure_group_empty(child_pid, &mut reaped_status);
                return Err(error);
            }
        }
        let current_ppid = unsafe { libc::getppid() };
        if current_ppid <= 1 || current_ppid != parent_pid {
            parent_gone = true;
        }

        let mut memory_limit_exceeded: Option<u64> = None;
        let mut terminated_by_control = false;
        if parent_gone {
            terminate_group(child_pid, 0, &mut reaped_status);
        } else if !child_done {
            let timeout = libc::timespec {
                tv_sec: 0,
                tv_nsec: (MEMORY_POLL_INTERVAL_MS * 1_000_000) as libc::c_long,
            };
            let timeout_ptr = if memory_limit_bytes.is_some() {
                &timeout as *const libc::timespec
            } else {
                null()
            };
            let mut events: [libc::kevent; 4] = unsafe { zeroed() };
            loop {
                let count = unsafe {
                    libc::kevent(
                        kq,
                        null(),
                        0,
                        events.as_mut_ptr(),
                        events.len() as i32,
                        timeout_ptr,
                    )
                };
                if count < 0 {
                    if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    break;
                }
                let mut should_break = false;
                for event in &events[..count as usize] {
                    if event.filter == libc::EVFILT_PROC && event.ident == parent_pid as usize {
                        parent_gone = true;
                        terminate_group(child_pid, 0, &mut reaped_status);
                        should_break = true;
                        break;
                    }
                    if event.filter == libc::EVFILT_READ && event.ident == control_fd as usize {
                        terminated_by_control = true;
                        let grace_ms = read_control_command(control_fd).unwrap_or(0);
                        terminate_group(child_pid, grace_ms, &mut reaped_status);
                        should_break = true;
                        break;
                    }
                    if event.filter == libc::EVFILT_PROC && event.ident == child_pid as usize {
                        should_break = true;
                    }
                }
                if should_break {
                    break;
                }
                if let Some(limit) = memory_limit_bytes {
                    let footprint = read_pgrp_memory_bytes(child_pid);
                    if footprint > limit {
                        memory_limit_exceeded = Some(footprint);
                        terminate_group(child_pid, 0, &mut reaped_status);
                        break;
                    }
                }
            }
        }
        unsafe {
            libc::close(kq);
        }

        if reaped_status.is_none() {
            let mut status: libc::c_int = 0;
            loop {
                let waited = unsafe { libc::waitpid(child_pid, &mut status, 0) };
                if waited == child_pid {
                    reaped_status = Some(status);
                    break;
                }
                if waited < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                break;
            }
        }

        let proven_empty = ensure_group_empty(child_pid, &mut reaped_status);
        if proven_empty {
            if let Some(bytes) = memory_limit_exceeded {
                let _ = write_all_fd(control_fd, format!("memory_limit={bytes}\n").as_bytes());
            }
            let _ = write_all_fd(control_fd, b"empty\n");
        }
        unsafe {
            libc::shutdown(control_fd, libc::SHUT_WR);
            libc::close(control_fd);
        }

        if memory_limit_exceeded.is_some() || terminated_by_control || parent_gone {
            return Ok(1);
        }
        if let Some(status) = reaped_status {
            exit_with_wait_status(status);
        }
        Ok(1)
    }

    fn read_kinfo_proc(pid: u32) -> Option<[u64; KINFO_PROC_WORDS]> {
        if pid == 0 {
            return None;
        }
        let mut mib = [
            libc::CTL_KERN,
            libc::KERN_PROC,
            libc::KERN_PROC_PID,
            pid as libc::c_int,
        ];
        let mut buf = [0u64; KINFO_PROC_WORDS];
        let mut size = KINFO_PROC_SIZE;
        let rc = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as u32,
                buf.as_mut_ptr().cast(),
                &mut size,
                null_mut(),
                0,
            )
        };
        if rc != 0 || size != KINFO_PROC_SIZE {
            return None;
        }
        Some(buf)
    }

    fn kinfo_bytes(buf: &[u64; KINFO_PROC_WORDS]) -> &[u8] {
        unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), KINFO_PROC_SIZE) }
    }

    fn start_time_from_kinfo(buf: &[u64; KINFO_PROC_WORDS]) -> String {
        let bytes = kinfo_bytes(buf);
        let sec = i64::from_ne_bytes(bytes[0..8].try_into().unwrap_or([0; 8]));
        let usec = i32::from_ne_bytes(bytes[8..12].try_into().unwrap_or([0; 4]));
        format!("{sec}.{usec:06}")
    }

    pub(super) fn read_start_time(pid: u32) -> StartTimeResult {
        match read_kinfo_proc(pid) {
            Some(buf) => StartTimeResult::Found(start_time_from_kinfo(&buf)),
            None => StartTimeResult::Gone,
        }
    }

    pub(super) fn read_process_identity(pid: u32) -> Option<ProcessIdentity> {
        let kinfo = read_kinfo_proc(pid)?;
        let start_time = start_time_from_kinfo(&kinfo);
        let bytes = kinfo_bytes(&kinfo);
        let ppid = i32::from_ne_bytes(
            bytes[KINFO_PROC_PPID_OFFSET..KINFO_PROC_PPID_OFFSET + 4]
                .try_into()
                .unwrap_or([0; 4]),
        );
        let parent_pid = u32::try_from(ppid).ok();

        let mut path_buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE as usize];
        let path_len = unsafe {
            proc_pidpath(
                pid as libc::c_int,
                path_buf.as_mut_ptr().cast(),
                PROC_PIDPATHINFO_MAXSIZE,
            )
        };
        if path_len <= 0 {
            return None;
        }
        path_buf.truncate(path_len as usize);
        let executable_path = String::from_utf8(path_buf).ok()?;

        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        let mut size: libc::size_t = 0;
        if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, null_mut(), &mut size, null_mut(), 0) } != 0
            || size < 4
        {
            return None;
        }
        let mut procargs = vec![0u8; size];
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                procargs.as_mut_ptr().cast(),
                &mut size,
                null_mut(),
                0,
            )
        } != 0
            || size < 4
        {
            return None;
        }
        procargs.truncate(size);
        let argc = i32::from_ne_bytes(procargs[0..4].try_into().ok()?);
        if argc <= 0 {
            return None;
        }
        let argc = argc as usize;

        // Skip exec_path and its trailing NUL alignment padding.
        let exec_end = procargs[4..].iter().position(|&b| b == 0)?;
        let mut offset = 4 + exec_end + 1;
        while offset < procargs.len() && procargs[offset] == 0 {
            offset += 1;
        }
        let fields: Vec<String> = procargs[offset..]
            .split(|&b| b == 0)
            .map(|slice| String::from_utf8_lossy(slice).into_owned())
            .collect();
        if fields.len() < argc {
            return None;
        }
        let arguments = fields[..argc].to_vec();
        let environment = fields
            .get(argc..)
            .unwrap_or(&[])
            .iter()
            .filter(|entry| !entry.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\0");

        Some(ProcessIdentity {
            executable_path,
            arguments,
            start_time,
            parent_pid,
            environment: Some(environment),
        })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::fs;
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;

    fn read_status_memory_bytes(pid: libc::pid_t) -> u64 {
        let Ok(status) = fs::read_to_string(format!("/proc/{pid}/status")) else {
            return 0;
        };
        let mut rss_anon_kb = 0u64;
        let mut vm_rss_kb = 0u64;
        let mut vm_swap_kb = 0u64;
        let mut saw_rss_anon = false;
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("RssAnon:") {
                if let Some(val) = rest
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse::<u64>().ok())
                {
                    rss_anon_kb = val;
                    saw_rss_anon = true;
                }
            } else if let Some(rest) = line.strip_prefix("VmRSS:") {
                if let Some(val) = rest
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse::<u64>().ok())
                {
                    vm_rss_kb = val;
                }
            } else if let Some(rest) = line.strip_prefix("VmSwap:") {
                if let Some(val) = rest
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse::<u64>().ok())
                {
                    vm_swap_kb = val;
                }
            }
        }
        let base_kb = if saw_rss_anon { rss_anon_kb } else { vm_rss_kb };
        base_kb.saturating_add(vm_swap_kb).saturating_mul(1024)
    }

    fn read_stat_pgid(pid: libc::pid_t) -> Option<libc::pid_t> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let close_paren = stat.rfind(')')?;
        let mut fields = stat.get(close_paren + 2..)?.split_whitespace();
        // Field 3 is state (index 0), field 4 is ppid (index 1), field 5 is pgrp (index 2).
        fields.nth(2)?.parse::<libc::pid_t>().ok()
    }

    pub(super) fn read_pgrp_memory_bytes(pgid: libc::pid_t) -> u64 {
        let mut total = 0u64;
        let mut saw_leader = false;
        if let Ok(entries) = fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let Ok(name) = entry.file_name().into_string() else {
                    continue;
                };
                let Ok(pid) = name.parse::<libc::pid_t>() else {
                    continue;
                };
                if pid == pgid || read_stat_pgid(pid) == Some(pgid) {
                    if pid == pgid {
                        saw_leader = true;
                    }
                    total = total.saturating_add(read_status_memory_bytes(pid));
                }
            }
        }
        if !saw_leader {
            total = total.saturating_add(read_status_memory_bytes(pgid));
        }
        total
    }

    pub(super) fn run_job(
        control_fd: i32,
        memory_limit_bytes: Option<u64>,
        command_args: &[OsString],
    ) -> io::Result<i32> {
        let parent_pid = unsafe { libc::getppid() };
        let supervisor_pid = unsafe { libc::getpid() };

        unsafe {
            // Keep orphaned grandchildren attached so waitpid(-1) can reap them.
            libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
        }

        // Block SIGCHLD and SIGTERM and handle them via signalfd so poll() can
        // wait on control_fd and kernel signals simultaneously with 0% CPU.
        let mut mask: libc::sigset_t = unsafe { zeroed() };
        unsafe {
            libc::sigemptyset(&mut mask);
            libc::sigaddset(&mut mask, libc::SIGCHLD);
            libc::sigaddset(&mut mask, libc::SIGTERM);
            if libc::sigprocmask(libc::SIG_BLOCK, &mask, null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        let sfd = unsafe { libc::signalfd(-1, &mask, libc::SFD_NONBLOCK | libc::SFD_CLOEXEC) };
        if sfd < 0 {
            return Err(io::Error::last_os_error());
        }

        unsafe {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0);
        }
        if unsafe { libc::getppid() } != parent_pid {
            unsafe {
                libc::close(sfd);
            }
            return Ok(1);
        }

        let mut cmd = Command::new(&command_args[0]);
        cmd.args(&command_args[1..])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        unsafe {
            cmd.pre_exec(move || {
                libc::setpgid(0, 0);
                // Restore an unblocked signal mask for the target tool.
                let mut empty: libc::sigset_t = zeroed();
                libc::sigemptyset(&mut empty);
                libc::sigprocmask(libc::SIG_SETMASK, &empty, null_mut());
                // Kernel-bound lifetime: if the supervisor itself is SIGKILLed,
                // the kernel immediately terminates the child too.
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0);
                if libc::getppid() != supervisor_pid {
                    libc::_exit(127);
                }
                if let Some(limit) = memory_limit_bytes {
                    let mut rl: libc::rlimit = zeroed();
                    if libc::getrlimit(libc::RLIMIT_DATA, &mut rl) == 0 {
                        // Keep a kernel RLIMIT_DATA backstop comfortably above
                        // the soft /proc group cap (at least 2x or +512 MiB for
                        // runtimes with large virtual reservations) so normal
                        // growth crosses `limit` and emits `memory_limit=<bytes>`
                        // deterministically while runaway spikes stay bounded.
                        const MIN_RLIMIT_DATA_HEADROOM_BYTES: u64 = 512 * 1024 * 1024;
                        let backstop = limit
                            .saturating_mul(2)
                            .max(limit.saturating_add(MIN_RLIMIT_DATA_HEADROOM_BYTES))
                            .min(rl.rlim_max);
                        rl.rlim_cur = backstop;
                        libc::setrlimit(libc::RLIMIT_DATA, &rl);
                    }
                }
                Ok(())
            });
        }
        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                unsafe {
                    libc::close(sfd);
                }
                report_spawn_error_and_empty(control_fd, &error);
                return Ok(1);
            }
        };
        let child_pid = child.id() as libc::pid_t;
        if let Err(error) = write_all_fd(control_fd, format!("pid={child_pid}\n").as_bytes()) {
            unsafe {
                libc::close(sfd);
            }
            let mut status = None;
            terminate_group(child_pid, 0, &mut status);
            let _ = ensure_group_empty(child_pid, &mut status);
            return Err(error);
        }

        let mut reaped_status: Option<libc::c_int> = None;
        let mut memory_limit_exceeded: Option<u64> = None;
        let mut terminated_by_control = false;
        let mut parent_gone = false;

        let poll_timeout_ms = if memory_limit_bytes.is_some() {
            MEMORY_POLL_INTERVAL_MS as i32
        } else {
            -1
        };
        let mut fds = [
            libc::pollfd {
                fd: control_fd,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: sfd,
                events: libc::POLLIN,
                revents: 0,
            },
        ];

        loop {
            if reaped_status.is_none() {
                reaped_status = try_wait_pid(child_pid);
                if reaped_status.is_some() {
                    break;
                }
            }
            fds[0].revents = 0;
            fds[1].revents = 0;
            let rc =
                unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, poll_timeout_ms) };
            if rc < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if (fds[1].revents & libc::POLLIN) != 0 {
                let mut should_break = false;
                loop {
                    let mut info: libc::signalfd_siginfo = unsafe { zeroed() };
                    let n = unsafe {
                        libc::read(
                            sfd,
                            (&mut info as *mut libc::signalfd_siginfo).cast(),
                            size_of::<libc::signalfd_siginfo>(),
                        )
                    };
                    if n != size_of::<libc::signalfd_siginfo>() as isize {
                        break;
                    }
                    if info.ssi_signo == libc::SIGTERM as u32 {
                        parent_gone = true;
                        terminate_group(child_pid, 0, &mut reaped_status);
                        should_break = true;
                        break;
                    }
                    if info.ssi_signo == libc::SIGCHLD as u32 {
                        reaped_status = reaped_status.or_else(|| try_wait_pid(child_pid));
                        reap_any_descendants(child_pid, &mut reaped_status);
                        if reaped_status.is_some() {
                            should_break = true;
                        }
                    }
                }
                if should_break {
                    break;
                }
            }
            if (fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR)) != 0 {
                terminated_by_control = true;
                let grace_ms = read_control_command(control_fd).unwrap_or(0);
                terminate_group(child_pid, grace_ms, &mut reaped_status);
                break;
            }
            if let Some(limit) = memory_limit_bytes {
                let usage = read_pgrp_memory_bytes(child_pid);
                if usage > limit {
                    memory_limit_exceeded = Some(usage);
                    terminate_group(child_pid, 0, &mut reaped_status);
                    break;
                }
            }
        }
        unsafe {
            libc::close(sfd);
        }

        if reaped_status.is_none() {
            let mut status: libc::c_int = 0;
            loop {
                let waited = unsafe { libc::waitpid(child_pid, &mut status, 0) };
                if waited == child_pid {
                    reaped_status = Some(status);
                    break;
                }
                if waited < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                break;
            }
        }

        let proven_empty = ensure_group_empty(child_pid, &mut reaped_status);
        if proven_empty {
            if let Some(bytes) = memory_limit_exceeded {
                let _ = write_all_fd(control_fd, format!("memory_limit={bytes}\n").as_bytes());
            }
            let _ = write_all_fd(control_fd, b"empty\n");
        }
        unsafe {
            libc::shutdown(control_fd, libc::SHUT_WR);
            libc::close(control_fd);
        }

        if memory_limit_exceeded.is_some() || terminated_by_control || parent_gone {
            return Ok(1);
        }
        if let Some(status) = reaped_status {
            exit_with_wait_status(status);
        }
        Ok(1)
    }

    fn read_linux_start_time(pid: u32) -> Result<String, io::ErrorKind> {
        if pid == 0 {
            return Err(io::ErrorKind::NotFound);
        }
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|e| e.kind())?;
        let boot_id =
            fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|e| e.kind())?;
        let close_paren = stat.rfind(')').ok_or(io::ErrorKind::InvalidData)?;
        let ticks = stat
            .get(close_paren + 2..)
            .ok_or(io::ErrorKind::InvalidData)?
            .split_whitespace()
            .nth(19)
            .ok_or(io::ErrorKind::InvalidData)?;
        Ok(format!("{}:{ticks}", boot_id.trim()))
    }

    pub(super) fn read_start_time(pid: u32) -> StartTimeResult {
        match read_linux_start_time(pid) {
            Ok(value) => StartTimeResult::Found(value),
            Err(io::ErrorKind::NotFound) => StartTimeResult::Gone,
            Err(_) => StartTimeResult::Denied,
        }
    }

    pub(super) fn read_process_identity(pid: u32) -> Option<ProcessIdentity> {
        let start_time = read_linux_start_time(pid).ok()?;
        let executable_path = fs::read_link(format!("/proc/{pid}/exe"))
            .ok()?
            .to_string_lossy()
            .into_owned();
        let cmdline = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        let arguments: Vec<String> = cmdline
            .split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect();
        if arguments.is_empty() {
            return None;
        }
        Some(ProcessIdentity {
            executable_path,
            arguments,
            start_time,
            parent_pid: None,
            environment: None,
        })
    }
}

pub fn run_job_mode(
    control_fd: i32,
    memory_limit_bytes: Option<u64>,
    command_args: &[OsString],
) -> io::Result<i32> {
    set_cloexec(control_fd)?;
    platform::run_job(control_fd, memory_limit_bytes, command_args)
}

pub fn read_process_identity(pid: u32) -> Option<ProcessIdentity> {
    platform::read_process_identity(pid)
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
                    if let Some(identity) = platform::read_process_identity(pid) {
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
                match platform::read_start_time(pid) {
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
    use super::*;

    #[test]
    fn reads_current_process_start_time_and_identity() {
        let pid = std::process::id();
        let start = platform::read_start_time(pid);
        assert!(matches!(start, StartTimeResult::Found(_)));
        let identity = read_process_identity(pid).expect("current process identity");
        assert!(!identity.executable_path.is_empty());
        assert!(!identity.arguments.is_empty());
        assert!(!identity.start_time.is_empty());
    }

    #[test]
    fn reads_nonzero_memory_footprint_for_current_process() {
        let pgid = unsafe { libc::getpgrp() };
        let bytes = platform::read_pgrp_memory_bytes(pgid);
        assert!(bytes > 0, "expected positive memory usage, got {bytes}");
    }

    #[test]
    fn rejects_pid_zero_queries() {
        assert_eq!(platform::read_start_time(0), StartTimeResult::Gone);
        assert!(read_process_identity(0).is_none());
    }
}
