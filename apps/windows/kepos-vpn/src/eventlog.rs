//! Bounded, secret-free runtime diagnostics.
//!
//! Only fixed event codes and a process-relative millisecond counter are
//! written. There is no API for free-form text, so exception messages,
//! configuration, seeds, invitations, public keys or packet data cannot reach
//! the file. A failing log never affects the VPN: every write error is ignored
//! and logging simply stops.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::Instant;

/// Hard cap for one log file. Once reached, nothing more is written.
pub const MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Start,
    EngineCreateOk,
    EngineCreateFail,
    EngineStartFail,
    EngineStartExitUnconfirmed,
    EngineExitTimeout,
    EngineIpcClosed,
    EngineWriteFail,
    EngineCongested,
    EngineReadEof,
    EngineReadError,
    EngineExitZero,
    EngineExitNonzero,
    EngineClosedExited,
    EngineClosedUnobserved,
    RetireConfirmed,
    RetireUnconfirmed,
    ControlQueued,
    ControlQueueFail,
    ControlReadyQueued,
    ControlReadyQueueFail,
    ControlReadyWritten,
    EngineDecodeFail,
    DeviceWriteFail,
    WorkletGone,
    DeviceOpenFail,
    DeviceOpenOk,
    WorkletSettings,
    WorkletRunning,
    WorkletStopped,
    WorkletError,
    WorkletErrorStartup,
    WorkletErrorConfig,
    WorkletErrorPeers,
    WorkletErrorTun,
    WorkletErrorDht,
    WorkletErrorListen,
    WorkletErrorRunning,
    WorkletDiagSettings,
    WorkletDiagReady,
    WorkletDiagConfig,
    WorkletDiagPeers,
    WorkletDiagTun,
    WorkletDiagDht,
    WorkletDiagListen,
    WorkletDiagListenReturned,
    WorkletDiagListenRejected,
    WorkletDiagStartupRejected,
    WorkletDiagCleanupBegin,
    WorkletDiagCleanupEnd,
    DeviceReadFail,
    RetireBegin,
    RetireDone,
    PhaseIdle,
    PhasePairing,
    PhaseConnecting,
    PhaseConnected,
    PhaseFailed,
    Shutdown,
}

impl Event {
    pub fn code(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::EngineCreateOk => "engine:create-ok",
            Self::EngineCreateFail => "engine:create-fail",
            Self::EngineStartFail => "engine:start-fail",
            Self::EngineStartExitUnconfirmed => "engine:start-exit-unconfirmed",
            Self::EngineExitTimeout => "engine:exit-timeout",
            Self::EngineIpcClosed => "engine:ipc-closed",
            Self::EngineWriteFail => "engine:write-fail",
            Self::EngineCongested => "engine:congested",
            Self::EngineReadEof => "engine:read-eof",
            Self::EngineReadError => "engine:read-error",
            Self::EngineExitZero => "engine:exit-0",
            Self::EngineExitNonzero => "engine:exit-nonzero",
            Self::EngineClosedExited => "engine:closed-exited",
            Self::EngineClosedUnobserved => "engine:closed-unobserved",
            Self::RetireConfirmed => "retire:confirmed",
            Self::RetireUnconfirmed => "retire:unconfirmed",
            Self::ControlQueued => "control:queued",
            Self::ControlQueueFail => "control:queue-failed",
            Self::ControlReadyQueued => "control:ready-queued",
            Self::ControlReadyQueueFail => "control:ready-queue-failed",
            Self::ControlReadyWritten => "control:ready-written",
            Self::EngineDecodeFail => "engine:decode-fail",
            Self::DeviceWriteFail => "device:write-fail",
            Self::WorkletGone => "worklet:gone",
            Self::DeviceOpenFail => "device:open-fail",
            Self::DeviceOpenOk => "device:open-ok",
            Self::WorkletSettings => "worklet:settings",
            Self::WorkletRunning => "worklet:running",
            Self::WorkletStopped => "worklet:stopped",
            Self::WorkletError => "worklet:error",
            Self::WorkletErrorStartup => "worklet:error-startup",
            Self::WorkletErrorConfig => "worklet:error-config",
            Self::WorkletErrorPeers => "worklet:error-peers",
            Self::WorkletErrorTun => "worklet:error-tun",
            Self::WorkletErrorDht => "worklet:error-dht",
            Self::WorkletErrorListen => "worklet:error-listen",
            Self::WorkletErrorRunning => "worklet:error-running",
            Self::WorkletDiagSettings => "worklet:diag-settings",
            Self::WorkletDiagReady => "worklet:diag-ready",
            Self::WorkletDiagConfig => "worklet:diag-config",
            Self::WorkletDiagPeers => "worklet:diag-peers",
            Self::WorkletDiagTun => "worklet:diag-tun",
            Self::WorkletDiagDht => "worklet:diag-dht",
            Self::WorkletDiagListen => "worklet:diag-listen",
            Self::WorkletDiagListenReturned => "worklet:diag-listen-returned",
            Self::WorkletDiagListenRejected => "worklet:diag-listen-rejected",
            Self::WorkletDiagStartupRejected => "worklet:diag-startup-rejected",
            Self::WorkletDiagCleanupBegin => "worklet:diag-cleanup-begin",
            Self::WorkletDiagCleanupEnd => "worklet:diag-cleanup-end",
            Self::DeviceReadFail => "device:read-fail",
            Self::RetireBegin => "retire:begin",
            Self::RetireDone => "retire:done",
            Self::PhaseIdle => "phase:idle",
            Self::PhasePairing => "phase:pairing",
            Self::PhaseConnecting => "phase:connecting",
            Self::PhaseConnected => "phase:connected",
            Self::PhaseFailed => "phase:failed",
            Self::Shutdown => "shutdown",
        }
    }
}

pub struct EventLog {
    file: Option<File>,
    written: usize,
    started: Instant,
    last_phase: Option<Event>,
}

impl EventLog {
    /// Open a per-process log in `dir`. Never overwrites: the name carries the
    /// process id and a counter, and creation is exclusive.
    pub fn open(dir: &Path, pid: u32) -> Self {
        let mut log = Self {
            file: None,
            written: 0,
            started: Instant::now(),
            last_phase: None,
        };
        if fs::create_dir_all(dir).is_err() {
            return log;
        }
        for attempt in 0..8u32 {
            let name = if attempt == 0 {
                format!("vpn-{pid}.log")
            } else {
                format!("vpn-{pid}-{attempt}.log")
            };
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dir.join(name))
            {
                Ok(file) => {
                    log.file = Some(file);
                    return log;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return log,
            }
        }
        log
    }

    pub fn record(&mut self, event: Event) {
        if event == Event::PhaseIdle
            || event == Event::PhasePairing
            || event == Event::PhaseConnecting
            || event == Event::PhaseConnected
            || event == Event::PhaseFailed
        {
            if self.last_phase == Some(event) {
                return;
            }
            self.last_phase = Some(event);
        }
        let Some(file) = self.file.as_mut() else {
            return;
        };
        let line = format!(
            "{:>8}ms {}\n",
            self.started.elapsed().as_millis(),
            event.code()
        );
        if self.written + line.len() > MAX_BYTES {
            self.file = None;
            return;
        }
        if file.write_all(line.as_bytes()).is_err() {
            self.file = None;
            return;
        }
        self.written += line.len();
    }
}

/// Fixed code for an IPC failure, so a start failure or a full queue is never
/// reported as a closed stream.
pub fn record_ipc(events: &mut EventLog, error: crate::dispatch::IpcError) {
    use crate::dispatch::IpcError;
    events.record(match error {
        IpcError::Closed => Event::EngineIpcClosed,
        IpcError::Congested => Event::EngineCongested,
    });
}

/// Classify a worklet control message by its `type` field only.
///
/// The payload itself is never copied: only fixed names are recognised and
/// everything else yields nothing, so reasons, addresses and other content
/// cannot reach the log. A coalesced `diag` frame may carry several stages.
pub fn control_events(payload: &[u8]) -> Vec<Event> {
    let value: serde_json::Value = match serde_json::from_slice(payload) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let Some(kind) = value.get("type").and_then(serde_json::Value::as_str) else {
        return Vec::new();
    };
    let single = |name: Option<&str>| -> Option<Event> {
        Some(match name {
            Some("settings-sent") => Event::WorkletDiagSettings,
            Some("ready") => Event::WorkletDiagReady,
            Some("config") => Event::WorkletDiagConfig,
            Some("peers") => Event::WorkletDiagPeers,
            Some("tun") => Event::WorkletDiagTun,
            Some("dht") => Event::WorkletDiagDht,
            Some("listen") => Event::WorkletDiagListen,
            Some("listen-return") => Event::WorkletDiagListenReturned,
            Some("listen-reject") => Event::WorkletDiagListenRejected,
            Some("startup-reject") => Event::WorkletDiagStartupRejected,
            Some("cleanup-begin") => Event::WorkletDiagCleanupBegin,
            Some("cleanup-end") => Event::WorkletDiagCleanupEnd,
            _ => return None,
        })
    };
    match kind {
        "settings" => vec![Event::WorkletSettings],
        "running" => vec![Event::WorkletRunning],
        "stopped" => vec![Event::WorkletStopped],
        "error" => vec![
            match value.get("stage").and_then(serde_json::Value::as_str) {
                Some("startup") => Event::WorkletErrorStartup,
                Some("config") => Event::WorkletErrorConfig,
                Some("peers") => Event::WorkletErrorPeers,
                Some("tun") => Event::WorkletErrorTun,
                Some("dht") => Event::WorkletErrorDht,
                Some("listen") => Event::WorkletErrorListen,
                Some("running") => Event::WorkletErrorRunning,
                _ => Event::WorkletError,
            },
        ],
        "diag" => match value.get("stages").and_then(serde_json::Value::as_array) {
            Some(stages) => stages
                .iter()
                .filter_map(|stage| single(stage.as_str()))
                .collect(),
            None => single(value.get("stage").and_then(serde_json::Value::as_str))
                .into_iter()
                .collect(),
        },
        _ => Vec::new(),
    }
}

/// Classify an observed exit code. Only the class is recorded.
pub fn exit_event(code: i32) -> Event {
    if code == 0 {
        Event::EngineExitZero
    } else {
        Event::EngineExitNonzero
    }
}

/// Whether a control message is a plain `{"type":"ready"}`. Only the `type`
/// field is read; the text is never recorded.
pub fn is_ready_control(text: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => value.get("type").and_then(serde_json::Value::as_str) == Some("ready"),
        Err(_) => false,
    }
}

/// Record that a control message was queued (not delivered). A ready message
/// also gets its own pair of codes, so the ready stage is distinguishable.
pub fn record_control_result(events: &mut EventLog, text: &str, queued: bool) {
    events.record(if queued {
        Event::ControlQueued
    } else {
        Event::ControlQueueFail
    });
    if is_ready_control(text) {
        events.record(if queued {
            Event::ControlReadyQueued
        } else {
            Event::ControlReadyQueueFail
        });
    }
}

/// Fixed code for the phase a snapshot reports.
pub fn record_phase(events: &mut EventLog, phase: crate::state::Phase) {
    use crate::state::Phase;
    events.record(match phase {
        Phase::Idle => Event::PhaseIdle,
        Phase::Pairing => Event::PhasePairing,
        Phase::Connecting => Event::PhaseConnecting,
        Phase::Connected => Event::PhaseConnected,
        Phase::Failed => Event::PhaseFailed,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdir::TestDir;

    #[test]
    fn writes_only_fixed_codes_with_a_relative_time() {
        let dir = TestDir::create("eventlog-codes");
        let mut log = EventLog::open(dir.path(), 4242);
        log.record(Event::Start);
        log.record(Event::PhaseConnecting);
        log.record(Event::EngineCreateFail);
        let text = fs::read_to_string(dir.path().join("vpn-4242.log")).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(text.contains(" start"));
        assert!(text.contains("phase:connecting"));
        assert!(text.contains("engine:create-fail"));
        for line in text.lines() {
            let mut parts = line.split_whitespace();
            let millis = parts.next().unwrap();
            let code = parts.next().unwrap();
            assert!(parts.next().is_none(), "unexpected extra field in {line:?}");
            assert!(
                millis.ends_with("ms") && millis[..millis.len() - 2].trim().parse::<u128>().is_ok()
            );
            assert!(
                Event::Start.code() == code
                    || code.starts_with("engine:")
                    || code.starts_with("phase:")
                    || code.starts_with("worklet:")
                    || code.starts_with("retire:")
                    || code == Event::Shutdown.code()
            );
        }
    }

    #[test]
    fn control_classification_is_a_fixed_allowlist() {
        assert_eq!(
            control_events(br#"{"type":"settings"}"#),
            vec![Event::WorkletSettings]
        );
        assert_eq!(
            control_events(br#"{"type":"running"}"#),
            vec![Event::WorkletRunning]
        );
        assert_eq!(
            control_events(br#"{"type":"stopped"}"#),
            vec![Event::WorkletStopped]
        );
        assert_eq!(
            control_events(br#"{"type":"error"}"#),
            vec![Event::WorkletError]
        );
        assert_eq!(
            control_events(br#"{"type":"error","stage":"listen"}"#),
            vec![Event::WorkletErrorListen]
        );
        // A coalesced burst keeps every stage, in order.
        assert_eq!(
            control_events(br#"{"type":"diag","stages":["settings-sent","ready","config","peers","tun","dht","listen"]}"#),
            vec![
                Event::WorkletDiagSettings,
                Event::WorkletDiagReady,
                Event::WorkletDiagConfig,
                Event::WorkletDiagPeers,
                Event::WorkletDiagTun,
                Event::WorkletDiagDht,
                Event::WorkletDiagListen,
            ]
        );
        // Unknown names, extra fields and non-JSON produce nothing at all.
        assert!(
            control_events(br#"{"type":"diag","stages":["other","ready"]}"#)
                == vec![Event::WorkletDiagReady]
        );
        assert!(control_events(br#"{"type":"identity","publicKey":"aa"}"#).is_empty());
        assert!(control_events(b"not json").is_empty());
        assert!(control_events(b"[]").is_empty());
        for event in [
            Event::WorkletSettings,
            Event::WorkletDiagListen,
            Event::WorkletErrorTun,
        ] {
            let code = event.code();
            assert!(!code.contains(' ') && !code.contains('{'));
        }
    }

    #[test]
    fn repeated_phases_are_collapsed() {
        let dir = TestDir::create("eventlog-phase");
        let mut log = EventLog::open(dir.path(), 7);
        log.record(Event::PhaseIdle);
        log.record(Event::PhaseIdle);
        log.record(Event::PhaseConnecting);
        let text = fs::read_to_string(dir.path().join("vpn-7.log")).unwrap();
        assert_eq!(text.matches("phase:idle").count(), 1);
        assert_eq!(text.matches("phase:connecting").count(), 1);
    }

    #[test]
    fn never_overwrites_and_stops_at_the_cap() {
        let dir = TestDir::create("eventlog-cap");
        fs::write(dir.path().join("vpn-9.log"), b"existing").unwrap();
        let mut log = EventLog::open(dir.path(), 9);
        log.record(Event::Start);
        assert_eq!(
            fs::read_to_string(dir.path().join("vpn-9.log")).unwrap(),
            "existing"
        );
        assert!(dir.path().join("vpn-9-1.log").exists());

        let mut big = EventLog::open(dir.path(), 11);
        for _ in 0..20_000 {
            big.record(Event::WorkletGone);
        }
        let size = fs::metadata(dir.path().join("vpn-11.log")).unwrap().len();
        assert!(size <= MAX_BYTES as u64, "log grew to {size}");
    }

    #[test]
    fn an_unusable_directory_never_panics() {
        let dir = TestDir::create("eventlog-bad");
        let blocker = dir.path().join("file");
        fs::write(&blocker, b"x").unwrap();
        let mut log = EventLog::open(&blocker, 3);
        log.record(Event::Start);
    }
}

/// Runtime-level checks: a real dispatcher and session drive a fake sink that
/// reports through the same helpers the Windows sink uses.
#[cfg(test)]
mod runtime_log {
    use super::*;
    use crate::config::PairedConfig;
    use crate::dispatch::{Dispatcher, EngineStart, IpcError, Sink};
    use crate::eventlog::EventLog;
    use crate::session::{Command, MarkerFailure, Session};
    use crate::state::Snapshot;
    use crate::testdir::TestDir;

    /// Minimal sink that reports the failures a real engine start produces, so
    /// the logged codes come from the same helpers the Windows sink uses.
    struct FailingSink<'a> {
        events: &'a mut EventLog,
        create: Option<EngineStart>,
        control: Option<IpcError>,
    }

    impl Sink for FailingSink<'_> {
        fn start_engine(&mut self) -> Result<(), EngineStart> {
            match self.create.take() {
                Some(failure) => {
                    self.events.record(Event::EngineCreateFail);
                    Err(failure)
                }
                None => {
                    self.events.record(Event::EngineCreateOk);
                    Ok(())
                }
            }
        }
        fn send_control(&mut self, _text: &str) -> Result<(), IpcError> {
            match self.control.take() {
                Some(failure) => {
                    record_ipc(self.events, failure);
                    Err(failure)
                }
                None => Ok(()),
            }
        }
        fn send_packet(&mut self, _packet: &[u8]) -> Result<(), IpcError> {
            Ok(())
        }
        fn flush(&mut self) -> Result<(), IpcError> {
            Ok(())
        }
        fn open_device(&mut self, _address: &str, _peers: &[String]) -> Result<(), String> {
            self.events.record(Event::DeviceOpenFail);
            Err("cannot open the overlay device".to_string())
        }
        fn close_device(&mut self) {}
        fn save_config(&mut self, _config: &PairedConfig) -> Result<(), ()> {
            Ok(())
        }
        fn mark_pending(&mut self) -> Result<(), MarkerFailure> {
            Ok(())
        }
        fn clear_pending(&mut self) -> Result<(), ()> {
            Ok(())
        }
        fn publish(&mut self, _snapshot: &Snapshot) {}
        fn stop(&mut self) {}
    }

    fn log_lines(dir: &TestDir, pid: u32) -> String {
        std::fs::read_to_string(dir.path().join(format!("vpn-{pid}.log"))).unwrap()
    }

    #[test]
    fn engine_start_failure_is_not_reported_as_a_closed_stream() {
        let dir = TestDir::create("runtime-log-create");
        let mut events = EventLog::open(dir.path(), 71);
        let mut dispatcher = Dispatcher::new();
        let config = PairedConfig {
            address: "10.0.0.2".to_string(),
            receiver_address: "10.0.0.1".to_string(),
            receiver_key: "00".repeat(32),
        };
        let mut session = Session::new("seed", Some(config), false, None, None);
        let mut sink = FailingSink {
            events: &mut events,
            create: Some(EngineStart::Failed),
            control: None,
        };
        let actions = session.command(Command::Connect);
        dispatcher.apply(&mut session, &mut sink, actions);
        drop(sink);
        let text = log_lines(&dir, 71);
        assert!(text.contains("engine:create-fail"), "{text}");
        assert!(
            !text.contains("engine:ipc-closed"),
            "start failure faked as IPC close: {text}"
        );
        assert_eq!(session.snapshot().phase, crate::state::Phase::Failed);
        assert_eq!(
            session.snapshot().error.map(|error| error.code),
            Some(crate::state::ErrorCode::EngineFailed)
        );
    }

    #[test]
    fn congestion_is_reported_as_congestion() {
        let dir = TestDir::create("runtime-log-congested");
        let mut events = EventLog::open(dir.path(), 72);
        let mut sink = FailingSink {
            events: &mut events,
            create: None,
            control: Some(IpcError::Congested),
        };
        assert!(sink.send_control("x").is_err());
        drop(sink);
        let text = log_lines(&dir, 72);
        assert!(text.contains("engine:congested"), "{text}");
        assert!(!text.contains("engine:ipc-closed"), "{text}");
    }

    #[test]
    fn device_open_failure_has_its_own_code() {
        let dir = TestDir::create("runtime-log-device");
        let mut events = EventLog::open(dir.path(), 73);
        let mut sink = FailingSink {
            events: &mut events,
            create: None,
            control: None,
        };
        assert!(sink.open_device("10.0.0.1", &[]).is_err());
        drop(sink);
        assert!(log_lines(&dir, 73).contains("device:open-fail"));
    }
}
