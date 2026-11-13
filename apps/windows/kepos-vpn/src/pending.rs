//! Marker for a pairing attempt whose outcome is unknown.
//!
//! The marker is written *before* the invitation can reach the receiver and is
//! cleared only by a definite outcome or by an explicit acknowledgement. A
//! crash or power loss therefore leaves the warning in place after a restart,
//! which is what prevents an invitation from being replayed automatically.
//!
//! The marker never contains the invitation or any secret. Reading it
//! distinguishes "absent" from "present but unusable": an unreadable or
//! malformed marker must not be mistaken for no marker at all, because that
//! would silently reopen pairing.
//!
//! Durability is bounded by what Windows documents; see [`crate::durable`]. The
//! contents are flushed and the move uses `MOVEFILE_WRITE_THROUGH`, but a power
//! loss immediately afterwards can still lose the directory entry, and that loss
//! cannot be detected. A leftover `*.tmp` file is therefore treated as a marker
//! too, and clearing removes both.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingPair {
    /// Unix seconds when the attempt started, for the operator's reference.
    pub started_at: u64,
}

impl PendingPair {
    pub fn new(started_at: u64) -> Self {
        Self { started_at }
    }

    /// Read the marker.
    ///
    /// * `Ok(None)` — no marker and no leftover temporary file, so pairing is
    ///   allowed. A directory entry lost by a power loss is indistinguishable
    ///   from this case; see `crate::durable` for what is and is not guaranteed.
    /// * `Ok(Some(_))` — a previous attempt may have reached the receiver.
    /// * `Err(_)` — the marker exists but cannot be read; callers must treat
    ///   pairing as blocked rather than as allowed.
    pub fn read(path: &Path) -> Result<Option<Self>, PendingError> {
        // `symlink_metadata` does not follow links: a link (including a dangling
        // one) must read as unusable, never as "no marker", or pairing would
        // silently reopen.
        // A leftover temporary file is evidence of a write whose rename may not
        // have survived a power loss, so it counts as a marker as well.
        let temporary = temporary_path(path);
        for candidate in [path, temporary.as_path()] {
            match fs::symlink_metadata(candidate) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || !metadata.is_file() {
                        return Err(PendingError::NotAFile);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(PendingError::Io(error)),
            }
            let contents = fs::read_to_string(candidate).map_err(PendingError::Io)?;
            match serde_json::from_str::<Self>(&contents) {
                Ok(parsed) => return Ok(Some(parsed)),
                // The final name is authoritative for its contents; a damaged
                // temporary file still means "an attempt was in flight".
                Err(_) if candidate == path => return Err(PendingError::Invalid),
                Err(_) => return Err(PendingError::Invalid),
            }
        }
        Ok(None)
    }

    /// Record that an attempt is about to start.
    ///
    /// An existing marker is never replaced: it already blocks pairing, and
    /// overwriting it would lose the earlier attempt's timestamp. The new marker
    /// is written to a temporary file, flushed, then moved with
    /// `MOVEFILE_WRITE_THROUGH`. That is the documented write-through move, not a
    /// proven directory-entry barrier (see [`crate::durable`]); a failed write or
    /// move returns an error, and the caller must then send nothing.
    pub fn write(&self, path: &Path) -> Result<(), PendingError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(PendingError::Io)?;
        }
        // An existing marker means an unacknowledged attempt. A new attempt must
        // not record itself as if the earlier outcome were settled.
        match Self::read(path) {
            Ok(Some(_)) => return Err(PendingError::AlreadyPending),
            Ok(None) => {}
            Err(PendingError::Io(error)) => return Err(PendingError::Io(error)),
            Err(_) => return Err(PendingError::AlreadyPending),
        }
        let body = serde_json::to_string(self).map_err(|_| PendingError::Invalid)?;
        let temporary = temporary_path(path);
        {
            let mut file = fs::File::create(&temporary).map_err(PendingError::Io)?;
            file.write_all(body.as_bytes()).map_err(PendingError::Io)?;
            file.write_all(b"\n").map_err(PendingError::Io)?;
            // Flush the contents before the entry becomes visible.
            file.sync_all().map_err(PendingError::Io)?;
        }
        match crate::durable::rename_durable(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                Err(PendingError::Io(error))
            }
        }
    }

    /// Clear the marker after a definite outcome or an acknowledgement.
    ///
    /// A leftover temporary file counts as a marker when reading, so it is
    /// removed here as well; otherwise an acknowledgement would appear to work
    /// and the next read would report the same unknown outcome again. Both
    /// entries are removed through `symlink_metadata`, so a link is removed as a
    /// link and a directory is never recursed into. Any failure is reported, and
    /// the caller must keep the gate closed.
    ///
    /// Windows offers no write-through delete, so a power loss immediately after
    /// this call can leave a marker in place. That direction is safe: pairing
    /// stays blocked and the operator is asked to check the receiver again.
    pub fn clear(path: &Path) -> Result<(), PendingError> {
        for candidate in [path.to_path_buf(), temporary_path(path)] {
            let metadata = match fs::symlink_metadata(&candidate) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(PendingError::Io(error)),
            };
            // A directory is not something this module wrote, so it is left
            // alone and reported instead of being removed.
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                return Err(PendingError::NotAFile);
            }
            match fs::remove_file(&candidate) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(PendingError::Io(error)),
            }
        }
        Ok(())
    }
}

fn temporary_path(path: &Path) -> std::path::PathBuf {
    path.with_extension("json.tmp")
}

#[derive(Debug)]
pub enum PendingError {
    /// A marker already exists; the previous outcome must be acknowledged first.
    AlreadyPending,
    /// The marker exists but is not a regular file.
    NotAFile,
    /// The marker exists but is not valid.
    Invalid,
    Io(io::Error),
}

impl std::fmt::Display for PendingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyPending => {
                write!(f, "a previous pairing attempt is still unacknowledged")
            }
            Self::NotAFile => write!(f, "pending pairing marker is not a regular file"),
            Self::Invalid => write!(f, "pending pairing marker is not valid"),
            Self::Io(error) => write!(f, "pending pairing marker storage error: {error}"),
        }
    }
}

impl std::error::Error for PendingError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::TestDir;

    #[test]
    fn a_marker_survives_until_it_is_cleared() {
        let dir = TestDir::create("pending-lifecycle");
        let path = dir.path().join("pair-pending.json");
        assert_eq!(PendingPair::read(&path).unwrap(), None);
        PendingPair::new(1_700_000_000).write(&path).unwrap();
        assert_eq!(
            PendingPair::read(&path).unwrap(),
            Some(PendingPair::new(1_700_000_000))
        );
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("startedAt"));
        assert!(!contents.contains("invitation"));
        PendingPair::clear(&path).unwrap();
        assert_eq!(PendingPair::read(&path).unwrap(), None);
        PendingPair::clear(&path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_or_dangling_link_is_never_read_as_absent() {
        use std::os::unix::fs::symlink;
        let dir = TestDir::create("pending-symlink");
        let target = dir.path().join("real.json");
        PendingPair::new(1).write(&target).unwrap();
        let link = dir.path().join("pair-pending.json");
        symlink(&target, &link).unwrap();
        assert!(matches!(
            PendingPair::read(&link),
            Err(PendingError::NotAFile)
        ));

        let dangling = dir.path().join("dangling.json");
        symlink(dir.path().join("missing.json"), &dangling).unwrap();
        assert!(matches!(
            PendingPair::read(&dangling),
            Err(PendingError::NotAFile)
        ));
    }

    #[test]
    fn an_existing_marker_refuses_a_new_attempt() {
        let dir = TestDir::create("pending-preserve");
        let path = dir.path().join("pair-pending.json");
        PendingPair::new(1).write(&path).unwrap();
        assert!(matches!(
            PendingPair::new(2).write(&path),
            Err(PendingError::AlreadyPending)
        ));
        assert_eq!(PendingPair::read(&path).unwrap(), Some(PendingPair::new(1)));
    }

    #[test]
    fn clearing_also_removes_a_leftover_temporary_file() {
        let dir = TestDir::create("pending-clear-temporary");
        let path = dir.path().join("pair-pending.json");
        // Only the temporary file survived a power loss.
        fs::write(path.with_extension("json.tmp"), br#"{"startedAt":9}"#).unwrap();
        assert_eq!(PendingPair::read(&path).unwrap(), Some(PendingPair::new(9)));

        PendingPair::clear(&path).unwrap();
        assert_eq!(PendingPair::read(&path).unwrap(), None);
        // A second acknowledgement is harmless, and pairing is no longer blocked.
        PendingPair::clear(&path).unwrap();
        assert_eq!(PendingPair::read(&path).unwrap(), None);
    }

    #[test]
    fn a_clear_that_cannot_remove_the_temporary_file_reports_an_error() {
        let dir = TestDir::create("pending-clear-failure");
        let path = dir.path().join("pair-pending.json");
        PendingPair::new(1).write(&path).unwrap();
        // A directory where the temporary file would be cannot be removed by
        // this module; the failure must surface so the gate stays closed.
        fs::create_dir(path.with_extension("json.tmp")).unwrap();
        assert!(PendingPair::clear(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn clearing_a_link_removes_the_link_not_its_target() {
        use std::os::unix::fs::symlink;
        let dir = TestDir::create("pending-clear-link");
        let path = dir.path().join("pair-pending.json");
        let target = dir.path().join("target.json");
        fs::write(&target, br#"{"startedAt":3}"#).unwrap();
        symlink(&target, &path).unwrap();
        PendingPair::clear(&path).unwrap();
        assert!(!path.exists());
        assert!(target.exists(), "the link target must not be deleted");
    }

    #[test]
    fn a_leftover_temporary_file_still_blocks_pairing() {
        let dir = TestDir::create("pending-temporary");
        let path = dir.path().join("pair-pending.json");
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, br#"{"startedAt":7}"#).unwrap();
        assert_eq!(PendingPair::read(&path).unwrap(), Some(PendingPair::new(7)));
        assert!(matches!(
            PendingPair::new(8).write(&path),
            Err(PendingError::AlreadyPending)
        ));
    }

    #[test]
    fn a_write_that_cannot_be_durable_fails() {
        let dir = TestDir::create("pending-unwritable");
        // The parent is a regular file, so the marker cannot be created.
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, b"x").unwrap();
        let path = blocker.join("pair-pending.json");
        assert!(PendingPair::new(1).write(&path).is_err());
    }

    #[test]
    fn a_damaged_marker_is_an_error_and_never_reads_as_absent() {
        let dir = TestDir::create("pending-damaged");
        let path = dir.path().join("pair-pending.json");
        fs::write(&path, b"not json").unwrap();
        assert!(matches!(
            PendingPair::read(&path),
            Err(PendingError::Invalid)
        ));

        let directory = dir.path().join("pair-pending.json.d");
        fs::create_dir(&directory).unwrap();
        assert!(matches!(
            PendingPair::read(&directory),
            Err(PendingError::NotAFile)
        ));
    }
}
