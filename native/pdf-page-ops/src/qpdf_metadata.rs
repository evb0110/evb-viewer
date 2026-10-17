//! Read-only object projections through the bundled qpdf library. Unlike its
//! JSON exporter, the C object interface resolves only objects a consumer needs.

use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum QpdfMetadataPurpose {
    Geometry,
    Annotations,
    Catalog,
    Conformance,
    AnnotationIndex,
}

/// None means only that the supplied qpdf executable has no adjacent library.
/// A present but unusable library, or an unreadable PDF, is an error.
/// The boolean reports bounded qpdf warnings to the load-policy owner.
pub(crate) fn load_qpdf_metadata_pdf_path(
    path: &Path,
    qpdf_path: &Path,
    purpose: QpdfMetadataPurpose,
) -> Result<Option<(IncrementalDocument, bool)>> {
    #[cfg(not(target_family = "wasm"))]
    {
        platform::load(path, qpdf_path, purpose)
    }
    #[cfg(target_family = "wasm")]
    {
        let _ = (path, qpdf_path, purpose);
        Ok(None)
    }
}

#[cfg(not(target_family = "wasm"))]
mod platform {
    use super::*;
    use crate::incremental_document::{
        MAX_QPDF_DIAGNOSTIC_BYTES, MAX_QPDF_OBJECT_BYTES, MAX_QPDF_OBJECT_ELEMENTS,
        MAX_QPDF_RETAINED_STRUCTURE_BYTES, QPDF_ESTIMATED_BYTES_PER_VALUE,
    };
    use std::{
        cell::Cell,
        collections::VecDeque,
        ffi::{c_char, c_int, c_uint, c_void, CStr, CString},
        io::BufRead,
    };

    type Handle = c_uint;
    type Data = *mut c_void;
    const MAX_XREF_BYTES: usize = 64 * 1024 * 1024;

    fn corrupt(message: impl Into<String>) -> Box<dyn Error> {
        domain_error(NativeErrorCode::CorruptXref, message)
    }

    fn limited(message: impl Into<String>) -> Box<dyn Error> {
        domain_error(NativeErrorCode::TooLarge, message)
    }

    fn unavailable(message: impl Into<String>) -> Box<dyn Error> {
        domain_error(NativeErrorCode::NativeFailure, message)
    }

    struct Library(Data);

    impl Library {
        fn open(path: &Path) -> std::io::Result<Self> {
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                let path = CString::new(path.as_os_str().as_bytes())?;
                let handle =
                    unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) };
                if handle.is_null() {
                    Err(Self::last_error())
                } else {
                    Ok(Self(handle))
                }
            }
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStrExt;
                let mut path = path.as_os_str().encode_wide().collect::<Vec<_>>();
                if path.contains(&0) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "Library path contains NUL",
                    ));
                }
                path.push(0);
                let mut previous = 0;
                let changed = unsafe { loader_os::SetThreadErrorMode(1, &mut previous) } != 0;
                let handle = unsafe {
                    loader_os::LoadLibraryExW(path.as_ptr(), std::ptr::null_mut(), 0x100 | 0x1000)
                };
                // Capture the load error before restoring thread-local mode.
                let result = if handle.is_null() {
                    Err(Self::last_error())
                } else {
                    Ok(Self(handle))
                };
                if changed && previous != 1 {
                    unsafe { loader_os::SetThreadErrorMode(previous, std::ptr::null_mut()) };
                }
                result
            }
        }

        unsafe fn symbol<T: Copy>(&self, name: &CStr) -> std::io::Result<T> {
            const { assert!(std::mem::size_of::<T>() == std::mem::size_of::<Data>()) };
            #[cfg(unix)]
            let pointer = unsafe {
                libc::dlerror();
                libc::dlsym(self.0, name.as_ptr())
            };
            #[cfg(windows)]
            let pointer = unsafe { loader_os::GetProcAddress(self.0, name.as_ptr()) };
            if pointer.is_null() {
                Err(Self::last_error())
            } else {
                // Api supplies only the declared qpdf C function-pointer types.
                Ok(unsafe { std::mem::transmute_copy(&pointer) })
            }
        }

        fn last_error() -> std::io::Error {
            #[cfg(unix)]
            {
                let pointer = unsafe { libc::dlerror() };
                std::io::Error::other(if pointer.is_null() {
                    "Dynamic library operation failed".to_string()
                } else {
                    unsafe { CStr::from_ptr(pointer) }
                        .to_string_lossy()
                        .into_owned()
                })
            }
            #[cfg(windows)]
            std::io::Error::last_os_error()
        }
    }

    impl Drop for Library {
        fn drop(&mut self) {
            #[cfg(unix)]
            unsafe {
                libc::dlclose(self.0)
            };
            #[cfg(windows)]
            unsafe {
                loader_os::FreeLibrary(self.0)
            };
        }
    }

    #[cfg(windows)]
    mod loader_os {
        use super::*;

        #[link(name = "kernel32")]
        unsafe extern "system" {
            pub(super) fn LoadLibraryExW(path: *const u16, file: Data, flags: u32) -> Data;
            pub(super) fn GetProcAddress(library: Data, name: *const c_char) -> Data;
            pub(super) fn FreeLibrary(library: Data) -> c_int;
            pub(super) fn SetThreadErrorMode(mode: u32, previous: *mut u32) -> c_int;
        }
    }

    // All functions are the stable qpdf C interface from qpdf-c.h. The library
    // stays alive until after its data and handles have been released.
    struct Api {
        init: unsafe extern "C" fn() -> Data,
        cleanup: unsafe extern "C" fn(*mut Data),
        read: unsafe extern "C" fn(Data, *const c_char, *const c_char) -> c_int,
        silence_errors: unsafe extern "C" fn(Data),
        suppress_warnings: unsafe extern "C" fn(Data, c_int),
        attempt_recovery: unsafe extern "C" fn(Data, c_int),
        has_error: unsafe extern "C" fn(Data) -> c_int,
        get_error: unsafe extern "C" fn(Data) -> Data,
        error_text: unsafe extern "C" fn(Data, Data) -> *const c_char,
        error_code: unsafe extern "C" fn(Data, Data) -> c_int,
        more_warnings: unsafe extern "C" fn(Data) -> c_int,
        next_warning: unsafe extern "C" fn(Data) -> Data,
        version: unsafe extern "C" fn(Data) -> *const c_char,
        trailer: unsafe extern "C" fn(Data) -> Handle,
        object: unsafe extern "C" fn(Data, c_int, c_int) -> Handle,
        is_stream: unsafe extern "C" fn(Data, Handle) -> c_int,
        object_type: unsafe extern "C" fn(Data, Handle) -> c_int,
        is_indirect: unsafe extern "C" fn(Data, Handle) -> c_int,
        name_equals: unsafe extern "C" fn(Data, Handle, *const c_char) -> c_int,
        has_key: unsafe extern "C" fn(Data, Handle, *const c_char) -> c_int,
        get_key: unsafe extern "C" fn(Data, Handle, *const c_char) -> Handle,
        object_id: unsafe extern "C" fn(Data, Handle) -> c_int,
        generation: unsafe extern "C" fn(Data, Handle) -> c_int,
        boolean: unsafe extern "C" fn(Data, Handle) -> c_int,
        integer: unsafe extern "C" fn(Data, Handle, *mut i64) -> c_int,
        real: unsafe extern "C" fn(Data, Handle, *mut *const c_char, *mut usize) -> c_int,
        name: unsafe extern "C" fn(Data, Handle, *mut *const c_char, *mut usize) -> c_int,
        string: unsafe extern "C" fn(Data, Handle, *mut usize) -> *const c_char,
        array_length: unsafe extern "C" fn(Data, Handle) -> c_int,
        array_item: unsafe extern "C" fn(Data, Handle, c_int) -> Handle,
        begin_keys: unsafe extern "C" fn(Data, Handle),
        more_keys: unsafe extern "C" fn(Data) -> c_int,
        next_key: unsafe extern "C" fn(Data) -> *const c_char,
        dictionary: unsafe extern "C" fn(Data, Handle) -> Handle,
        unparse: unsafe extern "C" fn(Data, Handle) -> *const c_char,
        string_length: unsafe extern "C" fn(Data) -> usize,
        release: unsafe extern "C" fn(Data, Handle),
        _library: Library,
    }

    impl Api {
        fn open(path: &Path) -> Result<Self> {
            // The complete path is owned by the bundled executable's family;
            // no environment or system library search chooses libqpdf.
            let library = Library::open(path).map_err(|error| {
                unavailable(format!("Cannot load bundled qpdf library: {error}"))
            })?;
            macro_rules! symbol {
                ($name:literal) => {
                    unsafe { library.symbol($name) }.map_err(|error| {
                        unavailable(format!(
                            "Bundled qpdf library is missing {}: {error}",
                            $name.to_string_lossy()
                        ))
                    })?
                };
            }
            Ok(Self {
                init: symbol!(c"qpdf_init"),
                cleanup: symbol!(c"qpdf_cleanup"),
                read: symbol!(c"qpdf_read"),
                silence_errors: symbol!(c"qpdf_silence_errors"),
                suppress_warnings: symbol!(c"qpdf_set_suppress_warnings"),
                attempt_recovery: symbol!(c"qpdf_set_attempt_recovery"),
                has_error: symbol!(c"qpdf_has_error"),
                get_error: symbol!(c"qpdf_get_error"),
                error_text: symbol!(c"qpdf_get_error_full_text"),
                error_code: symbol!(c"qpdf_get_error_code"),
                more_warnings: symbol!(c"qpdf_more_warnings"),
                next_warning: symbol!(c"qpdf_next_warning"),
                version: symbol!(c"qpdf_get_pdf_version"),
                trailer: symbol!(c"qpdf_get_trailer"),
                object: symbol!(c"qpdf_get_object_by_id"),
                is_stream: symbol!(c"qpdf_oh_is_stream"),
                object_type: symbol!(c"qpdf_oh_get_type_code"),
                is_indirect: symbol!(c"qpdf_oh_is_indirect"),
                name_equals: symbol!(c"qpdf_oh_is_name_and_equals"),
                has_key: symbol!(c"qpdf_oh_has_key"),
                get_key: symbol!(c"qpdf_oh_get_key"),
                object_id: symbol!(c"qpdf_oh_get_object_id"),
                generation: symbol!(c"qpdf_oh_get_generation"),
                boolean: symbol!(c"qpdf_oh_get_bool_value"),
                integer: symbol!(c"qpdf_oh_get_value_as_longlong"),
                real: symbol!(c"qpdf_oh_get_value_as_real"),
                name: symbol!(c"qpdf_oh_get_value_as_name"),
                string: symbol!(c"qpdf_oh_get_binary_string_value"),
                array_length: symbol!(c"qpdf_oh_get_array_n_items"),
                array_item: symbol!(c"qpdf_oh_get_array_item"),
                begin_keys: symbol!(c"qpdf_oh_begin_dict_key_iter"),
                more_keys: symbol!(c"qpdf_oh_dict_more_keys"),
                next_key: symbol!(c"qpdf_oh_dict_next_key"),
                dictionary: symbol!(c"qpdf_oh_get_dict"),
                unparse: symbol!(c"qpdf_oh_unparse_resolved"),
                string_length: symbol!(c"qpdf_get_last_string_length"),
                release: symbol!(c"qpdf_oh_release"),
                _library: library,
            })
        }
    }

    struct Reader {
        api: Api,
        data: Data,
        purpose: QpdfMetadataPurpose,
        diagnostic_bytes: Cell<usize>,
    }

    impl Drop for Reader {
        fn drop(&mut self) {
            unsafe { (self.api.cleanup)(&mut self.data) };
        }
    }

    struct ObjectHandle<'a> {
        reader: &'a Reader,
        value: Handle,
    }

    impl Drop for ObjectHandle<'_> {
        fn drop(&mut self) {
            unsafe { (self.reader.api.release)(self.reader.data, self.value) };
        }
    }

    impl Reader {
        fn open(library: &Path, path: &Path, purpose: QpdfMetadataPurpose) -> Result<Self> {
            let api = Api::open(library)?;
            let data = unsafe { (api.init)() };
            if data.is_null() {
                return Err(corrupt("Bundled qpdf library could not create a reader"));
            }
            let reader = Self {
                api,
                data,
                purpose,
                diagnostic_bytes: Cell::new(0),
            };
            unsafe {
                (reader.api.silence_errors)(data);
                (reader.api.suppress_warnings)(data, 1);
                (reader.api.attempt_recovery)(
                    data,
                    c_int::from(purpose == QpdfMetadataPurpose::Conformance),
                );
            }
            #[cfg(windows)]
            let path_bytes = path
                .to_str()
                .ok_or_else(|| {
                    domain_error(
                        NativeErrorCode::InvalidRequest,
                        "PDF path is not valid Unicode",
                    )
                })?
                .as_bytes();
            #[cfg(not(windows))]
            let path_bytes = path.as_os_str().as_encoded_bytes();
            let path = CString::new(path_bytes)
                .map_err(|_| io_domain_error(std::io::Error::other("PDF path contains NUL")))?;
            let status = unsafe { (reader.api.read)(data, path.as_ptr(), std::ptr::null()) };
            reader.checkpoint()?;
            if status & 2 != 0 {
                return Err(corrupt("Bundled qpdf could not read the PDF"));
            }
            Ok(reader)
        }

        fn check(&self) -> Result<()> {
            if unsafe { (self.api.has_error)(self.data) } == 0 {
                return Ok(());
            }
            let error = unsafe { (self.api.get_error)(self.data) };
            let code = unsafe { (self.api.error_code)(self.data, error) };
            let text = unsafe { (self.api.error_text)(self.data, error) };
            let message = if text.is_null() {
                "Bundled qpdf metadata read failed".to_string()
            } else {
                unsafe { CStr::from_ptr(text) }
                    .to_string_lossy()
                    .into_owned()
            };
            Err(domain_error(
                match code {
                    2 => NativeErrorCode::Io,
                    3 => NativeErrorCode::UnsupportedFilter,
                    4 => NativeErrorCode::NeedsPassword,
                    _ => NativeErrorCode::CorruptXref,
                },
                message,
            ))
        }

        fn checkpoint(&self) -> Result<()> {
            self.check()?;
            // qpdf retains warnings until retrieved. Drain at object boundaries
            // using the same byte ceiling as the CLI's diagnostic file.
            while unsafe { (self.api.more_warnings)(self.data) } != 0 {
                let warning = unsafe { (self.api.next_warning)(self.data) };
                let pointer = unsafe { (self.api.error_text)(self.data, warning) };
                if pointer.is_null() {
                    return Err(corrupt("Bundled qpdf returned an invalid warning"));
                }
                let bytes = unsafe { CStr::from_ptr(pointer) }.to_bytes().len();
                let total = self
                    .diagnostic_bytes
                    .get()
                    .checked_add(bytes)
                    .and_then(|bytes| bytes.checked_add(10))
                    .ok_or_else(|| limited("qpdf diagnostic byte count overflow"))?;
                if total > MAX_QPDF_DIAGNOSTIC_BYTES {
                    return Err(limited("qpdf diagnostics exceeded their resource limit"));
                }
                self.diagnostic_bytes.set(total);
            }
            Ok(())
        }

        fn handle(&self, value: Handle) -> Result<ObjectHandle<'_>> {
            self.check()?;
            if value == 0 {
                return Err(corrupt(
                    "Bundled qpdf returned an uninitialized object handle",
                ));
            }
            Ok(ObjectHandle {
                reader: self,
                value,
            })
        }

        fn version(&self) -> Result<String> {
            let version = unsafe { (self.api.version)(self.data) };
            self.check()?;
            if version.is_null() {
                return Err(corrupt("Bundled qpdf did not report the PDF version"));
            }
            Ok(unsafe { CStr::from_ptr(version) }.to_str()?.to_string())
        }

        fn trailer(&self) -> Result<Dictionary> {
            let handle = self.handle(unsafe { (self.api.trailer)(self.data) })?;
            let object = self.convert(&handle, Context::Value)?;
            self.checkpoint()?;
            object.as_dict().cloned().map_err(Into::into)
        }

        fn object(&self, id: ObjectId, context: Context) -> Result<Object> {
            let handle = self.object_handle(id)?;
            let object = self.convert(&handle, context)?;
            self.checkpoint()?;
            Ok(object)
        }

        fn object_handle(&self, id: ObjectId) -> Result<ObjectHandle<'_>> {
            let number = c_int::try_from(id.0)
                .map_err(|_| limited("PDF object number exceeds qpdf's supported range"))?;
            self.handle(unsafe { (self.api.object)(self.data, number, id.1.into()) })
        }

        fn signature_dictionary(&self, handle: &ObjectHandle<'_>) -> Result<bool> {
            let kind = self.handle(unsafe {
                (self.api.get_key)(self.data, handle.value, c"/Type".as_ptr())
            })?;
            let direct = unsafe { (self.api.is_indirect)(self.data, kind.value) } == 0;
            let signature = direct
                && unsafe { (self.api.name_equals)(self.data, kind.value, c"/Sig".as_ptr()) } != 0;
            let ranges =
                unsafe { (self.api.has_key)(self.data, handle.value, c"/ByteRange".as_ptr()) } != 0;
            let contents =
                unsafe { (self.api.has_key)(self.data, handle.value, c"/Contents".as_ptr()) } != 0;
            self.check()?;
            Ok(signature || (ranges && contents))
        }

        fn is_signature(&self, id: ObjectId) -> Result<bool> {
            let object = self.object_handle(id)?;
            let kind = unsafe { (self.api.object_type)(self.data, object.value) };
            self.check()?;
            if kind != 9 && kind != 10 {
                return Ok(false);
            }
            let stream_dictionary;
            let dictionary = if kind == 10 {
                stream_dictionary =
                    self.handle(unsafe { (self.api.dictionary)(self.data, object.value) })?;
                &stream_dictionary
            } else {
                &object
            };
            if self.signature_dictionary(dictionary)? {
                return Ok(true);
            }
            let value = self.handle(unsafe {
                (self.api.get_key)(self.data, dictionary.value, c"/V".as_ptr())
            })?;
            let kind = unsafe { (self.api.object_type)(self.data, value.value) };
            self.check()?;
            if kind == 9 {
                self.signature_dictionary(&value)
            } else {
                Ok(false)
            }
        }

        fn encoded(&self, value: Handle) -> Result<&[u8]> {
            let pointer = unsafe { (self.api.unparse)(self.data, value) };
            self.check()?;
            let length = unsafe { (self.api.string_length)(self.data) };
            if length > MAX_QPDF_OBJECT_BYTES {
                return Err(limited("qpdf object exceeds its structural byte ceiling"));
            }
            if pointer.is_null() {
                return Err(corrupt(
                    "Bundled qpdf did not return the selected object's value",
                ));
            }
            Ok(unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length) })
        }

        fn convert(&self, handle: &ObjectHandle<'_>, context: Context) -> Result<Object> {
            let is_stream = unsafe { (self.api.is_stream)(self.data, handle.value) } != 0;
            self.check()?;
            let dictionary;
            let value = if is_stream {
                dictionary =
                    self.handle(unsafe { (self.api.dictionary)(self.data, handle.value) })?;
                dictionary.value
            } else {
                handle.value
            };
            if !is_stream {
                if let Some((object, _)) =
                    self.selected_dictionary(value, context, 0, &mut 1, MAX_QPDF_OBJECT_BYTES)?
                {
                    return Ok(object);
                }
            }
            let bytes = self.encoded(value)?;
            // A PDF name cannot contain NUL, but preserve a tolerated foreign
            // name through the existing codec when possible. C's dictionary
            // iterator cannot represent such keys. Normal objects use typed,
            // length-aware values and keep the existing structural depth limit.
            let object = if contains_nul_name(bytes)
                && !matches!(context, Context::AnnotationEntry | Context::AnnotationIndex)
            {
                parse_selected_object(bytes)?
            } else {
                self.typed(
                    value,
                    true,
                    0,
                    &mut 0,
                    if is_stream { Context::Value } else { context },
                )?
            };
            if is_stream {
                Ok(Object::Stream(Stream::with_position(
                    object.as_dict()?.clone(),
                    0,
                )))
            } else {
                Ok(object)
            }
        }

        fn value_bytes(&self, pointer: *const c_char, length: usize) -> Result<&[u8]> {
            self.check()?;
            if length > MAX_QPDF_OBJECT_BYTES {
                return Err(limited("qpdf value exceeds its structural byte ceiling"));
            }
            if pointer.is_null() {
                return Err(corrupt("Bundled qpdf returned a null value buffer"));
            }
            Ok(unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length) })
        }

        fn selected_dictionary(
            &self,
            handle: Handle,
            context: Context,
            depth: usize,
            elements: &mut usize,
            max_bytes: usize,
        ) -> Result<Option<(Object, usize)>> {
            if !(matches!(
                context,
                Context::PageTree
                    | Context::AnnotationEntry
                    | Context::AnnotationIndex
                    | Context::Outline
            ) || context == Context::Root && self.purpose == QpdfMetadataPurpose::Catalog)
            {
                return Ok(None);
            }
            let kind = unsafe { (self.api.object_type)(self.data, handle) };
            self.check()?;
            if kind != 9 {
                return Ok(None);
            }
            let index = context == Context::AnnotationIndex;
            let mut dictionary = Dictionary::new();
            let mut encoded_bytes = 5usize;
            if encoded_bytes > max_bytes {
                return Err(limited("qpdf object exceeds its structural byte ceiling"));
            }
            if context == Context::AnnotationEntry {
                let reply = unsafe { (self.api.has_key)(self.data, handle, c"/IRT".as_ptr()) } != 0;
                self.check()?;
                if reply {
                    return Ok(None);
                }
                let subtype = self.handle(unsafe {
                    (self.api.get_key)(self.data, handle, c"/Subtype".as_ptr())
                })?;
                let indirect = unsafe { (self.api.is_indirect)(self.data, subtype.value) } != 0;
                let allowance = max_bytes - encoded_bytes - c"/Subtype".to_bytes().len() - 2;
                let mut pointer = std::ptr::null();
                let mut length = 0;
                let name =
                    unsafe { (self.api.name)(self.data, subtype.value, &mut pointer, &mut length) }
                        != 0;
                self.check()?;
                if name {
                    let bytes = self.value_bytes(pointer, length)?;
                    let name = bytes
                        .strip_prefix(b"/")
                        .ok_or_else(|| corrupt("PDF name is missing its slash"))?;
                    if !crate::annotation_parse::parsed_annotation_subtype(
                        &String::from_utf8_lossy(name),
                    )
                    .is_empty()
                    {
                        return Ok(None);
                    }
                    let (object, length) = if !indirect
                        && name.iter().all(u8::is_ascii_alphanumeric)
                    {
                        let length = name.len() + 1;
                        if length > allowance {
                            return Err(limited("qpdf object exceeds its structural byte ceiling"));
                        }
                        charge_element(depth + 1, elements)?;
                        (Object::Name(name.to_vec()), length)
                    } else {
                        self.selected_value(
                            &subtype,
                            depth + 1,
                            elements,
                            Context::Value,
                            allowance,
                        )?
                    };
                    encoded_bytes += c"/Subtype".to_bytes().len() + length + 2;
                    dictionary.set("Subtype", object);
                } else if unsafe { (self.api.has_key)(self.data, handle, c"/Subtype".as_ptr()) }
                    != 0
                {
                    let (object, length) = self.selected_value(
                        &subtype,
                        depth + 1,
                        elements,
                        Context::Value,
                        allowance,
                    )?;
                    encoded_bytes += c"/Subtype".to_bytes().len() + length + 2;
                    dictionary.set("Subtype", object);
                }
                self.check()?;
                if encoded_bytes > max_bytes {
                    return Err(limited("qpdf object exceeds its structural byte ceiling"));
                }
            }
            // Select only through the actual page-tree or Annots ownership
            // context. Private dictionaries always keep their complete graph.
            let keys = if context == Context::PageTree {
                if matches!(
                    self.purpose,
                    QpdfMetadataPurpose::Annotations | QpdfMetadataPurpose::AnnotationIndex
                ) {
                    &[
                        c"/Type",
                        c"/Kids",
                        c"/Parent",
                        c"/Count",
                        c"/MediaBox",
                        c"/CropBox",
                        c"/Rotate",
                        c"/UserUnit",
                        c"/Annots",
                    ][..]
                } else {
                    &[
                        c"/Type",
                        c"/Kids",
                        c"/Parent",
                        c"/Count",
                        c"/MediaBox",
                        c"/CropBox",
                        c"/Rotate",
                        c"/UserUnit",
                    ][..]
                }
            } else if context == Context::Root {
                &[
                    c"/Type",
                    c"/Pages",
                    c"/Outlines",
                    c"/PageLabels",
                    c"/Dests",
                    c"/Names",
                    c"/AcroForm",
                    c"/AF",
                ][..]
            } else if context == Context::Outline {
                &[
                    c"/Title", c"/A", c"/Dest", c"/First", c"/Next", c"/F", c"/C",
                ][..]
            } else if index {
                &[c"/Subtype", c"/NM", c"/IRT", c"/Popup", c"/Parent"][..]
            } else {
                &[c"/NM"][..]
            };
            for key in keys {
                if unsafe { (self.api.has_key)(self.data, handle, key.as_ptr()) } == 0 {
                    self.check()?;
                    continue;
                }
                let value =
                    self.handle(unsafe { (self.api.get_key)(self.data, handle, key.as_ptr()) })?;
                let child_context = if context == Context::PageTree && *key == c"/Annots" {
                    if self.purpose == QpdfMetadataPurpose::AnnotationIndex {
                        Context::AnnotationIndex
                    } else {
                        Context::AnnotationEntry
                    }
                } else if (context == Context::Root && *key == c"/Outlines")
                    || (context == Context::Outline
                        && matches!(key.to_bytes(), b"/First" | b"/Next"))
                {
                    Context::Outline
                } else {
                    Context::Value
                };
                let allowance = max_bytes
                    .checked_sub(encoded_bytes + key.to_bytes().len() + 2)
                    .ok_or_else(|| limited("qpdf object exceeds its structural byte ceiling"))?;
                let (object, length) =
                    self.selected_value(&value, depth + 1, elements, child_context, allowance)?;
                encoded_bytes = encoded_bytes
                    .checked_add(key.to_bytes().len() + length + 2)
                    .ok_or_else(|| limited("PDF metadata object byte count overflow"))?;
                if encoded_bytes > max_bytes {
                    return Err(limited("qpdf object exceeds its structural byte ceiling"));
                }
                dictionary.set(&key.to_bytes()[1..], object);
            }
            Ok(Some((Object::Dictionary(dictionary), encoded_bytes)))
        }

        fn selected_value(
            &self,
            value: &ObjectHandle<'_>,
            depth: usize,
            elements: &mut usize,
            context: Context,
            allowance: usize,
        ) -> Result<(Object, usize)> {
            if unsafe { (self.api.is_indirect)(self.data, value.value) } != 0 {
                let object = self.typed(value.value, false, depth, elements, context)?;
                let id = object.as_reference()?;
                let length = format!("{} {} R", id.0, id.1).len();
                if length > allowance {
                    return Err(limited("qpdf object exceeds its structural byte ceiling"));
                }
                return Ok((object, length));
            }
            let kind = unsafe { (self.api.object_type)(self.data, value.value) };
            self.check()?;
            if context == Context::Outline && kind == 9 {
                charge_element(depth, elements)?;
                return self
                    .selected_dictionary(value.value, context, depth, elements, allowance)?
                    .ok_or_else(|| corrupt("Outline dictionary could not be selected"));
            }
            if kind == 6 {
                let mut length = 0usize;
                let pointer = unsafe { (self.api.string)(self.data, value.value, &mut length) };
                let bytes = self.value_bytes(pointer, length)?;
                // qpdf emits printable ASCII without these three escapes as
                // a literal string. Other bytes retain qpdf's exact codec.
                if bytes
                    .iter()
                    .all(|byte| (32..=126).contains(byte) && !b"()\\".contains(byte))
                {
                    let length = bytes.len() + 2;
                    if length > allowance {
                        return Err(limited("qpdf object exceeds its structural byte ceiling"));
                    }
                    charge_element(depth, elements)?;
                    return Ok((
                        Object::String(bytes.to_vec(), StringFormat::Hexadecimal),
                        length,
                    ));
                }
            }
            let bytes = self.encoded(value.value)?;
            let length = bytes.len();
            if length > allowance {
                return Err(limited("qpdf object exceeds its structural byte ceiling"));
            }
            let object = if contains_nul_name(bytes)
                && !matches!(context, Context::AnnotationEntry | Context::AnnotationIndex)
            {
                let object = parse_selected_object(bytes)?;
                charge_elements(&object, depth, elements, 0)?;
                object
            } else {
                self.typed(value.value, false, depth, elements, context)?
            };
            Ok((object, length))
        }

        fn typed(
            &self,
            handle: Handle,
            top: bool,
            depth: usize,
            elements: &mut usize,
            context: Context,
        ) -> Result<Object> {
            charge_element(depth, elements)?;
            if !top && unsafe { (self.api.is_indirect)(self.data, handle) } != 0 {
                let number = unsafe { (self.api.object_id)(self.data, handle) };
                let generation = unsafe { (self.api.generation)(self.data, handle) };
                self.check()?;
                return Ok(Object::Reference((
                    u32::try_from(number)?,
                    u16::try_from(generation)?,
                )));
            }
            let kind = unsafe { (self.api.object_type)(self.data, handle) };
            self.check()?;
            let object = match kind {
                2 => Object::Null,
                3 => Object::Boolean(unsafe { (self.api.boolean)(self.data, handle) } != 0),
                4 => {
                    let mut value = 0i64;
                    if unsafe { (self.api.integer)(self.data, handle, &mut value) } == 0 {
                        self.check()?;
                        return Err(corrupt("PDF integer exceeds i64"));
                    }
                    Object::Integer(value)
                }
                5 | 7 => {
                    let mut pointer = std::ptr::null();
                    let mut length = 0usize;
                    let read = if kind == 5 {
                        self.api.real
                    } else {
                        self.api.name
                    };
                    if unsafe { read(self.data, handle, &mut pointer, &mut length) } == 0 {
                        self.check()?;
                        return Err(corrupt("Bundled qpdf returned an invalid scalar value"));
                    }
                    let bytes = self.value_bytes(pointer, length)?;
                    if kind == 7 {
                        let name = bytes
                            .strip_prefix(b"/")
                            .ok_or_else(|| corrupt("PDF name is missing its slash"))?;
                        Object::Name(name.to_vec())
                    } else {
                        // qpdf's JSON writer turns a bare decimal point into
                        // 0.0, including its signed form. Keep that read view.
                        let number = match bytes {
                            b"" | b"." => 0.0,
                            b"-." => -0.0,
                            _ => std::str::from_utf8(bytes)?.parse::<f64>()?,
                        };
                        let value = number as f32;
                        if !number.is_finite() || !value.is_finite() {
                            return Err(corrupt("PDF real number is not finite or exceeds f32"));
                        }
                        Object::Real(value)
                    }
                }
                6 => {
                    let mut length = 0usize;
                    let pointer = unsafe { (self.api.string)(self.data, handle, &mut length) };
                    Object::String(
                        self.value_bytes(pointer, length)?.to_vec(),
                        StringFormat::Hexadecimal,
                    )
                }
                8 => {
                    let length = unsafe { (self.api.array_length)(self.data, handle) };
                    self.check()?;
                    let length = usize::try_from(length)?;
                    if length > MAX_QPDF_OBJECT_ELEMENTS.saturating_sub(*elements) {
                        return Err(limited("Selected qpdf array exceeds its element ceiling"));
                    }
                    let mut values = Vec::with_capacity(length);
                    for index in 0..length {
                        let item = self.handle(unsafe {
                            (self.api.array_item)(self.data, handle, c_int::try_from(index)?)
                        })?;
                        values.push(self.typed(item.value, false, depth + 1, elements, context)?);
                    }
                    Object::Array(values)
                }
                9 => {
                    if let Some((object, _)) = self.selected_dictionary(
                        handle,
                        context,
                        depth,
                        elements,
                        MAX_QPDF_OBJECT_BYTES,
                    )? {
                        return Ok(object);
                    }
                    if matches!(context, Context::AnnotationEntry | Context::AnnotationIndex) {
                        let bytes = self.encoded(handle)?;
                        if contains_nul_name(bytes) {
                            let object = parse_selected_object(bytes)?;
                            charge_elements(&object, depth, elements, 1)?;
                            return Ok(object);
                        }
                    }
                    // qpdf supports only one C dictionary iterator at a time.
                    // Copy its keys before descending into any child dictionary.
                    let mut keys = Vec::new();
                    unsafe { (self.api.begin_keys)(self.data, handle) };
                    self.check()?;
                    while unsafe { (self.api.more_keys)(self.data) } != 0 {
                        let pointer = unsafe { (self.api.next_key)(self.data) };
                        self.check()?;
                        if pointer.is_null()
                            || keys.len() >= MAX_QPDF_OBJECT_ELEMENTS.saturating_sub(*elements)
                        {
                            return Err(limited(
                                "Selected qpdf dictionary exceeds its element ceiling",
                            ));
                        }
                        let key = unsafe { CStr::from_ptr(pointer) }.to_bytes().to_vec();
                        keys.push(key);
                    }
                    let mut dictionary = Dictionary::new();
                    for key in keys {
                        let c_key = CString::new(key.clone())
                            .map_err(|_| corrupt("PDF dictionary key contains NUL"))?;
                        let value = self.handle(unsafe {
                            (self.api.get_key)(self.data, handle, c_key.as_ptr())
                        })?;
                        let name = key
                            .strip_prefix(b"/")
                            .ok_or_else(|| corrupt("PDF dictionary key is missing its slash"))?;
                        dictionary.set(
                            name,
                            self.typed(value.value, false, depth + 1, elements, Context::Value)?,
                        );
                    }
                    Object::Dictionary(dictionary)
                }
                _ => {
                    return Err(corrupt(
                        "Bundled qpdf returned an unsupported metadata object type",
                    ));
                }
            };
            self.check()?;
            Ok(object)
        }
    }

    fn contains_nul_name(bytes: &[u8]) -> bool {
        let mut index = 0usize;
        while index < bytes.len() {
            match bytes[index] {
                b'(' => {
                    let mut depth = 1usize;
                    index += 1;
                    while index < bytes.len() && depth > 0 {
                        match bytes[index] {
                            b'\\' => index += 1,
                            b'(' => depth += 1,
                            b')' => depth -= 1,
                            _ => {}
                        }
                        index += 1;
                    }
                }
                b'<' if bytes.get(index + 1) == Some(&b'<') => index += 2,
                b'<' => {
                    index += 1;
                    while index < bytes.len() && bytes[index] != b'>' {
                        index += 1;
                    }
                    index += 1;
                }
                b'/' => {
                    let start = index;
                    index += 1;
                    while index < bytes.len()
                        && !bytes[index].is_ascii_whitespace()
                        && !b"()<>[]{}/%".contains(&bytes[index])
                    {
                        index += 1;
                    }
                    if bytes[start..index].windows(3).any(|value| value == b"#00") {
                        return true;
                    }
                }
                _ => index += 1,
            }
        }
        false
    }

    fn parse_selected_object(value: &[u8]) -> Result<Object> {
        let mut bytes = b"%PDF-1.7\n1 0 obj\n<< /EVBValue ".to_vec();
        bytes.extend_from_slice(value);
        bytes.extend_from_slice(b" >>\nendobj\n");
        let xref = bytes.len();
        bytes.extend_from_slice(
            b"xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n",
        );
        bytes.extend_from_slice(format!("{xref}\n%%EOF\n").as_bytes());
        preflight_pdf_object_graph(
            &bytes,
            MAX_QPDF_OBJECT_BYTES + 256,
            MAX_QPDF_OBJECT_ELEMENTS,
        )?;
        let document = Document::load_mem_with_options(
            &bytes,
            lopdf::LoadOptions::with_max_decompressed_size(MAX_DECOMPRESSED_PDF_STREAM_BYTES),
        )
        .map_err(|error| corrupt(format!("Cannot decode selected qpdf object: {error}")))?;
        Ok(document.get_dictionary((1, 0))?.get(b"EVBValue")?.clone())
    }

    fn adjacent_library(qpdf_path: &Path) -> Result<Option<PathBuf>> {
        let Some(bin) = qpdf_path.parent() else {
            return Ok(None);
        };
        #[cfg(windows)]
        let directory = bin.to_path_buf();
        #[cfg(not(windows))]
        let directory = bin.parent().unwrap_or(bin).join("lib");
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_domain_error(error)),
        };
        let mut candidates = Vec::new();
        for entry in entries {
            let entry = entry.map_err(io_domain_error)?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            #[cfg(target_os = "macos")]
            let matches = name == "libqpdf.dylib"
                || (name.starts_with("libqpdf.") && name.ends_with(".dylib"));
            #[cfg(all(not(target_os = "macos"), not(windows)))]
            let matches = name == "libqpdf.so" || name.starts_with("libqpdf.so.");
            #[cfg(windows)]
            let matches =
                name.ends_with(".dll") && (name.starts_with("qpdf") || name.starts_with("libqpdf"));
            if matches {
                candidates.push(entry.path());
            }
        }
        candidates.sort();
        candidates
            .into_iter()
            .next()
            .map(fs::canonicalize)
            .transpose()
            .map_err(io_domain_error)
    }

    #[derive(Clone, Copy, Eq, Hash, PartialEq)]
    enum Context {
        Root,
        PageTree,
        Value,
        AnnotationEntry,
        Annotation,
        AnnotationIndex,
        Catalog,
        Outline,
        Names,
        Conformance,
    }

    struct Projection<'a> {
        reader: &'a Reader,
        document: Document,
        pending: VecDeque<(ObjectId, Context)>,
        visited: HashSet<(ObjectId, Context)>,
        retained: usize,
    }

    impl Projection<'_> {
        fn enqueue(&mut self, object: &Object, context: Context, depth: usize) -> Result<()> {
            if depth > MAX_PDF_STRUCTURAL_NESTING {
                return Err(limited(
                    "PDF metadata graph exceeds its structural depth ceiling",
                ));
            }
            match object {
                Object::Reference(id) => {
                    if !self.visited.contains(&(*id, context)) {
                        if self.pending.len() >= MAX_QPDF_OBJECT_ELEMENTS {
                            return Err(limited("PDF metadata graph exceeds its object ceiling"));
                        }
                        // Discover physical pages before optional graphs. Their
                        // identity then comes from the actual page tree, not a
                        // private dictionary that happens to use /Type /Page.
                        if matches!(context, Context::Root | Context::PageTree | Context::Value) {
                            self.pending.push_back((*id, context));
                        } else {
                            self.pending.push_front((*id, context));
                        }
                    }
                }
                Object::Array(values) => {
                    for value in values {
                        self.enqueue(value, context, depth + 1)?;
                    }
                }
                Object::Dictionary(dictionary) => self.targets(dictionary, context, depth + 1)?,
                Object::Stream(stream) => self.targets(&stream.dict, context, depth + 2)?,
                _ => {}
            }
            Ok(())
        }

        fn targets(&mut self, dict: &Dictionary, context: Context, depth: usize) -> Result<()> {
            let kind = dict
                .get(b"Type")
                .ok()
                .and_then(|value| value.as_name().ok());
            if context == Context::PageTree {
                for key in [
                    b"Kids".as_slice(),
                    b"Parent",
                    b"Count",
                    b"MediaBox",
                    b"CropBox",
                    b"Rotate",
                ] {
                    if let Ok(value) = dict.get(key) {
                        self.enqueue(
                            value,
                            if key == b"Kids" || key == b"Parent" {
                                Context::PageTree
                            } else {
                                Context::Value
                            },
                            depth,
                        )?;
                    }
                }
                if kind == Some(b"Page") {
                    if let Ok(unit) = dict.get(b"UserUnit") {
                        self.enqueue(unit, Context::Value, depth)?;
                    }
                    if matches!(
                        self.reader.purpose,
                        QpdfMetadataPurpose::Annotations | QpdfMetadataPurpose::AnnotationIndex
                    ) {
                        if let Ok(annots) = dict.get(b"Annots") {
                            self.enqueue(
                                annots,
                                if self.reader.purpose == QpdfMetadataPurpose::AnnotationIndex {
                                    Context::AnnotationIndex
                                } else {
                                    Context::AnnotationEntry
                                },
                                depth,
                            )?;
                        }
                    }
                }
                return Ok(());
            }
            if context == Context::Root {
                if self.reader.purpose == QpdfMetadataPurpose::Catalog {
                    for key in [b"Outlines".as_slice(), b"PageLabels", b"Dests", b"Names"] {
                        if let Ok(value) = dict.get(key) {
                            self.enqueue(
                                value,
                                if key == b"Names" {
                                    Context::Names
                                } else if key == b"Outlines" {
                                    Context::Outline
                                } else {
                                    Context::Catalog
                                },
                                depth,
                            )?;
                        }
                    }
                }
                if self.reader.purpose == QpdfMetadataPurpose::Conformance {
                    for key in [b"AcroForm".as_slice(), b"StructTreeRoot"] {
                        if let Ok(value) = dict.get(key) {
                            self.enqueue(value, Context::Conformance, depth)?;
                        }
                    }
                }
                // Inline optional graphs may queue destination page values.
                // Queue Pages last so physical identities are discovered first.
                if self.reader.purpose != QpdfMetadataPurpose::Conformance {
                    if let Ok(pages) = dict.get(b"Pages") {
                        self.enqueue(pages, Context::PageTree, depth)?;
                    }
                }
                return Ok(());
            }
            for (key, value) in dict.iter() {
                if context == Context::AnnotationIndex
                    && !matches!(key.as_slice(), b"Subtype" | b"NM")
                {
                    continue;
                }
                if context == Context::Names && key.as_slice() != b"Dests" {
                    continue;
                }
                if context == Context::Conformance {
                    continue;
                }
                self.enqueue(
                    value,
                    if context == Context::AnnotationEntry {
                        Context::Annotation
                    } else if context == Context::AnnotationIndex {
                        Context::Value
                    } else if context == Context::Names {
                        Context::Catalog
                    } else if context == Context::Outline
                        && !matches!(key.as_slice(), b"First" | b"Next")
                    {
                        Context::Value
                    } else {
                        context
                    },
                    depth,
                )?;
            }
            Ok(())
        }

        fn insert(&mut self, id: ObjectId, object: Object) -> Result<()> {
            let previous = self
                .document
                .objects
                .get(&id)
                .map(retained_cost)
                .transpose()?
                .unwrap_or(0);
            if previous == 0 && self.document.objects.len() >= MAX_QPDF_OBJECT_ELEMENTS {
                return Err(limited("PDF metadata graph exceeds its object ceiling"));
            }
            let cost = retained_cost(&object)?;
            self.retained = self
                .retained
                .checked_sub(previous)
                .ok_or_else(|| limited("PDF metadata retained size underflow"))?
                .checked_add(cost)
                .ok_or_else(|| limited("PDF metadata retained size overflow"))?;
            if self.retained > MAX_QPDF_RETAINED_STRUCTURE_BYTES {
                return Err(limited(
                    "Selected qpdf metadata exceeds its retained memory ceiling",
                ));
            }
            self.document.objects.insert(id, object);
            Ok(())
        }

        fn drain(&mut self) -> Result<()> {
            while let Some((id, context)) = self.pending.pop_back() {
                if !self.visited.insert((id, context)) {
                    continue;
                }
                if !matches!(context, Context::Root | Context::PageTree)
                    && (self.visited.contains(&(id, Context::Root))
                        || self.visited.contains(&(id, Context::PageTree)))
                {
                    continue;
                }
                // Entry projections may have been read before a note's full
                // recovery graph reaches the same object. Full reads dominate.
                if (context == Context::AnnotationEntry
                    && (self.visited.contains(&(id, Context::Annotation))
                        || self.visited.contains(&(id, Context::Value))))
                    || (context == Context::Outline
                        && (self.visited.contains(&(id, Context::Catalog))
                            || self.visited.contains(&(id, Context::Value))))
                {
                    continue;
                }
                if self.visited.len() > MAX_QPDF_OBJECT_ELEMENTS {
                    return Err(limited("PDF metadata graph exceeds its object ceiling"));
                }
                let object = self.reader.object(id, context)?;
                self.enqueue(&object, context, 0)?;
                // Names keeps a full dictionary but follows only Dests. Retain
                // it after walking this same object's selected outline edges.
                if context != Context::Outline || !self.visited.contains(&(id, Context::Names)) {
                    self.insert(id, object)?;
                }
            }
            Ok(())
        }
    }

    fn charge_element(depth: usize, elements: &mut usize) -> Result<()> {
        *elements += 1;
        if *elements > MAX_QPDF_OBJECT_ELEMENTS || depth > MAX_PDF_STRUCTURAL_NESTING {
            return Err(limited(
                "Selected qpdf object exceeds its element or nesting ceiling",
            ));
        }
        Ok(())
    }

    fn charge_elements(
        object: &Object,
        depth: usize,
        elements: &mut usize,
        counted: usize,
    ) -> Result<()> {
        *elements = elements
            .checked_add(object_cost(object, depth)?.1 - counted)
            .ok_or_else(|| limited("PDF metadata element count overflow"))?;
        if *elements > MAX_QPDF_OBJECT_ELEMENTS {
            return Err(limited("Selected qpdf object exceeds its element ceiling"));
        }
        Ok(())
    }

    fn retained_cost(object: &Object) -> Result<usize> {
        Ok(object_cost(object, 0)?.0)
    }

    fn object_cost(object: &Object, initial_depth: usize) -> Result<(usize, usize)> {
        let mut pending = vec![(object, initial_depth)];
        let mut elements = 0usize;
        let mut bytes = 0usize;
        while let Some((object, depth)) = pending.pop() {
            elements += 1;
            if elements > MAX_QPDF_OBJECT_ELEMENTS || depth > MAX_PDF_STRUCTURAL_NESTING {
                return Err(limited(
                    "Selected qpdf object exceeds its element or nesting ceiling",
                ));
            }
            bytes = bytes
                .checked_add(QPDF_ESTIMATED_BYTES_PER_VALUE)
                .ok_or_else(|| limited("PDF metadata retained size overflow"))?;
            match object {
                Object::Name(value) | Object::String(value, _) => {
                    bytes = bytes
                        .checked_add(value.len())
                        .ok_or_else(|| limited("PDF metadata retained size overflow"))?;
                }
                Object::Array(values) => {
                    pending.extend(values.iter().map(|value| (value, depth + 1)))
                }
                Object::Dictionary(dict) => {
                    for (key, value) in dict.iter() {
                        bytes = bytes
                            .checked_add(key.len())
                            .ok_or_else(|| limited("PDF metadata retained size overflow"))?;
                        pending.push((value, depth + 1));
                    }
                }
                Object::Stream(stream) => {
                    for (key, value) in stream.dict.iter() {
                        bytes = bytes
                            .checked_add(key.len())
                            .ok_or_else(|| limited("PDF metadata retained size overflow"))?;
                        pending.push((value, depth + 1));
                    }
                }
                _ => {}
            }
        }
        Ok((bytes, elements))
    }

    fn read_signatures(projection: &mut Projection<'_>, path: &Path, qpdf: &Path) -> Result<()> {
        let temp = TempQpdfFiles::create()?;
        run_qpdf_bounded(path, qpdf, &["--show-xref"], &temp, MAX_XREF_BYTES)?;
        let file = File::open(&temp.structure).map_err(io_domain_error)?;
        let mut count = 0usize;
        for line in BufReader::new(file).lines() {
            let line = line.map_err(io_domain_error)?;
            count += 1;
            if count > MAX_QPDF_OBJECT_ELEMENTS {
                return Err(limited("PDF xref exceeds its object ceiling"));
            }
            let (reference, _) = line
                .split_once(": ")
                .ok_or_else(|| corrupt("Malformed qpdf xref row"))?;
            let (number, generation) = reference
                .split_once('/')
                .ok_or_else(|| corrupt("Malformed qpdf xref reference"))?;
            let id = (number.parse::<u32>()?, generation.parse::<u16>()?);
            if projection.reader.is_signature(id)? && !projection.document.objects.contains_key(&id)
            {
                // Keep a compact signature witness; the existing facts reader
                // observes the exact global predicate without retaining all
                // dictionaries or their unrelated contents.
                let mut witness = Dictionary::new();
                witness.set("Type", Object::Name(b"Sig".to_vec()));
                projection.insert(id, Object::Dictionary(witness))?;
            }
            projection.reader.checkpoint()?;
        }
        Ok(())
    }

    pub(super) fn load(
        path: &Path,
        qpdf: &Path,
        purpose: QpdfMetadataPurpose,
    ) -> Result<Option<(IncrementalDocument, bool)>> {
        let Some(library) = adjacent_library(qpdf)? else {
            return Ok(None);
        };
        let initial = fs::metadata(path).map_err(io_domain_error)?;
        let recovered = purpose == QpdfMetadataPurpose::Conformance;
        let reader = Reader::open(&library, path, purpose)?;
        let mut document = Document::with_version(reader.version()?);
        document.trailer = reader.trailer()?;
        document.max_id = document
            .trailer
            .get(b"Size")
            .ok()
            .and_then(|size| size.as_i64().ok())
            .and_then(|size| size.checked_sub(1))
            .and_then(|size| u32::try_from(size).ok())
            .unwrap_or(0);
        if !recovered {
            assert_plaintext_base(
                &document,
                "Encrypted PDFs are not supported by native metadata reads",
            )?;
        }
        let root = document.trailer.get(b"Root")?.clone();
        let retained = retained_cost(&Object::Dictionary(document.trailer.clone()))?;
        let mut projection = Projection {
            reader: &reader,
            document,
            pending: VecDeque::new(),
            visited: HashSet::new(),
            retained,
        };
        projection.enqueue(&root, Context::Root, 0)?;
        projection.drain()?;
        if recovered {
            read_signatures(&mut projection, path, qpdf)?;
        }
        let current = fs::metadata(path).map_err(io_domain_error)?;
        if current.len() != initial.len() || current.modified().ok() != initial.modified().ok() {
            return Err(corrupt("PDF input changed while reading native metadata"));
        }
        let mut file = File::open(path).map_err(io_domain_error)?;
        let last = read_last_byte_from_file(&mut file, initial.len())?;
        let unavailable = projection
            .document
            .objects
            .iter()
            .filter_map(|(id, object)| matches!(object, Object::Stream(_)).then_some(*id))
            .collect();
        let mut incremental =
            IncrementalDocument::from_document(projection.document, initial.len(), last);
        incremental.unavailable_base_streams = unavailable;
        Ok(Some((incremental, reader.diagnostic_bytes.get() != 0)))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn selected_object_codec_preserves_binary_keys_strings_and_foreign_references() {
            let object = parse_selected_object(
                b"<< /Vendor#00Key <00ff8081> /Name /A#00B /Text <feff05d005d1> /Target 900 7 R >>",
            )
            .unwrap();
            let dict = object.as_dict().unwrap();
            assert_eq!(
                dict.get(b"Vendor\0Key").unwrap().as_str().unwrap(),
                &[0, 255, 128, 129]
            );
            assert_eq!(dict.get(b"Name").unwrap().as_name().unwrap(), b"A\0B");
            assert_eq!(
                dict.get(b"Text").unwrap().as_str().unwrap(),
                &[254, 255, 5, 208, 5, 209]
            );
            assert_eq!(
                dict.get(b"Target").unwrap().as_reference().unwrap(),
                (900, 7)
            );
        }

        #[test]
        fn selected_object_codec_does_not_resolve_a_foreign_reference() {
            assert_eq!(
                parse_selected_object(b"900 7 R")
                    .unwrap()
                    .as_reference()
                    .unwrap(),
                (900, 7)
            );
        }
    }
}
