//! Per-user state locations. The Windows application owns its own directory
//! under `%LOCALAPPDATA%` and never reads or migrates other Kepos state.

use std::path::{Path, PathBuf};

/// Environment override used by tests and by an operator running a second,
/// isolated instance. It must point at a directory the application owns.
pub const STATE_DIR_ENV: &str = "KEPOS_WINDOWS_STATE_DIR";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatePaths {
    root: PathBuf,
}

impl StatePaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Resolve the state directory from the environment, defaulting to
    /// `%LOCALAPPDATA%\Kepos\windows`.
    pub fn from_environment() -> Result<Self, StatePathError> {
        if let Some(value) = std::env::var_os(STATE_DIR_ENV) {
            if value.is_empty() {
                return Err(StatePathError::EmptyOverride);
            }
            return Ok(Self::new(PathBuf::from(value)));
        }
        let base = std::env::var_os("LOCALAPPDATA").ok_or(StatePathError::NoLocalAppData)?;
        if base.is_empty() {
            return Err(StatePathError::NoLocalAppData);
        }
        Ok(Self::new(PathBuf::from(base).join("Kepos").join("windows")))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Seed-only identity. The file holds the seed and nothing else.
    pub fn identity(&self) -> PathBuf {
        self.root.join("peer.json")
    }

    /// Paired receiver configuration, stored as public routing data only.
    pub fn config(&self) -> PathBuf {
        self.root.join("config.json")
    }

    /// Marker for a pairing attempt whose outcome is unknown. It never contains
    /// the invitation.
    pub fn pending_pair(&self) -> PathBuf {
        self.root.join("pair-pending.json")
    }

    /// Runtime diagnostics, next to the state directory but never inside it:
    /// the identity directory must contain only `peer.json`.
    pub fn logs(&self) -> PathBuf {
        match self.root.parent() {
            Some(parent) => parent.join("logs"),
            None => self.root.join("logs"),
        }
    }

    /// Exclusive lock for the identity, held for the lifetime of the backend.
    pub fn lock(&self) -> PathBuf {
        self.root.join("runtime.lock")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatePathError {
    EmptyOverride,
    NoLocalAppData,
}

impl std::fmt::Display for StatePathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyOverride => write!(f, "{STATE_DIR_ENV} is empty"),
            Self::NoLocalAppData => write!(f, "LOCALAPPDATA is not set"),
        }
    }
}

impl std::error::Error for StatePathError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_every_owned_file_under_one_directory() {
        // Pure path composition: this test never touches the filesystem.
        let paths = StatePaths::new("synthetic-kepos-root");
        assert!(paths.identity().starts_with(paths.root()));
        assert!(paths.config().starts_with(paths.root()));
        assert!(paths.pending_pair().starts_with(paths.root()));
        assert!(paths.lock().starts_with(paths.root()));
        assert!(
            !paths.logs().starts_with(paths.root()),
            "logs must stay outside the identity directory"
        );
        assert_eq!(paths.identity().file_name().unwrap(), "peer.json");
    }
}
