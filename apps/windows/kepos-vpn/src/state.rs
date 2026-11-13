//! Public state the tray renders. Every value here is safe to display and log;
//! no seed, invitation or lock content appears in it.

use serde::Serialize;

/// What the backend is doing, independent of whether the receiver is reachable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// No pairing or connection attempt is running.
    Idle,
    /// An invitation was submitted and the outcome is not yet known.
    Pairing,
    /// The overlay device and engine are starting.
    Connecting,
    /// The engine is running; individual peers report their own state.
    Connected,
    /// The attempt failed; the message is in `error`.
    Failed,
}

/// Stable error codes. The tray owns the user-facing wording for each one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// The identity or configuration directory is unusable.
    StateInvalid,
    /// Another runtime already owns the identity.
    IdentityInUse,
    /// No paired configuration exists yet.
    NotPaired,
    /// The invitation could not be parsed.
    InvitationInvalid,
    /// The pairing outcome is unknown; inspect the receiver before retrying.
    PairingUnknown,
    /// A previous unknown pairing outcome has not been acknowledged.
    PairingUnacknowledged,
    /// The receiver could not be reached at all.
    PairUnavailable,
    /// The receiver rejected the invitation.
    PairRejected,
    /// Administrator rights are required for the overlay device.
    AdminRequired,
    /// The overlay device or its routes could not be created.
    DeviceFailed,
    /// The VPN engine failed to start or stopped unexpectedly.
    EngineFailed,
}

/// Why the receiver rejected an invitation, when it said so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RejectionReason {
    Capacity,
    Pool,
    Route,
    Excluded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorState {
    pub code: ErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<RejectionReason>,
}

impl ErrorState {
    pub fn new(code: ErrorCode) -> Self {
        Self { code, reason: None }
    }

    pub fn with_reason(code: ErrorCode, reason: RejectionReason) -> Self {
        Self {
            code,
            reason: Some(reason),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerState {
    /// Peer public key, 32 bytes as lowercase hex.
    pub public_key: String,
    pub label: String,
    pub connected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverState {
    pub public_key: String,
    pub address: String,
}

/// The complete tray-visible state. The tray replaces its view with each
/// snapshot rather than merging deltas.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: Phase,
    /// This device's public key, 32 bytes as lowercase hex, once the identity
    /// is loaded.
    pub public_key: Option<String>,
    /// This device's overlay address, once a configuration is paired.
    pub address: Option<String>,
    pub receiver: Option<ReceiverState>,
    pub peers: Vec<PeerState>,
    /// A previous pairing attempt may have reached the receiver. The invitation
    /// must not be replayed until the receiver was inspected and this was
    /// acknowledged.
    pub pairing_unknown: bool,
    pub error: Option<ErrorState>,
}

impl Snapshot {
    pub fn idle(public_key: Option<String>) -> Self {
        Self {
            phase: Phase::Idle,
            public_key,
            address: None,
            receiver: None,
            peers: Vec::new(),
            pairing_unknown: false,
            error: None,
        }
    }

    /// Keep the identifying fields while replacing the transient ones.
    pub fn reset(&self, phase: Phase, error: Option<ErrorState>) -> Self {
        Self {
            phase,
            public_key: self.public_key.clone(),
            address: self.address.clone(),
            receiver: self.receiver.clone(),
            peers: Vec::new(),
            pairing_unknown: self.pairing_unknown,
            error,
        }
    }
}
