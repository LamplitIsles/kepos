//! The pairing and connection state machine.
//!
//! The session owns no I/O and no threads: the runtime feeds it commands from
//! the tray and events from the worklet, the overlay device, the storage layer
//! and the process, and it answers with actions. That keeps the
//! security-relevant transitions testable without a Windows machine.
//!
//! Invariants:
//! * An invitation may only be handed to the worklet **after** the pending
//!   marker was recorded. A failed marker write therefore sends nothing; the
//!   durability limit of that record is documented in `crate::durable`.
//! * A pairing result is reported as paired only after the configuration was
//!   saved. A save failure is an unknown outcome, because the receiver may have
//!   admitted the device.
//! * The pending gate is released only after the marker was actually removed. A
//!   failed clear keeps the gate closed and reports a storage error.
//! * While the gate is closed, `pair` is refused.
//! * The seed and the invitation never appear in a snapshot, in an action that
//!   is not addressed to the worklet, or in an error message.

use serde_json::{json, Value};

use crate::config::PairedConfig;
use crate::state::{
    ErrorCode, ErrorState, PeerState, Phase, ReceiverState, RejectionReason, Snapshot,
};

/// Commands the tray issues.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Pair using an invitation the user pasted. Refused while a previous
    /// outcome is unknown.
    Pair(String),
    /// The operator inspected the receiver and accepts that a previous attempt
    /// may have been admitted.
    AcknowledgePairUnknown,
    Connect,
    Disconnect,
    Shutdown,
}

/// Events the runtime reports. Storage events carry only success or failure;
/// the runtime logs the detail itself so it never reaches a snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A parsed control message from the worklet.
    WorkletControl(Value),
    /// The worklet IPC ended or the worklet exited.
    WorkletGone,
    /// The overlay device failed; the message is already sanitized.
    DeviceFailed(String),
    /// The pending marker was written, or refused because one already exists,
    /// or could not be stored.
    MarkerRecorded(Result<(), MarkerFailure>),
    /// The paired configuration was saved (or not).
    ConfigSaved(Result<(), ()>),
    /// The pending marker was removed (or not).
    MarkerCleared(Result<(), ()>),
}

/// What the runtime must do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Send a control frame to the worklet.
    SendControl(String),
    /// Send a packet to the worklet.
    SendPacket(Vec<u8>),
    /// Create the overlay device and apply its address and peer routes.
    OpenDevice {
        address: String,
        peer_addresses: Vec<String>,
    },
    /// Tear the overlay device down.
    CloseDevice,
    /// Persist the paired configuration before reporting success.
    SaveConfig(PairedConfig),
    /// Record that a pairing attempt is starting.
    MarkPendingPair,
    /// Clear the pending marker after a definite outcome.
    ClearPendingPair,
    /// Publish the current snapshot to the tray. The snapshot is read when the
    /// action is dispatched, so nested actions cannot publish a stale copy.
    Emit,
    /// Stop the backend process.
    Stop,
}

/// Why the pending marker could not be recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkerFailure {
    /// A marker already exists; the earlier outcome must be acknowledged first.
    AlreadyPending,
    /// The marker could not be written.
    Storage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Idle,
    Pairing,
    Connecting,
    Connected,
}

pub struct Session {
    /// Never copied into a snapshot or an action other than a worklet message.
    seed: String,
    mode: Mode,
    config: Option<PairedConfig>,
    /// A pairing result that still has to be saved.
    pending_config: Option<PairedConfig>,
    public_key: Option<String>,
    peers: Vec<PeerState>,
    pairing_unknown: bool,
    error: Option<ErrorState>,
    /// True between `pair` and the marker result.
    awaiting_marker: bool,
    /// True when the outstanding clear is an acknowledgement.
    awaiting_ack_clear: bool,
    /// True between `start` and the worklet's `settings` reply.
    awaiting_settings: bool,
    /// The invitation of the attempt in flight. Held in memory only, and
    /// dropped as soon as the attempt reaches a definite outcome.
    in_flight_invitation: Option<String>,
}

impl Session {
    pub fn new(
        seed: impl Into<String>,
        config: Option<PairedConfig>,
        pairing_unknown: bool,
        public_key: Option<String>,
        startup_error: Option<ErrorState>,
    ) -> Self {
        let mut session = Self {
            seed: seed.into(),
            mode: Mode::Idle,
            config,
            pending_config: None,
            public_key,
            peers: Vec::new(),
            pairing_unknown,
            error: startup_error,
            awaiting_marker: false,
            awaiting_ack_clear: false,
            awaiting_settings: false,
            in_flight_invitation: None,
        };
        if session.error.is_none() {
            session.error = session.validate_startup();
        }
        session
    }

    /// Report a problem that prevents any operation, such as an unusable
    /// configuration file.
    fn validate_startup(&self) -> Option<ErrorState> {
        match &self.config {
            Some(config) if config.validate().is_err() => {
                Some(ErrorState::new(ErrorCode::StateInvalid))
            }
            _ => None,
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            phase: match self.mode {
                Mode::Idle => {
                    if self.error.is_some() {
                        Phase::Failed
                    } else {
                        Phase::Idle
                    }
                }
                Mode::Pairing => Phase::Pairing,
                Mode::Connecting => Phase::Connecting,
                Mode::Connected => Phase::Connected,
            },
            public_key: self.public_key.clone(),
            address: self.config.as_ref().map(|config| config.address.clone()),
            receiver: self.config.as_ref().map(|config| ReceiverState {
                public_key: config.receiver_key.clone(),
                address: config.receiver_address.clone(),
            }),
            peers: self.peers.clone(),
            pairing_unknown: self.pairing_unknown,
            error: self.error.clone(),
        }
    }

    /// True while an attempt is in flight. The runtime keeps the worklet alive
    /// exactly while this is true, and retires it afterwards, because the
    /// worklet bridge cannot be reused for a second attempt.
    pub fn busy(&self) -> bool {
        self.mode != Mode::Idle || self.awaiting_marker || self.awaiting_ack_clear
    }

    /// Ask the worklet for this device's public key. The seed stays here.
    pub fn identify(&self) -> Action {
        Action::SendControl(json!({ "type": "identity", "seed": self.seed }).to_string())
    }

    pub fn command(&mut self, command: Command) -> Vec<Action> {
        match command {
            Command::Pair(invitation) => self.pair(invitation),
            Command::AcknowledgePairUnknown => self.acknowledge(),
            Command::Connect => self.connect(),
            Command::Disconnect => self.disconnect(),
            Command::Shutdown => {
                let mut actions = Vec::new();
                // A shutdown during pairing may abandon an invitation that is
                // already on its way, so it goes through the same gate logic.
                if self.mode != Mode::Idle || self.awaiting_marker {
                    actions.extend(self.stop_tunnel());
                }
                actions.push(Action::Stop);
                actions
            }
        }
    }

    fn pair(&mut self, invitation: String) -> Vec<Action> {
        if self.mode != Mode::Idle {
            return Vec::new();
        }
        if self.pairing_unknown {
            self.error = Some(ErrorState::new(ErrorCode::PairingUnacknowledged));
            return vec![Action::Emit];
        }
        // Bound the message the worklet will parse; the invitation format is
        // far shorter than this.
        if invitation.is_empty() || invitation.len() > 256 {
            self.error = Some(ErrorState::new(ErrorCode::InvitationInvalid));
            return vec![Action::Emit];
        }
        self.mode = Mode::Pairing;
        self.awaiting_marker = true;
        self.in_flight_invitation = Some(invitation);
        self.error = None;
        vec![
            // Nothing is sent until the runtime confirms this marker.
            Action::MarkPendingPair,
            Action::Emit,
        ]
    }

    fn acknowledge(&mut self) -> Vec<Action> {
        if !self.pairing_unknown {
            return Vec::new();
        }
        // The gate is released by `MarkerCleared(Ok)`, not here.
        self.awaiting_ack_clear = true;
        vec![Action::ClearPendingPair, Action::Emit]
    }

    fn connect(&mut self) -> Vec<Action> {
        if self.mode != Mode::Idle {
            return Vec::new();
        }
        let Some(config) = self.config.clone() else {
            self.error = Some(ErrorState::new(ErrorCode::NotPaired));
            return vec![Action::Emit];
        };
        let Ok(toml) = config.tunnel_toml() else {
            self.error = Some(ErrorState::new(ErrorCode::StateInvalid));
            return vec![Action::Emit];
        };
        self.mode = Mode::Connecting;
        self.awaiting_settings = true;
        self.error = None;
        self.peers.clear();
        vec![
            Action::SendControl(
                json!({ "type": "start", "config": toml, "seed": self.seed, "caps": ["diag"] })
                    .to_string(),
            ),
            Action::Emit,
        ]
    }

    fn disconnect(&mut self) -> Vec<Action> {
        if self.mode == Mode::Idle {
            return Vec::new();
        }
        self.stop_tunnel()
    }

    fn stop_tunnel(&mut self) -> Vec<Action> {
        let was_pairing = self.mode == Mode::Pairing || self.awaiting_marker;
        self.mode = Mode::Idle;
        self.awaiting_settings = false;
        self.peers.clear();
        self.awaiting_marker = false;
        self.in_flight_invitation = None;
        if was_pairing {
            // The invitation may already have reached the receiver, so the
            // marker is kept and the gate stays closed until it is acknowledged.
            self.pairing_unknown = true;
            self.error = Some(ErrorState::new(ErrorCode::PairingUnknown));
            // A bridge in `starting` rejects `stop`; the runtime retires it
            // instead, so no control message is sent here.
            return vec![Action::CloseDevice, Action::Emit];
        }
        self.error = None;
        vec![
            Action::SendControl(json!({ "type": "stop" }).to_string()),
            Action::CloseDevice,
            Action::Emit,
        ]
    }

    pub fn event(&mut self, event: Event) -> Vec<Action> {
        match event {
            Event::WorkletControl(value) => self.worklet_control(value),
            Event::WorkletGone => self.worklet_gone(),
            Event::DeviceFailed(detail) => self.device_failed(detail),
            Event::MarkerRecorded(result) => self.marker_recorded(result),
            Event::ConfigSaved(result) => self.config_saved(result),
            Event::MarkerCleared(result) => self.marker_cleared(result),
        }
    }

    fn marker_recorded(&mut self, result: Result<(), MarkerFailure>) -> Vec<Action> {
        if !self.awaiting_marker {
            return Vec::new();
        }
        self.awaiting_marker = false;
        match result {
            Ok(()) => {
                // Only now may the one-shot invitation leave this process.
                let invitation = self.in_flight_invitation.take().unwrap_or_default();
                vec![
                    Action::SendControl(
                        json!({ "type": "pair", "invitation": invitation, "seed": self.seed })
                            .to_string(),
                    ),
                    Action::Emit,
                ]
            }
            Err(failure) => {
                self.in_flight_invitation = None;
                self.mode = Mode::Idle;
                self.error = Some(ErrorState::new(match failure {
                    // The invitation was not sent, but an earlier attempt is
                    // still unacknowledged: the gate must stay closed.
                    MarkerFailure::AlreadyPending => ErrorCode::PairingUnknown,
                    MarkerFailure::Storage => ErrorCode::StateInvalid,
                }));
                self.pairing_unknown = matches!(failure, MarkerFailure::AlreadyPending);
                vec![Action::Emit]
            }
        }
    }

    fn marker_cleared(&mut self, result: Result<(), ()>) -> Vec<Action> {
        let was_ack = self.awaiting_ack_clear;
        self.awaiting_ack_clear = false;
        match result {
            Ok(()) => {
                if was_ack {
                    self.pairing_unknown = false;
                    if matches!(
                        self.error.as_ref().map(|error| error.code),
                        Some(ErrorCode::PairingUnacknowledged) | Some(ErrorCode::PairingUnknown)
                    ) {
                        self.error = None;
                    }
                }
                vec![Action::Emit]
            }
            Err(()) => {
                // The marker is still there, so pairing stays blocked — also
                // after a restart, where it will be read again.
                self.pairing_unknown = true;
                self.error = Some(ErrorState::new(ErrorCode::StateInvalid));
                vec![Action::Emit]
            }
        }
    }

    fn config_saved(&mut self, result: Result<(), ()>) -> Vec<Action> {
        let Some(config) = self.pending_config.take() else {
            return Vec::new();
        };
        match result {
            Ok(()) => {
                self.config = Some(config);
                self.mode = Mode::Idle;
                self.error = None;
                vec![Action::ClearPendingPair, Action::Emit]
            }
            Err(()) => {
                // The receiver may have admitted the device even though the
                // result could not be stored.
                self.mode = Mode::Idle;
                self.pairing_unknown = true;
                self.error = Some(ErrorState::new(ErrorCode::PairingUnknown));
                vec![Action::Emit]
            }
        }
    }

    fn worklet_control(&mut self, value: Value) -> Vec<Action> {
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            return Vec::new();
        };
        match kind {
            "identity" => {
                if let Some(key) = value.get("publicKey").and_then(Value::as_str) {
                    if crate::identity::validate_public_key(key).is_ok() {
                        self.public_key = Some(key.to_string());
                        return vec![Action::Emit];
                    }
                }
                Vec::new()
            }
            "paired" => self.paired(&value),
            "pair-error" => self.pair_error(value.get("reason").and_then(Value::as_str)),
            "settings" => self.settings(&value),
            "peer" => self.peer(&value),
            "running" => {
                if self.mode != Mode::Connecting {
                    return Vec::new();
                }
                self.mode = Mode::Connected;
                vec![Action::Emit]
            }
            "stopped" => {
                if self.mode == Mode::Idle {
                    return Vec::new();
                }
                self.mode = Mode::Idle;
                self.peers.clear();
                vec![Action::CloseDevice, Action::Emit]
            }
            "error" => {
                self.mode = Mode::Idle;
                self.awaiting_settings = false;
                self.peers.clear();
                self.error = Some(ErrorState::new(ErrorCode::EngineFailed));
                vec![Action::CloseDevice, Action::Emit]
            }
            _ => Vec::new(),
        }
    }

    fn paired(&mut self, value: &Value) -> Vec<Action> {
        if self.mode != Mode::Pairing {
            return Vec::new();
        }
        let parsed = (|| {
            let address = value.get("address")?.as_str()?.to_string();
            let receiver_address = value.get("receiverAddress")?.as_str()?.to_string();
            let receiver_key = value.get("receiverKey")?.as_str()?.to_string();
            let config = PairedConfig {
                address,
                receiver_address,
                receiver_key,
            };
            config.validate().ok()?;
            Some(config)
        })();
        let Some(config) = parsed else {
            // The receiver answered, so the admission may have happened even
            // though the result cannot be used. Keep the marker and the gate.
            self.in_flight_invitation = None;
            self.mode = Mode::Idle;
            self.pairing_unknown = true;
            self.error = Some(ErrorState::new(ErrorCode::PairingUnknown));
            return vec![Action::Emit];
        };
        self.in_flight_invitation = None;
        self.pending_config = Some(config.clone());
        // Reported as paired only after `ConfigSaved(Ok)`.
        vec![Action::SaveConfig(config), Action::Emit]
    }

    fn pair_error(&mut self, reason: Option<&str>) -> Vec<Action> {
        if self.mode != Mode::Pairing {
            return Vec::new();
        }
        self.mode = Mode::Idle;
        let (error, definite) = match reason {
            Some("unusable") => (ErrorState::new(ErrorCode::InvitationInvalid), true),
            Some("unavailable") => (ErrorState::new(ErrorCode::PairUnavailable), true),
            Some("capacity") => (
                ErrorState::with_reason(ErrorCode::PairRejected, RejectionReason::Capacity),
                true,
            ),
            Some("pool") => (
                ErrorState::with_reason(ErrorCode::PairRejected, RejectionReason::Pool),
                true,
            ),
            Some("route") => (
                ErrorState::with_reason(ErrorCode::PairRejected, RejectionReason::Route),
                true,
            ),
            Some("excluded") => (
                ErrorState::with_reason(ErrorCode::PairRejected, RejectionReason::Excluded),
                true,
            ),
            // The receiver may have committed the admission.
            _ => (ErrorState::new(ErrorCode::PairingUnknown), false),
        };
        self.in_flight_invitation = None;
        self.error = Some(error);
        if definite {
            vec![Action::ClearPendingPair, Action::Emit]
        } else {
            self.pairing_unknown = true;
            vec![Action::Emit]
        }
    }

    fn settings(&mut self, value: &Value) -> Vec<Action> {
        if self.mode != Mode::Connecting || !self.awaiting_settings {
            return Vec::new();
        }
        let Some(config) = self.config.clone() else {
            return Vec::new();
        };
        if let Some(key) = value.get("publicKey").and_then(Value::as_str) {
            if crate::identity::validate_public_key(key).is_ok() {
                self.public_key = Some(key.to_string());
            }
        }
        self.awaiting_settings = false;
        self.peers = peers_from(value);
        vec![
            Action::OpenDevice {
                address: config.address,
                peer_addresses: vec![config.receiver_address],
            },
            Action::SendControl(json!({ "type": "ready" }).to_string()),
            Action::Emit,
        ]
    }

    fn peer(&mut self, value: &Value) -> Vec<Action> {
        if self.mode != Mode::Connecting && self.mode != Mode::Connected {
            return Vec::new();
        }
        let Some(key) = value.get("publicKey").and_then(Value::as_str) else {
            return Vec::new();
        };
        let Some(connected) = value.get("connected").and_then(Value::as_bool) else {
            return Vec::new();
        };
        let label = value
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match self.peers.iter_mut().find(|peer| peer.public_key == key) {
            Some(peer) => {
                peer.connected = connected;
                peer.label = label;
            }
            None => self.peers.push(PeerState {
                public_key: key.to_string(),
                label,
                connected,
            }),
        }
        vec![Action::Emit]
    }

    fn worklet_gone(&mut self) -> Vec<Action> {
        if self.mode == Mode::Idle {
            return Vec::new();
        }
        let was_pairing = self.mode == Mode::Pairing || self.awaiting_marker;
        self.mode = Mode::Idle;
        self.awaiting_settings = false;
        self.peers.clear();
        self.awaiting_marker = false;
        self.in_flight_invitation = None;
        if was_pairing {
            // The engine died while an invitation may have been in flight.
            self.pairing_unknown = true;
            self.error = Some(ErrorState::new(ErrorCode::PairingUnknown));
        } else {
            self.error = Some(ErrorState::new(ErrorCode::EngineFailed));
        }
        vec![Action::CloseDevice, Action::Emit]
    }

    fn device_failed(&mut self, detail: String) -> Vec<Action> {
        let code = if detail.contains("admin") || detail.contains("access denied") {
            ErrorCode::AdminRequired
        } else {
            ErrorCode::DeviceFailed
        };
        if self.mode == Mode::Idle {
            self.error = Some(ErrorState::new(code));
            return vec![Action::Emit];
        }
        self.mode = Mode::Idle;
        self.awaiting_settings = false;
        self.peers.clear();
        self.error = Some(ErrorState::new(code));
        vec![
            Action::SendControl(json!({ "type": "stop" }).to_string()),
            Action::CloseDevice,
            Action::Emit,
        ]
    }
}

fn peers_from(value: &Value) -> Vec<PeerState> {
    let mut peers = Vec::new();
    if let Some(list) = value.get("peers").and_then(Value::as_array) {
        for entry in list.iter().take(16) {
            let Some(key) = entry.get("publicKey").and_then(Value::as_str) else {
                continue;
            };
            if crate::identity::validate_public_key(key).is_err() {
                continue;
            }
            peers.push(PeerState {
                public_key: key.to_string(),
                label: entry
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                connected: entry
                    .get("connected")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
    }
    peers
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const RECEIVER_KEY: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const INVITATION: &str = "kepos1:invitation";

    fn paired() -> PairedConfig {
        PairedConfig {
            address: "198.18.20.2".into(),
            receiver_address: "198.18.20.1".into(),
            receiver_key: RECEIVER_KEY.into(),
        }
    }

    fn session() -> Session {
        Session::new(SEED, Some(paired()), false, Some(RECEIVER_KEY.into()), None)
    }

    fn controls(actions: &[Action]) -> Vec<&str> {
        actions
            .iter()
            .filter_map(|action| match action {
                Action::SendControl(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn pair_until_sent(session: &mut Session) -> Vec<Action> {
        let first = session.command(Command::Pair(INVITATION.into()));
        assert_eq!(first, vec![Action::MarkPendingPair, Action::Emit]);
        session.event(Event::MarkerRecorded(Ok(())))
    }

    #[test]
    fn device_details_still_select_the_error_code() {
        // The runtime hands the device error detail to the session unchanged;
        // this mapping decides whether the tray says "administrator required".
        let mut session = Session::new("seed", None, false, None, None);
        session.event(Event::DeviceFailed(
            // The mapping is case-sensitive; this is the exact shape it matches.
            "device: open failed: access denied (os error 5)".to_string(),
        ));
        assert_eq!(
            session.snapshot().error.map(|error| error.code),
            Some(ErrorCode::AdminRequired)
        );

        let mut session = Session::new("seed", None, false, None, None);
        session.event(Event::DeviceFailed("device: read failed".to_string()));
        assert_eq!(
            session.snapshot().error.map(|error| error.code),
            Some(ErrorCode::DeviceFailed)
        );
    }

    #[test]
    fn the_invitation_is_sent_only_after_the_marker_is_recorded() {
        let mut session = Session::new(SEED, None, false, None, None);
        let marked = session.command(Command::Pair(INVITATION.into()));
        assert!(marked.contains(&Action::MarkPendingPair));
        assert!(
            controls(&marked).is_empty(),
            "nothing may leave before the marker"
        );
        assert_eq!(session.snapshot().phase, Phase::Pairing);

        let sent = session.event(Event::MarkerRecorded(Ok(())));
        let messages = controls(&sent);
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("\"pair\""));
        assert!(messages[0].contains(INVITATION));
    }

    #[test]
    fn a_failed_marker_sends_nothing_and_reports_a_storage_error() {
        let mut session = Session::new(SEED, None, false, None, None);
        session.command(Command::Pair(INVITATION.into()));
        let actions = session.event(Event::MarkerRecorded(Err(MarkerFailure::Storage)));
        assert!(
            controls(&actions).is_empty(),
            "no invitation after a failed marker"
        );
        let snapshot = session.snapshot();
        assert_eq!(snapshot.phase, Phase::Failed);
        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            ErrorCode::StateInvalid
        );
        assert!(!snapshot.pairing_unknown);
        // A later attempt is allowed because nothing was sent.
        assert!(session
            .command(Command::Pair(INVITATION.into()))
            .contains(&Action::MarkPendingPair));
    }

    #[test]
    fn a_paired_result_is_reported_only_after_the_configuration_is_saved() {
        let mut session = Session::new(SEED, None, false, None, None);
        pair_until_sent(&mut session);
        let saving = session.event(Event::WorkletControl(json!({
            "type": "paired",
            "address": "198.18.20.2",
            "receiverAddress": "198.18.20.1",
            "receiverKey": RECEIVER_KEY,
        })));
        assert!(saving
            .iter()
            .any(|action| matches!(action, Action::SaveConfig(_))));
        assert!(
            !saving.contains(&Action::ClearPendingPair),
            "clear waits for the save"
        );
        let snapshot = session.snapshot();
        assert_eq!(snapshot.phase, Phase::Pairing);
        assert!(snapshot.address.is_none());

        let saved = session.event(Event::ConfigSaved(Ok(())));
        assert!(saved.contains(&Action::ClearPendingPair));
        let snapshot = session.snapshot();
        assert_eq!(snapshot.phase, Phase::Idle);
        assert_eq!(snapshot.address.as_deref(), Some("198.18.20.2"));
        assert_eq!(snapshot.receiver.as_ref().unwrap().address, "198.18.20.1");
    }

    #[test]
    fn a_failed_save_is_an_unknown_outcome_and_keeps_the_gate() {
        let mut session = Session::new(SEED, None, false, None, None);
        pair_until_sent(&mut session);
        session.event(Event::WorkletControl(json!({
            "type": "paired",
            "address": "198.18.20.2",
            "receiverAddress": "198.18.20.1",
            "receiverKey": RECEIVER_KEY,
        })));
        let actions = session.event(Event::ConfigSaved(Err(())));
        assert!(!actions.contains(&Action::ClearPendingPair));
        let snapshot = session.snapshot();
        assert!(snapshot.pairing_unknown);
        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            ErrorCode::PairingUnknown
        );
        assert!(snapshot.address.is_none());
        assert!(controls(&session.command(Command::Pair(INVITATION.into()))).is_empty());
    }

    #[test]
    fn acknowledgement_releases_the_gate_only_after_the_marker_is_cleared() {
        let mut session = Session::new(SEED, None, true, None, None);
        let requested = session.command(Command::AcknowledgePairUnknown);
        assert!(requested.contains(&Action::ClearPendingPair));
        assert!(
            session.snapshot().pairing_unknown,
            "the gate stays until the clear"
        );

        let cleared = session.event(Event::MarkerCleared(Ok(())));
        assert!(!cleared.is_empty());
        assert!(!session.snapshot().pairing_unknown);
        assert!(session
            .command(Command::Pair(INVITATION.into()))
            .contains(&Action::MarkPendingPair));
    }

    #[test]
    fn a_failed_clear_keeps_the_gate_and_reports_a_storage_error() {
        let mut session = Session::new(SEED, None, true, None, None);
        session.command(Command::AcknowledgePairUnknown);
        session.event(Event::MarkerCleared(Err(())));
        let snapshot = session.snapshot();
        assert!(snapshot.pairing_unknown, "pairing must stay blocked");
        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            ErrorCode::StateInvalid
        );
        assert!(controls(&session.command(Command::Pair(INVITATION.into()))).is_empty());
    }

    #[test]
    fn a_failed_clear_after_a_successful_pairing_blocks_replay() {
        let mut session = Session::new(SEED, None, false, None, None);
        pair_until_sent(&mut session);
        session.event(Event::WorkletControl(json!({
            "type": "paired",
            "address": "198.18.20.2",
            "receiverAddress": "198.18.20.1",
            "receiverKey": RECEIVER_KEY,
        })));
        session.event(Event::ConfigSaved(Ok(())));
        session.event(Event::MarkerCleared(Err(())));
        let snapshot = session.snapshot();
        assert!(snapshot.pairing_unknown);
        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            ErrorCode::StateInvalid
        );
    }

    #[test]
    fn an_unknown_outcome_blocks_replay_until_acknowledged() {
        let mut session = Session::new(SEED, None, false, None, None);
        pair_until_sent(&mut session);
        let actions = session.event(Event::WorkletControl(
            json!({ "type": "pair-error", "reason": "unknown" }),
        ));
        assert!(!actions.contains(&Action::ClearPendingPair));
        let snapshot = session.snapshot();
        assert_eq!(snapshot.phase, Phase::Failed);
        assert!(snapshot.pairing_unknown);
        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            ErrorCode::PairingUnknown
        );

        let refused = session.command(Command::Pair(INVITATION.into()));
        assert!(controls(&refused).is_empty());
        assert_eq!(
            session.snapshot().error.as_ref().unwrap().code,
            ErrorCode::PairingUnacknowledged
        );
    }

    #[test]
    fn a_definite_rejection_clears_the_marker() {
        for reason in [
            "unusable",
            "unavailable",
            "capacity",
            "pool",
            "route",
            "excluded",
        ] {
            let mut session = Session::new(SEED, None, false, None, None);
            pair_until_sent(&mut session);
            let actions = session.event(Event::WorkletControl(
                json!({ "type": "pair-error", "reason": reason }),
            ));
            assert!(actions.contains(&Action::ClearPendingPair), "{reason}");
            assert!(!session.snapshot().pairing_unknown, "{reason}");
            assert!(session.snapshot().error.is_some(), "{reason}");
        }
    }

    #[test]
    fn a_restart_with_a_marker_refuses_pairing() {
        let mut session = Session::new(SEED, None, true, None, None);
        assert!(session.snapshot().pairing_unknown);
        assert!(controls(&session.command(Command::Pair(INVITATION.into()))).is_empty());
    }

    #[test]
    fn a_damaged_marker_is_reported_as_a_startup_error_and_still_blocks_pairing() {
        let session = Session::new(
            SEED,
            None,
            true,
            None,
            Some(ErrorState::new(ErrorCode::StateInvalid)),
        );
        let snapshot = session.snapshot();
        assert!(snapshot.pairing_unknown);
        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            ErrorCode::StateInvalid
        );
    }

    #[test]
    fn connecting_opens_the_device_only_after_the_settings_arrive() {
        let mut session = session();
        let started = session.command(Command::Connect);
        assert!(started
            .iter()
            .all(|action| !matches!(action, Action::OpenDevice { .. })));
        assert_eq!(session.snapshot().phase, Phase::Connecting);

        let settings = session.event(Event::WorkletControl(json!({
            "type": "settings",
            "publicKey": RECEIVER_KEY,
            "address": "198.18.20.2",
            "peers": [{ "publicKey": RECEIVER_KEY, "label": "receiver", "connected": false }],
        })));
        let open = settings.iter().find_map(|action| match action {
            Action::OpenDevice {
                address,
                peer_addresses,
            } => Some((address.clone(), peer_addresses.clone())),
            _ => None,
        });
        assert_eq!(
            open,
            Some(("198.18.20.2".to_string(), vec!["198.18.20.1".to_string()]))
        );
        assert!(controls(&settings).contains(&"{\"type\":\"ready\"}"));

        session.event(Event::WorkletControl(json!({ "type": "running" })));
        assert_eq!(session.snapshot().phase, Phase::Connected);
    }

    #[test]
    fn connecting_without_a_configuration_reports_not_paired() {
        let mut session = Session::new(SEED, None, false, None, None);
        let actions = session.command(Command::Connect);
        assert!(actions
            .iter()
            .all(|action| !matches!(action, Action::OpenDevice { .. })));
        assert_eq!(
            session.snapshot().error.as_ref().unwrap().code,
            ErrorCode::NotPaired
        );
    }

    #[test]
    fn disconnecting_stops_the_worklet_and_releases_the_device() {
        let mut session = session();
        session.command(Command::Connect);
        session.event(Event::WorkletControl(json!({
            "type": "settings", "publicKey": RECEIVER_KEY, "address": "198.18.20.2", "peers": []
        })));
        session.event(Event::WorkletControl(json!({ "type": "running" })));
        let actions = session.command(Command::Disconnect);
        assert!(actions.contains(&Action::CloseDevice));
        assert_eq!(controls(&actions), vec!["{\"type\":\"stop\"}"]);
        assert_eq!(session.snapshot().phase, Phase::Idle);
    }

    #[test]
    fn a_lost_worklet_fails_the_attempt_and_clears_the_device() {
        let mut session = session();
        session.command(Command::Connect);
        let actions = session.event(Event::WorkletGone);
        assert!(actions.contains(&Action::CloseDevice));
        assert_eq!(
            session.snapshot().error.as_ref().unwrap().code,
            ErrorCode::EngineFailed
        );
    }

    #[test]
    fn a_device_failure_that_needs_administrator_rights_is_reported_as_such() {
        let mut session = session();
        session.command(Command::Connect);
        session.event(Event::WorkletControl(json!({
            "type": "settings", "publicKey": RECEIVER_KEY, "address": "198.18.20.2", "peers": []
        })));
        session.event(Event::DeviceFailed(
            "admin: creating the overlay adapter failed (5)".into(),
        ));
        assert_eq!(
            session.snapshot().error.as_ref().unwrap().code,
            ErrorCode::AdminRequired
        );
    }

    #[test]
    fn shutdown_stops_the_tunnel_and_the_process() {
        let mut session = session();
        session.command(Command::Connect);
        let actions = session.command(Command::Shutdown);
        assert!(actions.contains(&Action::Stop));
        assert!(actions.contains(&Action::CloseDevice));
    }

    /// Dispatch a queue the way the runtime does: `Emit` publishes whatever the
    /// session holds at that moment, and storage actions report their result as
    /// a follow-up event.
    fn dispatch(session: &mut Session, actions: Vec<Action>) -> (Vec<Snapshot>, Vec<Event>) {
        let mut published = Vec::new();
        let mut events = Vec::new();
        for action in actions {
            match action {
                Action::Emit => published.push(session.snapshot()),
                Action::MarkPendingPair => events.push(Event::MarkerRecorded(Ok(()))),
                Action::SaveConfig(_) => events.push(Event::ConfigSaved(Ok(()))),
                Action::ClearPendingPair => events.push(Event::MarkerCleared(Ok(()))),
                _ => {}
            }
        }
        (published, events)
    }

    #[test]
    fn a_nested_storage_result_is_not_overwritten_by_a_stale_snapshot() {
        let mut session = Session::new(SEED, None, false, None, None);
        // The runtime dispatches [MarkPendingPair, Emit]; the marker result is
        // then dispatched from inside that loop, followed by the outer Emit.
        let actions = session.command(Command::Pair(INVITATION.into()));
        let (first, events) = dispatch(&mut session, actions);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].phase, Phase::Pairing);

        let follow_up = session.event(events[0].clone());
        let (nested, _) = dispatch(&mut session, follow_up);
        let (outer, _) = dispatch(&mut session, vec![Action::Emit]);
        let current = session.snapshot();
        assert_eq!(nested.last(), Some(&current));
        assert_eq!(
            outer.last(),
            Some(&current),
            "the trailing Emit must not be stale"
        );
        assert_eq!(current.phase, Phase::Pairing);
    }

    #[test]
    fn a_storage_failure_keeps_the_published_state_failed() {
        let mut session = Session::new(SEED, None, false, None, None);
        let actions = session.command(Command::Pair(INVITATION.into()));
        let _ = dispatch(&mut session, actions);
        let failed = session.event(Event::MarkerRecorded(Err(MarkerFailure::Storage)));
        let (published, _) = dispatch(&mut session, failed);
        let current = session.snapshot();
        assert_eq!(published.last(), Some(&current));
        assert_eq!(current.phase, Phase::Failed);
        assert_eq!(
            current.error.as_ref().unwrap().code,
            ErrorCode::StateInvalid
        );
    }

    #[test]
    fn snapshots_never_carry_the_seed_or_the_invitation() {
        let mut session = Session::new(SEED, Some(paired()), false, None, None);
        pair_until_sent(&mut session);
        session.event(Event::WorkletControl(
            json!({ "type": "pair-error", "reason": "unusable" }),
        ));
        let rendered = serde_json::to_string(&session.snapshot()).unwrap();
        assert!(!rendered.contains(SEED));
        assert!(!rendered.contains(INVITATION));
    }
}

#[cfg(test)]
mod regression_tests {
    use super::*;

    const SEED: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const RECEIVER_KEY: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const INVITATION: &str = "kepos1:invitation";

    fn paired() -> PairedConfig {
        PairedConfig {
            address: "198.18.20.2".into(),
            receiver_address: "198.18.20.1".into(),
            receiver_key: RECEIVER_KEY.into(),
        }
    }

    fn pairing_session() -> Session {
        let mut session = Session::new(SEED, Some(paired()), false, None, None);
        session.command(Command::Pair(INVITATION.into()));
        session.event(Event::MarkerRecorded(Ok(())));
        session
    }

    #[test]
    fn disconnecting_while_pairing_keeps_the_gate_closed() {
        let mut session = pairing_session();
        let actions = session.command(Command::Disconnect);
        assert!(
            !actions.contains(&Action::ClearPendingPair),
            "the marker must stay"
        );
        assert!(!actions
            .iter()
            .any(|action| matches!(action, Action::SendControl(text) if text.contains("stop"))));
        let snapshot = session.snapshot();
        assert!(
            snapshot.pairing_unknown,
            "a possibly sent invitation stays unknown"
        );
        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            ErrorCode::PairingUnknown
        );
        assert_eq!(snapshot.phase, Phase::Failed);
        // A new attempt is refused until the operator acknowledges.
        assert!(session
            .command(Command::Pair(INVITATION.into()))
            .iter()
            .all(|action| !matches!(action, Action::SendControl(_))));
    }

    #[test]
    fn shutting_down_while_pairing_also_keeps_the_gate_closed() {
        let mut session = pairing_session();
        let actions = session.command(Command::Shutdown);
        assert!(actions.contains(&Action::Stop));
        assert!(!actions.contains(&Action::ClearPendingPair));
        assert!(session.snapshot().pairing_unknown);
    }

    #[test]
    fn an_unexpected_worklet_exit_while_pairing_is_unknown() {
        let mut session = pairing_session();
        session.event(Event::WorkletGone);
        let snapshot = session.snapshot();
        assert!(snapshot.pairing_unknown);
        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            ErrorCode::PairingUnknown
        );
    }

    #[test]
    fn an_existing_marker_refuses_the_new_attempt_without_sending() {
        let mut session = Session::new(SEED, None, false, None, None);
        session.command(Command::Pair(INVITATION.into()));
        let actions = session.event(Event::MarkerRecorded(Err(MarkerFailure::AlreadyPending)));
        assert!(actions
            .iter()
            .all(|action| !matches!(action, Action::SendControl(_))));
        let snapshot = session.snapshot();
        assert!(
            snapshot.pairing_unknown,
            "the earlier attempt stays unacknowledged"
        );
        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            ErrorCode::PairingUnknown
        );
        assert_eq!(snapshot.phase, Phase::Failed);
    }

    #[test]
    fn a_storage_failure_during_pairing_does_not_close_the_gate() {
        // Nothing was sent, so there is no unknown admission to acknowledge.
        let mut session = Session::new(SEED, None, false, None, None);
        session.command(Command::Pair(INVITATION.into()));
        session.event(Event::MarkerRecorded(Err(MarkerFailure::Storage)));
        let snapshot = session.snapshot();
        assert!(!snapshot.pairing_unknown);
        assert_eq!(
            snapshot.error.as_ref().unwrap().code,
            ErrorCode::StateInvalid
        );
    }
}
