//! Thin binding to the official Bare Kit C API (3.x) on Windows.
//!
//! Only what the backend needs is bound: create a worklet, create its IPC, start
//! it on a bundle file, read and write IPC bytes, and terminate it. The
//! declarations follow `bare-kit.h`; the library is loaded from the application
//! directory, and the host executable must re-export the bare/js/uv symbols
//! (`/DEF:bare-kit.def`) so that prebuilt addons can resolve them.
//!
//! This module is Windows-only. It is deliberately small: the protocol lives in
//! `session.rs`, which has no platform dependency.

#![cfg(windows)]

use std::ffi::{c_char, c_int, c_void, CString};
use std::io;
use std::ptr;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const IPC_READABLE: c_int = 0x1;
pub const IPC_WRITABLE: c_int = 0x2;
pub const IPC_WOULD_BLOCK: c_int = -1;
pub const IPC_ERROR: c_int = -2;

/// Read buffer size the API documents for one `bare_ipc_read` call.
pub const IPC_READ_BUFFER_SIZE: usize = 64 * 1024;

#[repr(C)]
pub struct WorkletOptions {
    pub version: c_int,
    pub memory_limit: usize,
    pub platform_reserved: [*mut c_void; 8],
}

impl Default for WorkletOptions {
    fn default() -> Self {
        Self {
            version: 0,
            memory_limit: 0,
            platform_reserved: [ptr::null_mut(); 8],
        }
    }
}

pub enum Worklet {}
pub enum Ipc {}
pub enum IpcPoll {}

pub type SuspendCallback = extern "C" fn(linger: c_int, data: *mut c_void);
pub type WakeupCallback = extern "C" fn(deadline: c_int, data: *mut c_void);
pub type IdleCallback = extern "C" fn(data: *mut c_void);
pub type ResumeCallback = extern "C" fn(data: *mut c_void);
pub type ExitCallback = extern "C" fn(exit_code: c_int, data: *mut c_void);
pub type PollCallback = extern "C" fn(poll: *mut IpcPoll, events: c_int);

#[link(name = "bare-kit", kind = "dylib")]
extern "C" {
    pub fn bare_worklet_create(options: *const WorkletOptions, result: *mut *mut Worklet) -> c_int;
    pub fn bare_worklet_destroy(worklet: *mut Worklet);
    pub fn bare_worklet_on_exit(
        worklet: *mut Worklet,
        cb: ExitCallback,
        data: *mut c_void,
    ) -> c_int;
    pub fn bare_worklet_set_data(worklet: *mut Worklet, data: *mut c_void);
    pub fn bare_worklet_get_data(worklet: *mut Worklet) -> *mut c_void;
    pub fn bare_worklet_start(
        worklet: *mut Worklet,
        filename: *const c_char,
        source: *const c_void,
        len: usize,
        argc: c_int,
        argv: *const *const c_char,
    ) -> c_int;
    pub fn bare_worklet_terminate(worklet: *mut Worklet) -> c_int;
    pub fn bare_worklet_teardown() -> c_int;

    pub fn bare_ipc_create(worklet: *mut Worklet, result: *mut *mut Ipc) -> c_int;
    pub fn bare_ipc_close(ipc: *mut Ipc);
    pub fn bare_ipc_end(ipc: *mut Ipc);
    pub fn bare_ipc_destroy(ipc: *mut Ipc);
    pub fn bare_ipc_read(ipc: *mut Ipc, data: *mut c_void, len: usize) -> c_int;
    pub fn bare_ipc_write(ipc: *mut Ipc, data: *const c_void, len: usize) -> c_int;

    pub fn bare_ipc_poll_create(ipc: *mut Ipc, result: *mut *mut IpcPoll) -> c_int;
    pub fn bare_ipc_poll_destroy(poll: *mut IpcPoll);
    pub fn bare_ipc_poll_set_data(poll: *mut IpcPoll, data: *mut c_void);
    pub fn bare_ipc_poll_start(poll: *mut IpcPoll, events: c_int, cb: PollCallback) -> c_int;
    pub fn bare_ipc_poll_stop(poll: *mut IpcPoll) -> c_int;
}

/// Signals the worklet's exit callback to the thread that is waiting for it.
struct ExitSignal {
    done: Mutex<bool>,
    ready: Condvar,
    /// `None` until the callback runs; `Some(code)` afterwards.
    code: std::sync::atomic::AtomicI32,
    code_known: std::sync::atomic::AtomicBool,
}

impl ExitSignal {
    fn new() -> Self {
        Self {
            done: Mutex::new(false),
            ready: Condvar::new(),
            code: std::sync::atomic::AtomicI32::new(0),
            code_known: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn record(&self, exit_code: c_int) {
        self.code
            .store(exit_code, std::sync::atomic::Ordering::Release);
        self.code_known
            .store(true, std::sync::atomic::Ordering::Release);
        if let Ok(mut done) = self.done.lock() {
            *done = true;
        }
        self.ready.notify_all();
    }

    /// Wait until the worklet has torn down, or the timeout expires.
    fn wait(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut done = match self.done.lock() {
            Ok(done) => done,
            Err(_) => return false,
        };
        while !*done {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            done = match self.ready.wait_timeout(done, remaining) {
                Ok((done, _)) => done,
                Err(_) => return false,
            };
        }
        true
    }
}

extern "C" fn on_exit(exit_code: c_int, data: *mut c_void) {
    if data.is_null() {
        return;
    }
    // SAFETY: `data` is the `Arc<ExitSignal>` created by `Arc::into_raw` for
    // this callback. `bare_worklet_on_exit` documents that the callback runs
    // exactly once, possibly after `bare_worklet_destroy`, so it consumes that
    // reference here instead of the host freeing it earlier.
    let signal = unsafe { Arc::from_raw(data as *const ExitSignal) };
    signal.record(exit_code);
}

/// A started worklet together with the host end of its IPC.
///
/// The IPC is created before the worklet starts, matching the order the other
/// Kepos hosts use: the worklet touches `Bare.IPC` while its modules load.
pub struct HostedWorklet {
    worklet: *mut Worklet,
    ipc: *mut Ipc,
    exit: Arc<ExitSignal>,
    exited: bool,
}

impl HostedWorklet {
    /// The exit code if the callback has run, without claiming the process is
    /// alive when it has not been observed.
    pub fn exit_code(&self) -> Option<i32> {
        if self
            .exit
            .code_known
            .load(std::sync::atomic::Ordering::Acquire)
        {
            Some(self.exit.code.load(std::sync::atomic::Ordering::Acquire))
        } else {
            None
        }
    }

    /// Create the worklet and its IPC. `bundle` is the absolute path of the
    /// packed worklet.
    ///
    /// A start failure reports whether the worklet confirmed its exit. Callers
    /// must treat an unconfirmed exit as "the runtime may still be alive": the
    /// identity stays locked and no new attempt may start.
    pub fn create(bundle: &std::path::Path) -> Result<Self, CreateError> {
        let options = WorkletOptions::default();
        let mut worklet: *mut Worklet = ptr::null_mut();
        // SAFETY: the options pointer is valid for the duration of the call and
        // the result pointer is a valid out-parameter.
        let status = unsafe { bare_worklet_create(&options, &mut worklet) };
        if status != 0 || worklet.is_null() {
            return Err(CreateError::Io(io::Error::other(format!(
                "bare_worklet_create failed ({status})"
            ))));
        }
        let mut ipc: *mut Ipc = ptr::null_mut();
        let status = unsafe { bare_ipc_create(worklet, &mut ipc) };
        if status != 0 || ipc.is_null() {
            unsafe { bare_worklet_destroy(worklet) };
            return Err(CreateError::Io(io::Error::other(format!(
                "bare_ipc_create failed ({status})"
            ))));
        }
        let exit = Arc::new(ExitSignal::new());
        // The callback must be registered before the worklet starts so an early
        // exit is still observed.
        let exit_raw = Arc::into_raw(Arc::clone(&exit)) as *mut c_void;
        let status = unsafe { bare_worklet_on_exit(worklet, on_exit, exit_raw) };
        if status != 0 {
            unsafe {
                bare_ipc_destroy(ipc);
                bare_worklet_destroy(worklet);
            }
            drop(unsafe { Arc::from_raw(exit_raw as *const ExitSignal) });
            return Err(CreateError::Io(io::Error::other(format!(
                "bare_worklet_on_exit failed ({status})"
            ))));
        }
        let hosted = Self {
            worklet,
            ipc,
            exit,
            exited: false,
        };
        let name = bundle.to_string_lossy().to_string();
        let filename = CString::new(name)
            .map_err(|_| CreateError::Io(io::Error::other("bundle path contains a NUL byte")))?;
        // SAFETY: the worklet is alive, the name is NUL-terminated and the
        // arguments are only read during the call.
        let status = unsafe {
            bare_worklet_start(
                hosted.worklet,
                filename.as_ptr(),
                ptr::null(),
                0,
                0,
                ptr::null(),
            )
        };
        if status != 0 {
            let mut hosted = hosted;
            // The exit callback is registered, so it still owns its reference
            // and may run while the worklet tears down. Give it a moment, then
            // report the failure; a callback that never runs leaves one small
            // signal allocated rather than freeing it under the runtime.
            hosted.destroy_handles();
            let exit_confirmed = hosted.exit.wait(START_FAILURE_WAIT);
            return Err(CreateError::StartFailed { exit_confirmed });
        }
        Ok(hosted)
    }

    pub fn ipc(&self) -> *mut Ipc {
        self.ipc
    }

    /// Non-blocking read. `Ok(0)` is end of stream, `None` means no data is
    /// available right now.
    pub fn read(&self, buffer: &mut [u8]) -> io::Result<Option<usize>> {
        if buffer.is_empty() {
            return Err(io::Error::other("empty IPC read"));
        }
        // SAFETY: the buffer is valid for `buffer.len()` bytes.
        let read = unsafe { bare_ipc_read(self.ipc, buffer.as_mut_ptr().cast(), buffer.len()) };
        match read {
            IPC_WOULD_BLOCK => Ok(None),
            IPC_ERROR => Err(io::Error::other("IPC read failed")),
            value if value >= 0 => Ok(Some(value as usize)),
            value => Err(io::Error::other(format!("IPC read returned {value}"))),
        }
    }

    /// Non-blocking write. Returns how many bytes were accepted.
    pub fn write(&self, buffer: &[u8]) -> io::Result<Option<usize>> {
        if buffer.is_empty() {
            return Ok(Some(0));
        }
        // SAFETY: the buffer is valid for `buffer.len()` bytes.
        let written = unsafe { bare_ipc_write(self.ipc, buffer.as_ptr().cast(), buffer.len()) };
        match written {
            IPC_WOULD_BLOCK => Ok(None),
            IPC_ERROR => Err(io::Error::other("IPC write failed")),
            value if value >= 0 => Ok(Some(value as usize)),
            value => Err(io::Error::other(format!("IPC write returned {value}"))),
        }
    }

    /// Half-close: the worklet reads end of stream once drained.
    pub fn end(&self) {
        unsafe { bare_ipc_end(self.ipc) };
    }

    pub fn terminate(&self) {
        unsafe { bare_worklet_terminate(self.worklet) };
    }

    /// Release the native handles once. Safe to call twice.
    fn destroy_handles(&mut self) {
        // SAFETY: both handles are owned by this value and released once.
        unsafe {
            if !self.ipc.is_null() {
                bare_ipc_destroy(self.ipc);
                self.ipc = ptr::null_mut();
            }
            if !self.worklet.is_null() {
                bare_worklet_destroy(self.worklet);
                self.worklet = ptr::null_mut();
            }
        }
    }

    /// Terminate the worklet and wait until it has torn down.
    ///
    /// `bare_worklet_terminate` is asynchronous: the worklet releases its
    /// threads and the runtime afterwards. The identity lock must not be
    /// released before this returns `Ok`, otherwise a second instance could
    /// start while the old runtime is still alive.
    pub fn terminate_and_wait(&mut self, timeout: Duration) -> Result<(), WaitError> {
        if self.exited {
            return Ok(());
        }
        self.terminate();
        if self.exit.wait(timeout) {
            self.exited = true;
            Ok(())
        } else {
            Err(WaitError::Timeout)
        }
    }
}

impl Drop for HostedWorklet {
    fn drop(&mut self) {
        // The exit signal's reference belongs to the callback, which may run
        // after this point; only the native handles are released here.
        self.destroy_handles();
    }
}

/// Why a worklet could not be created.
#[derive(Debug)]
pub enum CreateError {
    /// The runtime could not be created at all.
    Io(io::Error),
    /// The bundle did not start. `exit_confirmed` says whether the worklet
    /// reported its exit after being destroyed; when it did not, the runtime may
    /// still be alive and the identity must stay locked.
    StartFailed { exit_confirmed: bool },
}

impl std::fmt::Display for CreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "cannot create the VPN engine: {error}"),
            Self::StartFailed { exit_confirmed } => write!(
                f,
                "the VPN engine failed to start (exit {})",
                if *exit_confirmed {
                    "confirmed"
                } else {
                    "unconfirmed"
                }
            ),
        }
    }
}

impl std::error::Error for CreateError {}

/// How long a failed start may take to report its exit before we give up.
const START_FAILURE_WAIT: Duration = Duration::from_secs(2);

/// The worklet did not report its exit before the deadline.
#[derive(Debug)]
pub enum WaitError {
    Timeout,
}

impl std::fmt::Display for WaitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout => write!(f, "the VPN engine did not stop in time"),
        }
    }
}

impl std::error::Error for WaitError {}
