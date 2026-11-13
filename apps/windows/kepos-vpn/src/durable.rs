//! Durable file replacement, with the documented limits spelled out.
//!
//! Windows contract (Microsoft Learn, `MoveFileExA`): `MOVEFILE_WRITE_THROUGH`
//! means "the function does not return until the file is actually moved on the
//! disk", and explicitly "guarantees that a move performed as a copy and delete
//! operation is flushed to disk before the function returns". That is the
//! documented promise; it is **not** a documented fsync-style barrier for the
//! parent directory entry on a same-volume rename, and no user-mode API is
//! documented to flush a directory entry.
//!
//! What can therefore be claimed:
//! * The new contents are flushed before the rename (the file is fsynced).
//! * The rename is the documented move operation with `MOVEFILE_WRITE_THROUGH`.
//! * NTFS journals metadata, so a rename is crash-consistent rather than
//!   partially applied.
//!
//! What cannot be claimed: that a power loss immediately after this call can
//! never lose the new directory entry, and the loss cannot be detected. A lost
//! marker therefore reads as "no marker" (`PendingPair::read` returns `None`),
//! which would reopen pairing. Two things narrow that window but do not close
//! it: the marker's contents are flushed before the rename, and a leftover
//! `*.tmp` file counts as a marker as well, so both entries would have to be
//! lost. No claim is made that every lost directory entry is detected.

use std::fs::File;
use std::io;
use std::path::Path;

/// Flush a file's contents to the device before its entry becomes visible.
pub fn flush_file(file: &mut File) -> io::Result<()> {
    file.sync_all()
}

/// Replace `to` with `from`, using the documented write-through move on Windows.
pub fn rename_durable(from: &Path, to: &Path) -> io::Result<()> {
    imp::rename_durable(from, to)
}

#[cfg(windows)]
mod imp {
    use std::io;
    use std::path::Path;

    pub fn rename_durable(from: &Path, to: &Path) -> io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let encode = |path: &Path| -> Vec<u16> {
            path.as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        };
        let from = encode(from);
        let to = encode(to);
        // SAFETY: both pointers are NUL-terminated UTF-16 paths that outlive the
        // call. `MOVEFILE_WRITE_THROUGH` is the documented write-through move.
        let status = unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if status == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use std::io;
    use std::path::Path;

    /// The non-Windows path exists for tests; it makes no durability claim.
    pub fn rename_durable(from: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(from, to)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::TestDir;

    #[test]
    fn replaces_an_existing_file_with_new_contents() {
        let dir = TestDir::create("durable-rename");
        let source = dir.path().join("source.tmp");
        let target = dir.path().join("target.json");
        std::fs::write(&source, b"old").unwrap();
        std::fs::write(&target, b"old").unwrap();
        std::fs::write(&source, b"new").unwrap();
        rename_durable(&source, &target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert!(!source.exists());
    }
}
