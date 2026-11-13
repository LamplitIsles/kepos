//! Kepos Windows peer VPN backend.
//!
//! The tray owns the interface; this crate owns identity state, pairing,
//! connection supervision and the overlay device. It exposes a snapshot the
//! tray renders and a command set it issues, and nothing else: no seed, no
//! invitation and no lock content leaves this crate.
//!
//! Layout:
//! * `framing` — the host/worklet frame codec.
//! * `session` — the pairing and connection state machine, free of I/O.
//! * `identity`, `config`, `pending`, `paths` — the files this application owns.
//! * `worklet` — the Bare Kit C API binding (Windows).
//! * `device` — the Wintun adapter and peer routes (Windows).
//! * `runtime` — the threads that connect the three (Windows).

pub mod config;
pub mod dispatch;
pub mod durable;
pub mod eventlog;
pub mod framing;
pub mod harness;
pub mod identity;
pub mod outbox;
pub mod overlay;
pub mod paths;
pub mod pending;
pub mod random;
pub mod session;
pub mod state;

#[cfg(test)]
pub mod testdir;

#[cfg(windows)]
pub mod device;
#[cfg(windows)]
pub mod runtime;
#[cfg(windows)]
pub mod worklet;

pub use config::PairedConfig;
pub use identity::Identity;
pub use paths::StatePaths;
pub use session::{Action, Command, Event, Session};
pub use state::{
    ErrorCode, ErrorState, PeerState, Phase, ReceiverState, RejectionReason, Snapshot,
};

#[cfg(windows)]
pub use runtime::{Backend, BackendError, BackendOptions, CommandError};
