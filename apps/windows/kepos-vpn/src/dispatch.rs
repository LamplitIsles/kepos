//! Action dispatch: the part of the runtime that turns session actions into
//! side effects, kept free of Windows APIs so its ordering and failure behaviour
//! can be tested with fakes.
//!
//! The rules this module enforces:
//! * A storage failure is fed back into the session, and the invitation is only
//!   sent after the marker was actually recorded.
//! * When opening the device fails, the rest of the batch is dropped: the engine
//!   must not be told `ready` for a device that does not exist.
//! * An IPC failure (closed stream, or a full queue) is fatal for the attempt:
//!   nothing further is sent, and the failure is published.
//! * `Emit` publishes the session's current snapshot, so a nested action can
//!   never be overwritten by an older copy.

use crate::config::PairedConfig;
use crate::session::{Action, Event, MarkerFailure, Session};
use crate::state::{ErrorCode, ErrorState, Phase, Snapshot};

/// Why an attempt cannot continue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineStart {
    /// The worklet could not be created.
    Failed,
    /// The worklet was destroyed but did not confirm its exit.
    ExitUnconfirmed,
}

/// Why an IPC write failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpcError {
    /// The stream is closed or the worklet is gone.
    Closed,
    /// The outbox is full because the peer stopped draining.
    Congested,
}

/// The side effects the dispatcher needs. Implemented by the Windows runtime and
/// by the fakes in this module's tests.
pub trait Sink {
    fn start_engine(&mut self) -> Result<(), EngineStart>;
    fn send_control(&mut self, text: &str) -> Result<(), IpcError>;
    fn send_packet(&mut self, packet: &[u8]) -> Result<(), IpcError>;
    /// Push queued bytes to the worklet. A failure means the stream is gone.
    fn flush(&mut self) -> Result<(), IpcError>;
    fn open_device(&mut self, address: &str, peer_addresses: &[String]) -> Result<(), String>;
    fn close_device(&mut self);
    fn save_config(&mut self, config: &PairedConfig) -> Result<(), ()>;
    fn mark_pending(&mut self) -> Result<(), MarkerFailure>;
    fn clear_pending(&mut self) -> Result<(), ()>;
    fn publish(&mut self, snapshot: &Snapshot);
    fn stop(&mut self);
}

#[derive(Debug, Default)]
pub struct Dispatcher {
    fatal: Option<ErrorCode>,
    stopped: bool,
}

impl Dispatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set when the attempt must end; the runtime stops the worker.
    pub fn fatal(&self) -> Option<ErrorCode> {
        self.fatal
    }

    pub fn stopped(&self) -> bool {
        self.stopped
    }

    /// Drain queued IPC bytes. A failure is handled here, immediately: the
    /// attempt fails now even if no further action or packet ever arrives.
    pub fn flush(&mut self, session: &mut Session, sink: &mut dyn Sink) {
        if self.fatal.is_some() || self.stopped {
            return;
        }
        if sink.flush().is_err() {
            // The worklet is gone. During pairing this keeps the marker and
            // reports an unknown outcome; otherwise it reports an engine
            // failure. Then the attempt ends and the device is released.
            let actions = session.event(Event::WorkletGone);
            self.apply(session, sink, actions);
            self.fail(session, sink, ErrorCode::EngineFailed);
        }
    }

    pub fn apply(&mut self, session: &mut Session, sink: &mut dyn Sink, actions: Vec<Action>) {
        for action in actions {
            if self.fatal.is_some() || self.stopped {
                return;
            }
            match action {
                Action::SendControl(text) => {
                    match sink.start_engine() {
                        Ok(()) => {}
                        Err(EngineStart::Failed) => {
                            let nested = session.event(Event::WorkletGone);
                            self.apply(session, sink, nested);
                            return;
                        }
                        Err(EngineStart::ExitUnconfirmed) => {
                            // The previous runtime may still be alive, so the
                            // identity must stay locked and no new attempt may
                            // start in this process.
                            self.fail(session, sink, ErrorCode::EngineFailed);
                            return;
                        }
                    }
                    if sink.send_control(&text).is_err() {
                        self.fail(session, sink, ErrorCode::EngineFailed);
                        return;
                    }
                }
                Action::SendPacket(packet) => {
                    if sink.send_packet(&packet).is_err() {
                        self.fail(session, sink, ErrorCode::EngineFailed);
                        return;
                    }
                }
                Action::OpenDevice {
                    address,
                    peer_addresses,
                } => {
                    if let Err(detail) = sink.open_device(&address, &peer_addresses) {
                        let nested = session.event(Event::DeviceFailed(detail));
                        self.apply(session, sink, nested);
                        // Drop the rest of the batch: `ready` must not follow a
                        // device that failed to open.
                        return;
                    }
                }
                Action::CloseDevice => sink.close_device(),
                Action::SaveConfig(config) => {
                    let result = sink.save_config(&config);
                    let nested = session.event(Event::ConfigSaved(result));
                    self.apply(session, sink, nested);
                }
                Action::MarkPendingPair => {
                    let result = sink.mark_pending();
                    let nested = session.event(Event::MarkerRecorded(result));
                    self.apply(session, sink, nested);
                }
                Action::ClearPendingPair => {
                    let result = sink.clear_pending();
                    let nested = session.event(Event::MarkerCleared(result));
                    self.apply(session, sink, nested);
                }
                Action::Emit => sink.publish(&session.snapshot()),
                Action::Stop => {
                    sink.stop();
                    self.stopped = true;
                }
            }
        }
    }

    /// Mark the attempt fatal, publish the failure and stop the worker.
    fn fail(&mut self, session: &mut Session, sink: &mut dyn Sink, code: ErrorCode) {
        self.fatal = Some(code);
        let current = session.snapshot();
        // An unknown pairing outcome is more specific than "engine failed" and
        // must survive so the tray keeps asking the operator to check.
        let published = if current.pairing_unknown && current.error.is_some() {
            current
        } else {
            current.reset(Phase::Failed, Some(ErrorState::new(code)))
        };
        sink.publish(&published);
        self.stopped = true;
        sink.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Command;

    const SEED: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const RECEIVER_KEY: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    fn config() -> PairedConfig {
        PairedConfig {
            address: "198.18.20.2".into(),
            receiver_address: "198.18.20.1".into(),
            receiver_key: RECEIVER_KEY.into(),
        }
    }

    fn settings() -> serde_json::Value {
        serde_json::json!({
            "type": "settings",
            "publicKey": RECEIVER_KEY,
            "address": "198.18.20.2",
            "peers": [],
        })
    }

    #[derive(Default)]
    struct FakeSink {
        controls: Vec<String>,
        packets: usize,
        devices_opened: usize,
        devices_closed: usize,
        flushes: usize,
        config_saved: usize,
        published: Vec<Snapshot>,
        stopped: bool,
        start: Option<EngineStart>,
        control_error: Option<IpcError>,
        packet_error: Option<IpcError>,
        flush_error: Option<IpcError>,
        device_error: Option<String>,
        clears: usize,
        marker: Option<Result<(), MarkerFailure>>,
        clear: Option<Result<(), ()>>,
        save: Option<Result<(), ()>>,
    }

    impl Sink for FakeSink {
        fn start_engine(&mut self) -> Result<(), EngineStart> {
            match self.start.take() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
        fn send_control(&mut self, text: &str) -> Result<(), IpcError> {
            if let Some(error) = self.control_error.take() {
                return Err(error);
            }
            self.controls.push(text.to_string());
            Ok(())
        }
        fn send_packet(&mut self, _packet: &[u8]) -> Result<(), IpcError> {
            if let Some(error) = self.packet_error.take() {
                return Err(error);
            }
            self.packets += 1;
            Ok(())
        }
        fn flush(&mut self) -> Result<(), IpcError> {
            self.flushes += 1;
            match self.flush_error.take() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
        fn open_device(&mut self, _address: &str, _peers: &[String]) -> Result<(), String> {
            if let Some(detail) = self.device_error.take() {
                return Err(detail);
            }
            self.devices_opened += 1;
            Ok(())
        }
        fn close_device(&mut self) {
            self.devices_closed += 1;
        }
        fn save_config(&mut self, _config: &PairedConfig) -> Result<(), ()> {
            self.config_saved += 1;
            self.save.take().unwrap_or(Ok(()))
        }
        fn mark_pending(&mut self) -> Result<(), MarkerFailure> {
            self.marker.take().unwrap_or(Ok(()))
        }
        fn clear_pending(&mut self) -> Result<(), ()> {
            self.clears += 1;
            self.clear.take().unwrap_or(Ok(()))
        }
        fn publish(&mut self, snapshot: &Snapshot) {
            self.published.push(snapshot.clone());
        }
        fn stop(&mut self) {
            self.stopped = true;
        }
    }

    fn session() -> Session {
        Session::new(SEED, Some(config()), false, Some(RECEIVER_KEY.into()), None)
    }

    #[test]
    fn a_failed_device_open_does_not_send_ready() {
        let mut session = session();
        let mut sink = FakeSink {
            device_error: Some("admin: denied".into()),
            ..FakeSink::default()
        };
        let mut dispatcher = Dispatcher::new();
        let actions = session.command(Command::Connect);
        dispatcher.apply(&mut session, &mut sink, actions);
        // The settings reply is what triggers the device and the ready message.
        let actions = session.event(Event::WorkletControl(settings()));
        assert!(actions
            .iter()
            .any(|action| matches!(action, Action::OpenDevice { .. })));
        dispatcher.apply(&mut session, &mut sink, actions);
        assert_eq!(sink.devices_opened, 0);
        assert!(
            sink.controls.iter().all(|text| !text.contains("ready")),
            "ready must not follow a failed device"
        );
        assert_eq!(
            session.snapshot().error.as_ref().unwrap().code,
            ErrorCode::AdminRequired
        );
        assert!(
            dispatcher.fatal().is_none(),
            "a device failure is reported, not fatal to the process"
        );
    }

    #[test]
    fn an_ipc_write_failure_stops_the_attempt_and_publishes_failure() {
        let mut session = session();
        let mut sink = FakeSink {
            control_error: Some(IpcError::Congested),
            ..FakeSink::default()
        };
        let mut dispatcher = Dispatcher::new();
        let actions = session.command(Command::Connect);
        dispatcher.apply(&mut session, &mut sink, actions);
        assert_eq!(dispatcher.fatal(), Some(ErrorCode::EngineFailed));
        assert!(dispatcher.stopped());
        assert!(sink.stopped);
        let published = sink.published.last().expect("failure is published");
        assert_eq!(published.phase, Phase::Failed);
        assert_eq!(
            published.error.as_ref().unwrap().code,
            ErrorCode::EngineFailed
        );
        // Nothing further is dispatched after a fatal error.
        let before = sink.published.len();
        dispatcher.apply(
            &mut session,
            &mut sink,
            vec![Action::SendControl("{\"type\":\"stop\"}".into())],
        );
        assert_eq!(sink.published.len(), before);
    }

    #[test]
    fn an_unconfirmed_engine_exit_keeps_the_process_from_continuing() {
        let mut session = session();
        let mut sink = FakeSink {
            start: Some(EngineStart::ExitUnconfirmed),
            ..FakeSink::default()
        };
        let mut dispatcher = Dispatcher::new();
        let actions = session.command(Command::Connect);
        dispatcher.apply(&mut session, &mut sink, actions);
        assert_eq!(dispatcher.fatal(), Some(ErrorCode::EngineFailed));
        assert!(sink.stopped);
        assert!(
            sink.controls.is_empty(),
            "no attempt may start on an unconfirmed runtime"
        );
    }

    #[test]
    fn a_refused_marker_never_sends_the_invitation() {
        let mut session = Session::new(SEED, Some(config()), false, None, None);
        let mut sink = FakeSink {
            marker: Some(Err(MarkerFailure::AlreadyPending)),
            ..FakeSink::default()
        };
        let mut dispatcher = Dispatcher::new();
        let actions = session.command(Command::Pair("kepos1:x".into()));
        dispatcher.apply(&mut session, &mut sink, actions);
        assert!(sink.controls.is_empty());
        let published = sink.published.last().unwrap();
        assert!(published.pairing_unknown);
        assert_eq!(
            published.error.as_ref().unwrap().code,
            ErrorCode::PairingUnknown
        );
    }

    #[test]
    fn a_flush_failure_while_pairing_keeps_the_marker_and_reports_unknown() {
        let mut session = Session::new(SEED, None, false, None, None);
        let mut sink = FakeSink::default();
        let mut dispatcher = Dispatcher::new();
        let actions = session.command(Command::Pair("kepos1:x".into()));
        dispatcher.apply(&mut session, &mut sink, actions);
        assert_eq!(
            sink.controls.len(),
            1,
            "the invitation was sent after the marker"
        );

        // The next flush fails with no further action or packet in flight.
        sink.flush_error = Some(IpcError::Closed);
        dispatcher.flush(&mut session, &mut sink);
        assert_eq!(sink.flushes, 1);
        assert_eq!(dispatcher.fatal(), Some(ErrorCode::EngineFailed));
        assert!(dispatcher.stopped());
        assert!(sink.stopped);
        assert_eq!(sink.clears, 0, "the marker must not be cleared");
        let published = sink.published.last().unwrap();
        assert!(
            published.pairing_unknown,
            "the unknown admission stays visible"
        );
        assert_eq!(published.phase, Phase::Failed);
        assert_eq!(
            published.error.as_ref().unwrap().code,
            ErrorCode::PairingUnknown
        );
    }

    #[test]
    fn a_flush_failure_while_connected_releases_the_device() {
        let mut session = session();
        let mut sink = FakeSink::default();
        let mut dispatcher = Dispatcher::new();
        let actions = session.command(Command::Connect);
        dispatcher.apply(&mut session, &mut sink, actions);
        let settings = session.event(Event::WorkletControl(settings()));
        dispatcher.apply(&mut session, &mut sink, settings);
        session.event(Event::WorkletControl(
            serde_json::json!({ "type": "running" }),
        ));
        assert_eq!(sink.devices_opened, 1);

        sink.flush_error = Some(IpcError::Closed);
        dispatcher.flush(&mut session, &mut sink);
        assert_eq!(sink.devices_closed, 1, "the overlay device is released");
        assert_eq!(dispatcher.fatal(), Some(ErrorCode::EngineFailed));
        let published = sink.published.last().unwrap();
        assert_eq!(published.phase, Phase::Failed);
        assert_eq!(
            published.error.as_ref().unwrap().code,
            ErrorCode::EngineFailed
        );
    }

    #[test]
    fn a_saved_configuration_is_followed_by_the_marker_clear() {
        let mut session = Session::new(SEED, None, false, None, None);
        let mut sink = FakeSink::default();
        let mut dispatcher = Dispatcher::new();
        let actions = session.command(Command::Pair("kepos1:x".into()));
        dispatcher.apply(&mut session, &mut sink, actions);
        let paired = session.event(Event::WorkletControl(serde_json::json!({
            "type": "paired",
            "address": "198.18.20.2",
            "receiverAddress": "198.18.20.1",
            "receiverKey": RECEIVER_KEY,
        })));
        dispatcher.apply(&mut session, &mut sink, paired);
        assert_eq!(sink.config_saved, 1);
        let published = sink.published.last().unwrap();
        assert_eq!(published.phase, Phase::Idle);
        assert_eq!(published.address.as_deref(), Some("198.18.20.2"));
        assert!(!published.pairing_unknown);
    }
}
