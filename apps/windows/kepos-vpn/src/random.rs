//! Identity seed generation.
//!
//! A seed is the only secret this application creates. It must come from the
//! operating system's cryptographic random source: a weak seed would silently
//! produce a guessable device identity. If the source fails, the caller must
//! report the failure and must not write an identity at all — there is no
//! fallback generator.
//!
//! Tests inject their own `SeedSource`; nothing here reads an existing identity.

/// A source of 32 random bytes for a peer identity seed.
pub trait SeedSource: Send + Sync {
    fn seed(&self) -> Result<[u8; 32], SeedError>;
}

/// The operating system's cryptographic random source.
pub struct OsRandom;

#[cfg(windows)]
impl SeedSource for OsRandom {
    fn seed(&self) -> Result<[u8; 32], SeedError> {
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        let mut buffer = [0u8; 32];
        // SAFETY: the algorithm handle is NULL, which selects the system
        // preferred RNG, and the buffer is valid for `buffer.len()` bytes.
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(SeedError::Unavailable(status));
        }
        Ok(buffer)
    }
}

#[cfg(not(windows))]
impl SeedSource for OsRandom {
    fn seed(&self) -> Result<[u8; 32], SeedError> {
        use std::io::Read;
        // Only reached on a non-Windows test host; Windows uses BCrypt above.
        let mut buffer = [0u8; 32];
        let mut file = std::fs::File::open("/dev/urandom").map_err(SeedError::Io)?;
        file.read_exact(&mut buffer).map_err(SeedError::Io)?;
        Ok(buffer)
    }
}

/// Lowercase hex, the encoding every Kepos host stores.
pub fn seed_hex(source: &dyn SeedSource) -> Result<String, SeedError> {
    let bytes = source.seed()?;
    let mut hex = String::with_capacity(64);
    for byte in bytes {
        hex.push(char::from_digit((byte >> 4) as u32, 16).unwrap_or('0'));
        hex.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap_or('0'));
    }
    if hex.len() != 64 {
        return Err(SeedError::InvalidLength(hex.len()));
    }
    Ok(hex)
}

#[derive(Debug)]
pub enum SeedError {
    /// The system random source returned an error status.
    Unavailable(i32),
    /// Reading the system random source failed.
    Io(std::io::Error),
    /// The produced seed was not 32 bytes.
    InvalidLength(usize),
}

impl std::fmt::Display for SeedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(status) => {
                write!(f, "the system random source failed (status {status})")
            }
            Self::Io(error) => write!(f, "the system random source is unavailable: {error}"),
            Self::InvalidLength(length) => write!(f, "the random source produced {length} bytes"),
        }
    }
}

impl std::error::Error for SeedError {}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed([u8; 32]);

    impl SeedSource for Fixed {
        fn seed(&self) -> Result<[u8; 32], SeedError> {
            Ok(self.0)
        }
    }

    struct Failing;

    impl SeedSource for Failing {
        fn seed(&self) -> Result<[u8; 32], SeedError> {
            Err(SeedError::Unavailable(-1))
        }
    }

    #[test]
    fn encodes_a_seed_as_lowercase_hex() {
        let mut bytes = [0u8; 32];
        bytes[0] = 0xab;
        bytes[31] = 0x0f;
        let hex = seed_hex(&Fixed(bytes)).unwrap();
        assert_eq!(hex.len(), 64);
        assert!(hex.starts_with("ab"));
        assert!(hex.ends_with("0f"));
        assert!(hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }

    #[test]
    fn a_failing_source_is_an_error_and_never_a_seed() {
        assert!(seed_hex(&Failing).is_err());
    }
}
