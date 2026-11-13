//! Paired receiver configuration.
//!
//! Only public routing data is stored: this device's overlay address and the
//! receiver's key and address. The canonical TOML form is generated for the
//! worklet `start` message, exactly as the other Kepos hosts do, so the shared
//! engine keeps one configuration format.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedConfig {
    /// This device's overlay address.
    pub address: String,
    /// The receiver's overlay address.
    pub receiver_address: String,
    /// The receiver's public key, 32 bytes as lowercase hex.
    pub receiver_key: String,
}

impl PairedConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if !is_overlay_address(&self.address) {
            return Err(ConfigError::InvalidAddress);
        }
        if !is_overlay_address(&self.receiver_address) {
            return Err(ConfigError::InvalidAddress);
        }
        if self.address == self.receiver_address {
            return Err(ConfigError::SameAddress);
        }
        if !is_public_key(&self.receiver_key) {
            return Err(ConfigError::InvalidKey);
        }
        Ok(())
    }

    /// The `config` field of the worklet `start` message.
    pub fn tunnel_toml(&self) -> Result<String, ConfigError> {
        self.validate()?;
        Ok(format!(
            "peers = [{{ label = \"receiver\", public_key = \"{key}\", connection = \"dial\" }}]\n\
             [vpn]\n\
             address = \"{address}\"\n\
             peers = [{{ peer = \"receiver\", address = \"{receiver}\", allow_tcp = [] }}]\n",
            key = self.receiver_key,
            address = self.address,
            receiver = self.receiver_address,
        ))
    }

    pub fn load(path: &Path) -> Result<Option<Self>, ConfigError> {
        match fs::read_to_string(path) {
            Ok(contents) => {
                let parsed: Self =
                    serde_json::from_str(&contents).map_err(|_| ConfigError::InvalidFile)?;
                parsed.validate()?;
                Ok(Some(parsed))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(ConfigError::Io(error)),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        self.validate()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(ConfigError::Io)?;
        }
        let body = serde_json::to_string_pretty(self).map_err(|_| ConfigError::InvalidFile)?;
        // Write beside the destination, flush it, then replace the entry with the
        // documented write-through move so a reader never sees a partial file.
        let temporary = path.with_extension("json.tmp");
        {
            let mut file = fs::File::create(&temporary).map_err(ConfigError::Io)?;
            file.write_all(body.as_bytes()).map_err(ConfigError::Io)?;
            file.write_all(b"\n").map_err(ConfigError::Io)?;
            crate::durable::flush_file(&mut file).map_err(ConfigError::Io)?;
        }
        match crate::durable::rename_durable(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                Err(ConfigError::Io(error))
            }
        }
    }
}

/// Overlay addresses are unicast IPv4 addresses in a private or benchmarking
/// range, matching what the receiver allocates.
fn is_overlay_address(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut octets = [0u8; 4];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        match part.parse::<u8>() {
            Ok(value) => octets[index] = value,
            Err(_) => return false,
        }
        // Reject leading zeros so one address has one spelling.
        if part.len() > 1 && part.starts_with('0') {
            return false;
        }
    }
    let first = octets[0];
    if first == 0 || first == 127 || first >= 224 {
        return false;
    }
    if first == 169 && octets[1] == 254 {
        return false;
    }
    true
}

fn is_public_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug)]
pub enum ConfigError {
    InvalidAddress,
    SameAddress,
    InvalidKey,
    InvalidFile,
    Io(io::Error),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidAddress => write!(f, "overlay address is not a usable IPv4 address"),
            Self::SameAddress => write!(f, "the local and receiver addresses must differ"),
            Self::InvalidKey => write!(f, "receiver public key must be 32 bytes of lowercase hex"),
            Self::InvalidFile => write!(f, "paired configuration is not valid"),
            Self::Io(error) => write!(f, "paired configuration storage error: {error}"),
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::TestDir;

    fn config() -> PairedConfig {
        PairedConfig {
            address: "198.18.20.2".into(),
            receiver_address: "198.18.20.1".into(),
            receiver_key: "ab".repeat(32),
        }
    }

    #[test]
    fn round_trips_through_the_state_file() {
        let dir = TestDir::create("config-round-trip");
        let path = dir.path().join("config.json");
        let expected = config();
        expected.save(&path).unwrap();
        assert_eq!(PairedConfig::load(&path).unwrap(), Some(expected));
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let dir = TestDir::create("config-missing");
        assert_eq!(
            PairedConfig::load(&dir.path().join("config.json")).unwrap(),
            None
        );
    }

    #[test]
    fn rejects_an_unusable_pairing_result() {
        let mut broken = config();
        broken.receiver_key = broken.receiver_key.to_uppercase();
        assert!(broken.validate().is_err());
        let mut same = config();
        same.address = same.receiver_address.clone();
        assert!(same.validate().is_err());
        let mut loopback = config();
        loopback.address = "127.0.0.1".into();
        assert!(loopback.validate().is_err());
        let mut zero_padded = config();
        zero_padded.address = "198.18.020.2".into();
        assert!(zero_padded.validate().is_err());
    }

    #[test]
    fn the_worklet_config_matches_the_shared_format() {
        let toml = config().tunnel_toml().unwrap();
        assert!(toml.starts_with("peers = [{ label = \"receiver\""));
        assert!(toml.contains("connection = \"dial\""));
        assert!(toml.contains("allow_tcp = []"));
        assert!(toml.contains("address = \"198.18.20.2\""));
    }
}
