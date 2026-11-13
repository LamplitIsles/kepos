//! Threads and I/O around the state machine.
//!
//! The worker owns the session, the worklet and the overlay device, and hands
//! every action to the platform-independent [`Dispatcher`]. Two lifecycle rules
//! shape this module:
//! * The worklet bridge cannot be reused (the shared bridge moves to `starting`
//!   on `pair` and to `stopped` after `stop`), so one worklet serves exactly one
//!   attempt and is retired as soon as the session is idle again.
//! * The identity lock is released only after the worklet confirmed its exit. An
//!   unconfirmed exit keeps the lock and stops the backend.

#![cfg(windows)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::config::PairedConfig;
use crate::device::OverlayDevice;
use crate::dispatch::{Dispatcher, EngineStart, IpcError, Sink};
use crate::eventlog::{Event as LogEvent, EventLog};
use crate::framing::{Frame, FrameDecoder, CONTROL, PACKET};
use crate::identity::{self, IdentityLock};
use crate::outbox::{FrameWriter, Outbox};
use crate::paths::StatePaths;
use crate::pending::PendingPair;
use crate::random::{OsRandom, SeedSource};
use crate::session::{Action, Command, Event, MarkerFailure, Session};
use crate::state::{ErrorCode, Snapshot};
use crate::worklet::{CreateError, HostedWorklet};

pub struct BackendOptions {
    pub paths: StatePaths,
    /// Absolute path of the packed worklet bundle.
    pub bundle: PathBuf,
    /// Random source for a new identity. Defaults to the operating system's.
    pub seed_source: Arc<dyn SeedSource>,
}

impl BackendOptions {
    pub fn new(paths: StatePaths, bundle: impl Into<PathBuf>) -> Self {
        Self {
            paths,
            bundle: bundle.into(),
            seed_source: Arc::new(OsRandom),
        }
    }
}

/// How often the worker checks for commands and pending work while idle.
const IDLE_TICK: Duration = Duration::from_millis(10);
/// Upper bound on worklet read attempts per tick.
const READ_BUDGET: usize = 8;
/// Upper bound on overlay packets taken per tick, so one busy device cannot
/// starve the command channel.
const DEVICE_READ_BUDGET: usize = 64;
/// Upper bound on queued bytes for the worklet.
const MAX_OUTBOX: usize = 64 * 1024;
/// How long a terminating worklet is given to report its exit.
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the identity query may wait for its reply.
const IDENTITY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Backend {
    snapshot: Arc<Mutex<Snapshot>>,
    commands: Sender<Command>,
    /// Cleared once the worker has stopped, so the tray can tell a dead
    /// backend from a busy one.
    alive: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

/// A command could not be delivered because the worker is no longer running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandError {
    NotRunning,
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRunning => write!(f, "the VPN backend is no longer running"),
        }
    }
}

impl std::error::Error for CommandError {}

impl Backend {
    /// Load or create the identity, take the identity lock and start the worker.
    pub fn start(options: BackendOptions) -> Result<Self, BackendError> {
        let lock = IdentityLock::acquire(&options.paths.lock()).map_err(|error| match error {
            identity::IdentityError::InUse => BackendError::IdentityInUse,
            _ => BackendError::StateInvalid,
        })?;
        let (identity, _created) =
            identity::load_or_create(&options.paths.identity(), options.seed_source.as_ref())
                .map_err(|error| match error {
                    identity::IdentityError::InUse => BackendError::IdentityInUse,
                    identity::IdentityError::NoEntropy(_) => BackendError::NoEntropy,
                    _ => BackendError::StateInvalid,
                })?;
        let config =
            PairedConfig::load(&options.paths.config()).map_err(|_| BackendError::StateInvalid)?;
        // A marker that exists but cannot be read must not read as "absent".
        let (pairing_unknown, startup_error) =
            match PendingPair::read(&options.paths.pending_pair()) {
                Ok(None) => (false, None),
                Ok(Some(_)) => (true, None),
                Err(_) => (
                    true,
                    Some(crate::state::ErrorState::new(ErrorCode::StateInvalid)),
                ),
            };

        let session = Session::new(
            identity.seed().to_string(),
            config,
            pairing_unknown,
            None,
            startup_error,
        );
        let snapshot = Arc::new(Mutex::new(session.snapshot()));
        let (commands, receiver) = mpsc::channel();

        let alive = Arc::new(AtomicBool::new(true));
        let worker_snapshot = Arc::clone(&snapshot);
        let worker_alive = Arc::clone(&alive);
        let worker = thread::Builder::new()
            .name("kepos-vpn".into())
            .spawn(move || {
                let mut worker = Worker::new(
                    session,
                    options.paths,
                    options.bundle,
                    worker_snapshot,
                    receiver,
                );
                let released = worker.run();
                worker_alive.store(false, Ordering::SeqCst);
                if released {
                    drop(lock);
                } else {
                    // Keep the lock: another instance must not take over while
                    // the previous runtime may still be alive.
                    std::mem::forget(lock);
                }
            })
            .map_err(|error| BackendError::Spawn(error.to_string()))?;

        Ok(Self {
            snapshot,
            commands,
            alive,
            worker: Some(worker),
        })
    }

    /// The current tray-visible state.
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| Snapshot::idle(None))
    }

    /// True while the worker is running. Once it has stopped, commands fail and
    /// the tray should ask the user to restart the application.
    pub fn is_running(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Issue a command and report synchronously whether it was delivered.
    ///
    /// The tray must use this (or `is_running`) so a menu action on a stopped
    /// backend is visible instead of silently doing nothing.
    pub fn try_command(&self, command: Command) -> Result<(), CommandError> {
        if !self.is_running() {
            return Err(CommandError::NotRunning);
        }
        self.commands
            .send(command)
            .map_err(|_| CommandError::NotRunning)
    }

    /// Stop the tunnel and wait for the worker. Safe to call twice.
    pub fn shutdown(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Worker {
    session: Session,
    paths: StatePaths,
    bundle: PathBuf,
    snapshot: Arc<Mutex<Snapshot>>,
    commands: Receiver<Command>,
    worklet: Option<HostedWorklet>,
    device: Option<OverlayDevice>,
    decoder: FrameDecoder,
    outbox: Outbox,
    identity_pending: Option<Instant>,
    /// Bounded, secret-free runtime diagnostics.
    events: EventLog,
    /// Outbox offset where the ready frame ends, and whether its bytes were all
    /// handed to the IPC.
    ready_end: Option<usize>,
    ready_written: bool,
    ready_pending: bool,
    /// The worklet did not confirm its exit; the identity must stay locked.
    exit_unconfirmed: bool,
    running: bool,
}

impl Worker {
    fn new(
        session: Session,
        paths: StatePaths,
        bundle: PathBuf,
        snapshot: Arc<Mutex<Snapshot>>,
        commands: Receiver<Command>,
    ) -> Self {
        let mut events = EventLog::open(&paths.logs(), std::process::id());
        events.record(LogEvent::Start);
        Self {
            session,
            paths,
            bundle,
            snapshot,
            commands,
            worklet: None,
            device: None,
            decoder: FrameDecoder::new(),
            outbox: Outbox::new(MAX_OUTBOX),
            identity_pending: None,
            events,
            ready_end: None,
            ready_written: false,
            ready_pending: false,
            exit_unconfirmed: false,
            running: true,
        }
    }

    /// Run until shutdown. Returns whether the identity lock may be released.
    fn run(&mut self) -> bool {
        let mut dispatcher = Dispatcher::new();
        self.identity_pending = Some(Instant::now() + IDENTITY_TIMEOUT);
        let identify = vec![self.session.identify()];
        self.dispatch(&mut dispatcher, identify);

        while self.running && !dispatcher.stopped() && dispatcher.fatal().is_none() {
            match self.commands.try_recv() {
                Ok(command) => {
                    let actions = self.session.command(command);
                    self.dispatch(&mut dispatcher, actions);
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    let actions = self.session.command(Command::Shutdown);
                    self.dispatch(&mut dispatcher, actions);
                    break;
                }
            }
            if dispatcher.stopped() || dispatcher.fatal().is_some() {
                break;
            }
            // Overlay -> worklet every tick, independent of the worklet.
            let packets = self.drain_device(&mut dispatcher);
            if !packets.is_empty() {
                self.dispatch(&mut dispatcher, packets);
            }
            self.pump_worklet(&mut dispatcher);
            self.settle_worklet();
            if !self.running {
                break;
            }
            thread::sleep(IDLE_TICK);
        }

        self.events.record(LogEvent::Shutdown);
        self.teardown(dispatcher.fatal())
    }

    fn dispatch(&mut self, dispatcher: &mut Dispatcher, actions: Vec<Action>) {
        crate::eventlog::record_phase(&mut self.events, self.session.snapshot().phase);
        let mut sink = WindowsSink {
            paths: &self.paths,
            bundle: &self.bundle,
            worklet: &mut self.worklet,
            device: &mut self.device,
            decoder: &mut self.decoder,
            outbox: &mut self.outbox,
            snapshot: &self.snapshot,
            exit_unconfirmed: &mut self.exit_unconfirmed,
            running: &mut self.running,
            events: &mut self.events,
            ready_end: &mut self.ready_end,
            ready_written: &mut self.ready_written,
            ready_pending: &mut self.ready_pending,
        };
        dispatcher.apply(&mut self.session, &mut sink, actions);
        crate::eventlog::record_phase(&mut self.events, self.session.snapshot().phase);
    }

    /// Retire the worklet once nothing is in flight.
    fn settle_worklet(&mut self) {
        if self.worklet.is_none() {
            return;
        }
        if self.session.busy() {
            return;
        }
        if let Some(deadline) = self.identity_pending {
            if Instant::now() < deadline {
                return;
            }
            self.identity_pending = None;
        }
        self.retire_worklet();
    }

    /// Stop and destroy the current worklet, waiting for it to exit.
    fn retire_worklet(&mut self) {
        if let Some(mut worklet) = self.worklet.take() {
            worklet.end();
            self.events.record(LogEvent::RetireBegin);
            let confirmed = worklet.terminate_and_wait(EXIT_TIMEOUT).is_ok();
            if let Some(code) = worklet.exit_code() {
                self.events.record(crate::eventlog::exit_event(code));
            }
            if confirmed {
                self.events.record(LogEvent::RetireConfirmed);
            } else {
                self.events.record(LogEvent::EngineExitTimeout);
                self.events.record(LogEvent::RetireUnconfirmed);
                self.exit_unconfirmed = true;
                self.running = false;
            }
        }
        self.events.record(LogEvent::RetireDone);
        self.decoder = FrameDecoder::new();
        self.outbox.clear();
        self.ready_end = None;
        self.ready_written = false;
        self.ready_pending = false;
    }

    fn pump_worklet(&mut self, dispatcher: &mut Dispatcher) {
        self.flush(dispatcher);
        if dispatcher.fatal().is_some() || dispatcher.stopped() {
            return;
        }
        let mut buffer = [0u8; 8 * 1024];
        for _ in 0..READ_BUDGET {
            let read = match self.worklet.as_ref() {
                Some(worklet) => match worklet.read(&mut buffer) {
                    Ok(Some(0)) => {
                        self.events.record(LogEvent::EngineReadEof);
                        self.note_worklet_end();
                        self.worklet_gone(dispatcher);
                        return;
                    }
                    Ok(Some(read)) => read,
                    Ok(None) => return,
                    Err(_) => {
                        self.events.record(LogEvent::EngineReadError);
                        self.note_worklet_end();
                        self.worklet_gone(dispatcher);
                        return;
                    }
                },
                None => return,
            };
            if self.decoder.push(&buffer[..read]).is_err() {
                self.events.record(LogEvent::EngineDecodeFail);
                self.worklet_gone(dispatcher);
                return;
            }
            loop {
                match self.decoder.next_frame() {
                    Ok(Some(frame)) => {
                        let actions = self.handle_frame(frame);
                        self.dispatch(dispatcher, actions);
                        if dispatcher.fatal().is_some() || dispatcher.stopped() {
                            return;
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        self.events.record(LogEvent::EngineDecodeFail);
                        self.worklet_gone(dispatcher);
                        return;
                    }
                }
            }
        }
    }

    /// Record what the exit callback had reported when the stream ended. An
    /// unobserved callback is recorded as such, never as "still running".
    fn note_worklet_end(&mut self) {
        match self
            .worklet
            .as_ref()
            .and_then(|worklet| worklet.exit_code())
        {
            Some(code) => {
                self.events.record(crate::eventlog::exit_event(code));
                self.events.record(LogEvent::EngineClosedExited);
            }
            None => self.events.record(LogEvent::EngineClosedUnobserved),
        }
    }

    fn worklet_gone(&mut self, dispatcher: &mut Dispatcher) {
        self.events.record(LogEvent::WorkletGone);
        self.identity_pending = None;
        let actions = self.session.event(Event::WorkletGone);
        self.dispatch(dispatcher, actions);
        self.retire_worklet();
    }

    fn handle_frame(&mut self, frame: Frame) -> Vec<Action> {
        match frame.kind {
            CONTROL => match serde_json::from_slice::<Value>(&frame.payload) {
                Ok(value) => {
                    for control in crate::eventlog::control_events(&frame.payload) {
                        self.events.record(control);
                    }
                    let actions = self.session.event(Event::WorkletControl(value));
                    if self.session.snapshot().public_key.is_some() {
                        self.identity_pending = None;
                    }
                    actions
                }
                Err(_) => self.session.event(Event::WorkletGone),
            },
            PACKET => self.forward_to_device(&frame.payload),
            _ => Vec::new(),
        }
    }

    fn forward_to_device(&mut self, packet: &[u8]) -> Vec<Action> {
        let Some(device) = self.device.as_ref() else {
            return Vec::new();
        };
        match device.send(packet) {
            Ok(_) => Vec::new(),
            Err(error) => {
                self.events.record(LogEvent::DeviceWriteFail);
                self.session
                    .event(Event::DeviceFailed(format!("device: {error}")))
            }
        }
    }

    /// Take pending overlay packets and hand them to the worklet.
    ///
    /// The adapter is read every tick, but a packet is only forwarded once the
    /// session is connected: reading continues during startup so nothing piles
    /// up, and what was read then is dropped rather than delivered late.
    fn drain_device(&mut self, dispatcher: &mut Dispatcher) -> Vec<Action> {
        let Some(device) = self.device.as_ref() else {
            return Vec::new();
        };
        let forward = crate::overlay::forwards(self.session.snapshot().phase);
        let drain = crate::overlay::drain(DEVICE_READ_BUDGET, forward, |buffer| {
            device.try_recv(buffer)
        });
        if let Some(error) = drain.failure {
            self.events.record(LogEvent::DeviceReadFail);
            let failure = self
                .session
                .event(Event::DeviceFailed(format!("device: {error}")));
            self.dispatch(dispatcher, failure);
        }
        drain.packets.into_iter().map(Action::SendPacket).collect()
    }

    /// Drain the outbox through the dispatcher, so a write error ends the
    /// attempt immediately instead of waiting for a next write that may never
    /// come (an idle connection or a pairing attempt sends nothing for a while).
    fn flush(&mut self, dispatcher: &mut Dispatcher) {
        if self.outbox.is_empty() {
            return;
        }
        let mut sink = WindowsSink {
            paths: &self.paths,
            bundle: &self.bundle,
            worklet: &mut self.worklet,
            device: &mut self.device,
            decoder: &mut self.decoder,
            outbox: &mut self.outbox,
            snapshot: &self.snapshot,
            exit_unconfirmed: &mut self.exit_unconfirmed,
            running: &mut self.running,
            events: &mut self.events,
            ready_end: &mut self.ready_end,
            ready_written: &mut self.ready_written,
            ready_pending: &mut self.ready_pending,
        };
        dispatcher.flush(&mut self.session, &mut sink);
    }

    /// Stop the tunnel, wait for the worklet, and report whether the identity
    /// lock may be released.
    fn teardown(&mut self, fatal: Option<ErrorCode>) -> bool {
        if let Some(mut device) = self.device.take() {
            device.close();
        }
        self.retire_worklet();
        let current = self.session.snapshot();
        let error = if self.exit_unconfirmed || fatal.is_some() {
            Some(crate::state::ErrorState::new(ErrorCode::EngineFailed))
        } else {
            current.error.clone()
        };
        let phase = if error.is_some() {
            crate::state::Phase::Failed
        } else {
            crate::state::Phase::Idle
        };
        if let Ok(mut snapshot) = self.snapshot.lock() {
            *snapshot = current.reset(phase, error);
        }
        !self.exit_unconfirmed
    }
}

/// The Windows side effects behind the dispatcher.
struct WindowsSink<'a> {
    paths: &'a StatePaths,
    bundle: &'a PathBuf,
    worklet: &'a mut Option<HostedWorklet>,
    device: &'a mut Option<OverlayDevice>,
    decoder: &'a mut FrameDecoder,
    outbox: &'a mut Outbox,
    snapshot: &'a Arc<Mutex<Snapshot>>,
    exit_unconfirmed: &'a mut bool,
    running: &'a mut bool,
    events: &'a mut EventLog,
    /// Byte offset in the outbox at which the ready frame ends, once queued.
    ready_end: &'a mut Option<usize>,
    ready_written: &'a mut bool,
    ready_pending: &'a mut bool,
}

/// Adapts the hosted worklet to the outbox's writer trait.
struct WorkletWriter<'a>(&'a HostedWorklet);

impl FrameWriter for WorkletWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> Result<Option<usize>, ()> {
        self.0.write(bytes).map_err(|_| ())
    }
}

impl WindowsSink<'_> {
    fn queue(&mut self, frame: Frame) -> Result<(), IpcError> {
        if self.worklet.is_none() {
            self.events.record(LogEvent::EngineIpcClosed);
            return Err(IpcError::Closed);
        }
        if let Err(error) = self.outbox.queue(&frame) {
            crate::eventlog::record_ipc(self.events, error);
            return Err(error);
        }
        // Recorded before the flush below, so the immediate-write path is
        // covered as well as a later dispatcher flush.
        if std::mem::take(self.ready_pending) {
            *self.ready_end = Some(self.outbox.queued_total());
        }
        // Try to drain immediately so a failure is reported here rather than on
        // the next tick.
        let Some(worklet) = self.worklet.as_ref() else {
            self.events.record(LogEvent::EngineIpcClosed);
            return Err(IpcError::Closed);
        };
        let result = self.outbox.flush(&mut WorkletWriter(worklet));
        if let Err(error) = result {
            crate::eventlog::record_ipc(self.events, error);
        }
        // "Written" means the ready frame's last byte was handed to the IPC,
        // not that the outbox happens to be empty.
        if let Some(end) = *self.ready_end {
            if !*self.ready_written && self.outbox.written_total() >= end {
                *self.ready_written = true;
                self.events.record(LogEvent::ControlReadyWritten);
            }
        }
        result
    }
}

impl Sink for WindowsSink<'_> {
    fn start_engine(&mut self) -> Result<(), EngineStart> {
        if self.worklet.is_some() {
            return Ok(());
        }
        match HostedWorklet::create(self.bundle) {
            Ok(worklet) => {
                self.events.record(LogEvent::EngineCreateOk);
                *self.decoder = FrameDecoder::new();
                self.outbox.clear();
                *self.worklet = Some(worklet);
                Ok(())
            }
            Err(CreateError::StartFailed {
                exit_confirmed: false,
            }) => {
                // The 2 s wait after a failed start, not the 10 s retire wait.
                self.events.record(LogEvent::EngineStartExitUnconfirmed);
                *self.exit_unconfirmed = true;
                Err(EngineStart::ExitUnconfirmed)
            }
            Err(CreateError::StartFailed {
                exit_confirmed: true,
            }) => {
                self.events.record(LogEvent::EngineStartFail);
                Err(EngineStart::Failed)
            }
            Err(_) => {
                self.events.record(LogEvent::EngineCreateFail);
                Err(EngineStart::Failed)
            }
        }
    }

    fn send_control(&mut self, text: &str) -> Result<(), IpcError> {
        *self.ready_pending = crate::eventlog::is_ready_control(text);
        let result = self.queue(Frame::control(text.as_bytes().to_vec()));
        // `queue` only reports that the frame left our outbox, so this is
        // "queued", not "delivered".
        crate::eventlog::record_control_result(&mut self.events, text, result.is_ok());
        result
    }

    fn send_packet(&mut self, packet: &[u8]) -> Result<(), IpcError> {
        self.queue(Frame::packet(packet.to_vec()))
    }

    fn flush(&mut self) -> Result<(), IpcError> {
        let Some(worklet) = self.worklet.as_ref() else {
            self.events.record(LogEvent::EngineIpcClosed);
            self.outbox.clear();
            return Err(IpcError::Closed);
        };
        let result = self.outbox.flush(&mut WorkletWriter(worklet));
        if let Err(error) = result {
            crate::eventlog::record_ipc(self.events, error);
        }
        // "Written" means the ready frame's last byte was handed to the IPC,
        // not that the outbox happens to be empty.
        if let Some(end) = *self.ready_end {
            if !*self.ready_written && self.outbox.written_total() >= end {
                *self.ready_written = true;
                self.events.record(LogEvent::ControlReadyWritten);
            }
        }
        result
    }

    fn open_device(&mut self, address: &str, peer_addresses: &[String]) -> Result<(), String> {
        match OverlayDevice::open(address, peer_addresses) {
            Ok(device) => {
                self.events.record(LogEvent::DeviceOpenOk);
                *self.device = Some(device);
                Ok(())
            }
            Err(error) => {
                self.events.record(LogEvent::DeviceOpenFail);
                Err(error.to_string())
            }
        }
    }

    fn close_device(&mut self) {
        if let Some(mut device) = self.device.take() {
            device.close();
        }
    }

    fn save_config(&mut self, config: &PairedConfig) -> Result<(), ()> {
        config.save(&self.paths.config()).map_err(|error| {
            eprintln!("kepos: cannot save the paired configuration: {error}");
        })
    }

    fn mark_pending(&mut self) -> Result<(), MarkerFailure> {
        match PendingPair::new(unix_now()).write(&self.paths.pending_pair()) {
            Ok(()) => Ok(()),
            Err(crate::pending::PendingError::AlreadyPending) => Err(MarkerFailure::AlreadyPending),
            Err(error) => {
                eprintln!("kepos: cannot record the pairing attempt: {error}");
                Err(MarkerFailure::Storage)
            }
        }
    }

    fn clear_pending(&mut self) -> Result<(), ()> {
        PendingPair::clear(&self.paths.pending_pair()).map_err(|error| {
            eprintln!("kepos: cannot clear the pairing attempt: {error}");
        })
    }

    fn publish(&mut self, snapshot: &Snapshot) {
        if let Ok(mut current) = self.snapshot.lock() {
            *current = snapshot.clone();
        }
    }

    fn stop(&mut self) {
        *self.running = false;
    }
}
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

#[derive(Debug)]
pub enum BackendError {
    /// Another runtime already owns the identity.
    IdentityInUse,
    /// The identity or configuration state is unusable.
    StateInvalid,
    /// The system random source failed; no identity was created.
    NoEntropy,
    Spawn(String),
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IdentityInUse => write!(f, "peer identity is already in use"),
            Self::StateInvalid => write!(f, "peer state is unusable"),
            Self::NoEntropy => write!(f, "the system random source is unavailable"),
            Self::Spawn(message) => write!(f, "cannot start the VPN worker: {message}"),
        }
    }
}

impl std::error::Error for BackendError {}
