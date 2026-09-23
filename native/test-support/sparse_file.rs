//! Sparse test fixtures for native integration tests. Test targets include
//! this file with `#[path]`.

/// Create a file whose unwritten ranges stay unallocated, so a test can model
/// a multi-gigabyte PDF without writing gigabytes. Unix filesystems leave a
/// seeked-over range sparse on their own; NTFS zero-fills it unless the file is
/// first marked sparse.
pub fn create_sparse_file(path: &std::path::Path) -> std::fs::File {
    let file = std::fs::File::create(path).unwrap();
    #[cfg(windows)]
    {
        use std::{ffi::c_void, os::windows::io::AsRawHandle, ptr};

        const FSCTL_SET_SPARSE: u32 = 0x0009_00c4;
        #[link(name = "kernel32")]
        extern "system" {
            fn DeviceIoControl(
                device: *mut c_void,
                control_code: u32,
                input: *mut c_void,
                input_size: u32,
                output: *mut c_void,
                output_size: u32,
                bytes_returned: *mut u32,
                overlapped: *mut c_void,
            ) -> i32;
        }
        let mut returned = 0;
        let marked = unsafe {
            DeviceIoControl(
                file.as_raw_handle().cast(),
                FSCTL_SET_SPARSE,
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                0,
                &mut returned,
                ptr::null_mut(),
            )
        };
        assert_ne!(
            marked,
            0,
            "unable to mark {} sparse: {}",
            path.display(),
            std::io::Error::last_os_error()
        );
    }
    file
}
