//! Seed-only peer identity, mirroring the other Kepos hosts.
//!
//! The file contains one seed and nothing else. It is created only when the
//! device is unpaired and no other runtime owns it, and an existing file is
//! never replaced: a damaged identity is reported instead of regenerated.
//!
//! The seed comes from [`crate::random::SeedSource`]. If that source fails, the
//! error is returned and **nothing is written**, so a weak or partial identity
//! can never reach disk.
//!
//! The public key is not derived here — the worklet derives it from the seed and
//! reports it back, so this crate needs no crypto dependency.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::random::{seed_hex, SeedError, SeedSource};

const HEX32_LENGTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    seed: String,
}

impl Identity {
    /// Validate a seed read from disk or supplied by a test.
    pub fn from_seed(seed: impl Into<String>) -> Result<Self, IdentityError> {
        let seed = seed.into();
        validate_hex32(&seed).map_err(|_| IdentityError::InvalidSeed)?;
        Ok(Self { seed })
    }

    pub fn seed(&self) -> &str {
        &self.seed
    }

    pub fn serialize(&self) -> String {
        format!("{{\n  \"seed\": \"{}\"\n}}\n", self.seed)
    }
}

/// Public key reported by the worklet. Kept separate from the identity so the
/// tray can show it without this crate holding key material.
pub fn validate_public_key(value: &str) -> Result<(), IdentityError> {
    validate_hex32(value).map_err(|_| IdentityError::InvalidPublicKey)
}

fn validate_hex32(value: &str) -> Result<(), ()> {
    if value.len() != HEX32_LENGTH {
        return Err(());
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(());
    }
    Ok(())
}

/// Load the identity, creating one from `source` when the file is absent.
///
/// Returns `(identity, created)`. A present but unusable file is always an
/// error, and a failing random source leaves no file behind.
pub fn load_or_create(
    path: &Path,
    source: &dyn SeedSource,
) -> Result<(Identity, bool), IdentityError> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok((parse(&contents)?, false)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // Generate before touching the filesystem.
            let seed = seed_hex(source).map_err(IdentityError::NoEntropy)?;
            let identity = Identity::from_seed(seed)?;
            write_new(path, &identity)?;
            Ok((identity, true))
        }
        Err(error) => Err(IdentityError::Io(error)),
    }
}

fn parse(contents: &str) -> Result<Identity, IdentityError> {
    let parsed: Identity =
        serde_json::from_str(contents).map_err(|_| IdentityError::InvalidFile)?;
    Identity::from_seed(parsed.seed)
}

/// Create the file exclusively so a concurrent creator cannot be overwritten.
fn write_new(path: &Path, identity: &Identity) -> Result<(), IdentityError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(IdentityError::Io)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(IdentityError::Io)?;
    file.write_all(identity.serialize().as_bytes())
        .map_err(IdentityError::Io)?;
    file.sync_all().map_err(IdentityError::Io)?;
    Ok(())
}

/// Exclusive ownership of the identity for the lifetime of the backend.
///
/// On Windows the lock file is opened without sharing, so the operating system
/// releases it when the process exits — including after a crash — and no stale
/// lock file can block a later run. On other platforms (tests only) the file is
/// created exclusively and removed on drop.
pub struct IdentityLock {
    /// Only the non-Windows test path removes the file on drop; on Windows the
    /// operating system releases the share-mode lock with the handle.
    #[cfg_attr(windows, allow(dead_code))]
    path: PathBuf,
    file: Option<File>,
}

impl IdentityLock {
    pub fn acquire(path: &Path) -> Result<Self, IdentityError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(IdentityError::Io)?;
        }
        match open_exclusive(path) {
            Ok(file) => Ok(Self {
                path: path.to_path_buf(),
                file: Some(file),
            }),
            Err(error) if is_in_use(&error) => Err(IdentityError::InUse),
            Err(error) => Err(IdentityError::Io(error)),
        }
    }
}

impl Drop for IdentityLock {
    fn drop(&mut self) {
        self.file.take();
        #[cfg(not(windows))]
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(windows)]
fn open_exclusive(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    // share_mode(0) denies every other open until this handle is closed.
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(path)
}

#[cfg(windows)]
fn is_in_use(error: &io::Error) -> bool {
    // ERROR_SHARING_VIOLATION
    error.raw_os_error() == Some(32)
}

#[cfg(not(windows))]
fn open_exclusive(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(not(windows))]
fn is_in_use(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::AlreadyExists
}

#[derive(Debug)]
pub enum IdentityError {
    /// The seed is not 32 bytes of lowercase hex.
    InvalidSeed,
    /// The public key is not 32 bytes of lowercase hex.
    InvalidPublicKey,
    /// The identity file is not a valid identity.
    InvalidFile,
    /// The system random source failed; no identity was created.
    NoEntropy(SeedError),
    /// Another runtime already owns the identity.
    InUse,
    Io(io::Error),
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSeed => write!(f, "peer identity seed must be 32 bytes of lowercase hex"),
            Self::InvalidPublicKey => {
                write!(f, "peer public key must be 32 bytes of lowercase hex")
            }
            Self::InvalidFile => write!(f, "peer identity file is not valid"),
            Self::NoEntropy(error) => write!(f, "cannot generate a peer identity: {error}"),
            Self::InUse => write!(f, "peer identity is already in use"),
            Self::Io(error) => write!(f, "peer identity storage error: {error}"),
        }
    }
}

impl std::error::Error for IdentityError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::random::SeedSource;
    use crate::testdir::TestDir;

    const SEED: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    struct Fixed;

    impl SeedSource for Fixed {
        fn seed(&self) -> Result<[u8; 32], SeedError> {
            let mut bytes = [0u8; 32];
            bytes[0] = 0x01;
            Ok(bytes)
        }
    }

    struct Failing;

    impl SeedSource for Failing {
        fn seed(&self) -> Result<[u8; 32], SeedError> {
            Err(SeedError::Unavailable(-1))
        }
    }

    #[test]
    fn accepts_a_seed_and_rejects_everything_else() {
        assert!(Identity::from_seed(SEED).is_ok());
        assert!(Identity::from_seed(SEED.to_uppercase()).is_err());
        assert!(Identity::from_seed(&SEED[..62]).is_err());
        assert!(Identity::from_seed("z".repeat(64)).is_err());
    }

    #[test]
    fn creates_once_and_reuses_the_same_identity() {
        let dir = TestDir::create("identity-create");
        let path = dir.path().join("peer.json");
        let (created, is_new) = load_or_create(&path, &Fixed).unwrap();
        assert!(is_new);
        assert_eq!(created.seed().len(), 64);
        let first = created.seed().to_string();
        let (reused, is_new) = load_or_create(&path, &Failing).unwrap();
        assert!(!is_new);
        assert_eq!(reused.seed(), first);
    }

    #[test]
    fn refuses_a_damaged_identity_instead_of_replacing_it() {
        let dir = TestDir::create("identity-damaged");
        let path = dir.path().join("peer.json");
        fs::write(&path, b"{\"seed\":\"not-a-seed\"}").unwrap();
        assert!(matches!(
            load_or_create(&path, &Fixed),
            Err(IdentityError::InvalidSeed)
        ));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"seed\":\"not-a-seed\"}"
        );
    }

    #[test]
    fn a_failing_random_source_writes_nothing() {
        let dir = TestDir::create("identity-no-entropy");
        let path = dir.path().join("peer.json");
        assert!(matches!(
            load_or_create(&path, &Failing),
            Err(IdentityError::NoEntropy(_))
        ));
        assert!(!path.exists(), "no identity may be written without entropy");
    }

    #[test]
    fn the_identity_file_carries_only_the_seed() {
        let identity = Identity::from_seed(SEED).unwrap();
        let serialized = identity.serialize();
        assert_eq!(serialized.matches("seed").count(), 1);
        assert!(!serialized.contains("publicKey"));
    }

    #[test]
    fn a_second_lock_is_refused_and_released_on_drop() {
        let dir = TestDir::create("identity-lock");
        let path = dir.path().join("runtime.lock");
        let lock = IdentityLock::acquire(&path).unwrap();
        assert!(matches!(
            IdentityLock::acquire(&path),
            Err(IdentityError::InUse)
        ));
        drop(lock);
        assert!(IdentityLock::acquire(&path).is_ok());
    }
}
