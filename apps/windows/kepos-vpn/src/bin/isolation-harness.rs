//! Windows isolation harness for the hosted worklet.
//!
//! Runs the real packed worklet, the real IPC and the real frame codec with a
//! synthetic identity and a loopback-only configuration, then reports the fixed
//! events it observed. It never opens a TUN device (packet frames are counted
//! and dropped), never pairs, never adds a route, and never reads the installed
//! application, the identity directory or a receiver.
//!
//! Usage: `isolation-harness.exe --bundle <kepos-worklet.bundle> [--timeout-ms N]`
//!
//! Exit codes: 0 the engine reported a real outcome (`running`, `error` or
//! `stopped`), 1 no outcome was observed, 2 the harness could not run. A run
//! that ends at end of stream or at the timeout exits 1 even when it printed
//! stages: a missing stage is not evidence, because the diagnostic channel is
//! best-effort.

#[cfg(not(windows))]
fn main() {
    eprintln!("isolation-harness runs on Windows only");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    std::process::exit(run());
}

#[cfg(windows)]
fn run() -> i32 {
    use std::io::Write as _;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use kepos_vpn::framing::{Frame, FrameDecoder, CONTROL, PACKET};
    use kepos_vpn::harness::{self, Control, End, Observation};
    use kepos_vpn::worklet::HostedWorklet;

    let mut args = std::env::args().skip(1);
    let mut bundle: Option<PathBuf> = None;
    let mut timeout_ms: u64 = 30_000;
    let mut dht_mode: Option<String> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bundle" => bundle = args.next().map(PathBuf::from),
            "--timeout-ms" => {
                timeout_ms = match args.next().and_then(|value| value.parse().ok()) {
                    Some(value) => value,
                    None => {
                        println!("EVENT harness-error timeout-arg");
                        return 2;
                    }
                }
            }
            "--dht" => match args.next().as_deref() {
                Some(mode @ ("success" | "reject" | "pending")) => {
                    dht_mode = Some(mode.to_string())
                }
                _ => {
                    println!("EVENT harness-error dht-arg");
                    return 2;
                }
            },
            _ => {
                println!("EVENT harness-error unknown-arg");
                return 2;
            }
        }
    }
    let Some(bundle) = bundle else {
        println!("EVENT harness-error missing-bundle");
        return 2;
    };
    let event = |label: &str| {
        println!("EVENT {label}");
        let _ = std::io::stdout().flush();
    };

    event("harness-start");
    let mut worklet = match HostedWorklet::create(&bundle) {
        Ok(worklet) => worklet,
        Err(_) => {
            event("create-fail");
            return 2;
        }
    };
    event("create-ok");

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let write_all = |worklet: &HostedWorklet, bytes: &[u8]| -> bool {
        let mut offset = 0;
        while offset < bytes.len() {
            if Instant::now() >= deadline {
                return false;
            }
            match worklet.write(&bytes[offset..]) {
                Ok(Some(0)) | Ok(None) => std::thread::sleep(Duration::from_millis(2)),
                Ok(Some(written)) => offset += written,
                Err(_) => return false,
            }
        }
        true
    };

    // Keep a loopback socket of our own for the whole run. The configured
    // bootstrap points at it, so every datagram the engine would send to its
    // bootstrap arrives here and is counted. With the fake DHT nothing is
    // created and the count stays zero.
    // The sink always takes an ephemeral loopback port: no fixed system port is
    // claimed, and the scenario is carried by the synthetic overlay address.
    let scenario = match dht_mode.as_deref() {
        Some("reject") => Some(harness::Scenario::Reject),
        Some("pending") => Some(harness::Scenario::Pending),
        Some("success") => Some(harness::Scenario::Success),
        _ => None,
    };
    if let Some(scenario) = scenario {
        event(&format!("dht-mode {}", scenario.label()));
    }
    let sink = match std::net::UdpSocket::bind(("127.0.0.1", 0)) {
        Ok(socket) => {
            let _ = socket.set_nonblocking(true);
            Some(socket)
        }
        Err(_) => {
            event("sink-bind-failed");
            None
        }
    };
    let bootstrap_port = match sink.as_ref().and_then(|socket| socket.local_addr().ok()) {
        Some(address) => address.port(),
        None => {
            event("harness-error port-unavailable");
            return 2;
        }
    };
    event(&format!("bootstrap 127.0.0.1:{bootstrap_port}"));

    let start = harness::start_message(
        &harness::synthetic_config(
            bootstrap_port,
            scenario.unwrap_or(harness::Scenario::Success),
        ),
        harness::SYNTHETIC_SEED,
    );
    let Ok(frame) = Frame::control(start.into_bytes()).encode() else {
        event("harness-error start-encode");
        return 2;
    };
    if !write_all(&worklet, &frame) {
        event("start-write-fail");
        return 2;
    }
    event("start-sent");

    let mut observation = Observation::default();
    let mut decoder = FrameDecoder::new();
    let mut buffer = [0u8; 4096];
    'outer: loop {
        if Instant::now() >= deadline {
            observation.end = End::Timeout;
            event("timeout");
            break;
        }
        match worklet.read(&mut buffer) {
            Ok(None) => {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            Ok(Some(0)) => {
                observation.end = End::Eof;
                event("ipc-eof");
                break;
            }
            Ok(Some(read)) => {
                if decoder.push(&buffer[..read]).is_err() {
                    observation.end = End::Aborted;
                    event("frame-decode-fail");
                    break;
                }
                while let Ok(Some(frame)) = decoder.next_frame() {
                    match frame.kind {
                        PACKET => {
                            // Fake device: counted and dropped, never routed.
                            observation.packets += 1;
                        }
                        CONTROL => match harness::classify(&frame.payload) {
                            Control::Settings => {
                                observation.settings = true;
                                event("settings");
                                let ready =
                                    Frame::control(harness::ready_message().into_bytes()).encode();
                                let Ok(ready) = ready else {
                                    observation.end = End::Aborted;
                                    event("harness-error ready-encode");
                                    break 'outer;
                                };
                                if !write_all(&worklet, &ready) {
                                    observation.end = End::Aborted;
                                    event("ready-write-fail");
                                    break 'outer;
                                }
                                observation.ready_sent = true;
                                event("ready-sent");
                            }
                            Control::Running => {
                                observation.running = true;
                                event("running");
                                break 'outer;
                            }
                            Control::Stopped => {
                                observation.stopped = true;
                                event("stopped");
                                break 'outer;
                            }
                            Control::Error { stage } => {
                                event(&format!("error {stage}"));
                                observation.error = Some(stage);
                                break 'outer;
                            }
                            Control::Diag { stages } => {
                                for stage in stages {
                                    event(&format!("diag {stage}"));
                                    observation.stages.push(stage);
                                }
                            }
                            Control::Other => event("control-other"),
                        },
                        _ => event("frame-unknown-kind"),
                    }
                }
            }
            Err(_) => {
                observation.end = End::Aborted;
                event("ipc-read-fail");
                break;
            }
        }
    }

    // Drain the sink. A zero count means only that this socket received
    // nothing; it is not evidence about any other network activity.
    let mut sink_datagrams = 0u64;
    if let Some(socket) = sink.as_ref() {
        let mut buffer = [0u8; 2048];
        while matches!(socket.recv(&mut buffer), Ok(_)) {
            sink_datagrams += 1;
        }
    }
    event(&format!("sink-datagrams {sink_datagrams}"));

    let verdict = observation.verdict();
    event(&format!("packets-dropped {}", observation.packets));
    event(&format!(
        "last-stage {}",
        observation.last_stage().unwrap_or("none")
    ));
    event(&format!("verdict {verdict}"));

    // Bounded cleanup. `exit-unobserved` must never be read as "did not
    // exit": it only says the exit callback had not run yet. The worklet is
    // given a bounded wait after the IPC ends, then terminated, and the exit
    // code is read again afterwards.
    let exited_before_end = worklet.exit_code();
    if let Some(code) = exited_before_end {
        event(&format!("exit-before-end {code}"));
    }
    worklet.end();
    let mut waited = Duration::ZERO;
    while worklet.exit_code().is_none() && waited < Duration::from_millis(5_000) {
        std::thread::sleep(Duration::from_millis(20));
        waited += Duration::from_millis(20);
    }
    match worklet.exit_code() {
        Some(code) => event(&format!("exit-after-end {code}")),
        None => {
            event("exit-after-end unobserved");
            let _ = worklet.terminate_and_wait(Duration::from_millis(2_000));
            match worklet.exit_code() {
                Some(code) => event(&format!("exit-forced {code}")),
                None => {
                    // The runtime may still be alive. Say so instead of
                    // implying a clean shutdown, and keep the process alive
                    // until the OS reclaims the worklet.
                    event("exit-forced unobserved");
                    event("warning worklet-exit-unconfirmed");
                }
            }
        }
    }
    event("harness-end");

    if observation.outcome_known() {
        0
    } else {
        1
    }
}
