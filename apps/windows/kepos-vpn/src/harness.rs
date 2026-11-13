//! Support for the Windows isolation harness.
//!
//! The harness runs the real packed worklet, the real IPC and the real frame
//! codec outside the installed application, with a synthetic identity and a
//! synthetic configuration whose DHT bootstrap is a single loopback address. It
//! never reads the installed application, the identity directory or the
//! receiver. Everything here is pure so it can be checked on any host.
//!
//! Network isolation is by configuration only: `hyperdht` uses the configured
//! bootstrap list instead of its public default, so the only destination the
//! engine is told about is `127.0.0.1:1`. That is not a proof that nothing else
//! happens on the machine: the runtime still binds local UDP sockets, and a
//! service listening on port 1 would receive the packets.

use serde_json::json;

use crate::config::PairedConfig;

/// Synthetic seed for the worklet `start` message. Fixed so a run is
/// reproducible and never derived from a real identity.
pub const SYNTHETIC_SEED: &str = "1111111111111111111111111111111111111111111111111111111111111111";
/// Synthetic receiver key: not a real peer, so dialling it can only fail.
pub const SYNTHETIC_RECEIVER_KEY: &str =
    "2222222222222222222222222222222222222222222222222222222222222222";
/// The loopback address the harness points the DHT at, on a port the harness
/// has just observed to be unbound. `hyperdht` replaces its public bootstrap
/// list with this one, so no public node is configured.
pub fn loopback_bootstrap(port: u16) -> String {
    format!("127.0.0.1:{port}")
}

/// The listen outcome the test-only bundle should exercise. It is encoded in
/// this device's synthetic overlay address, which the fake DHT never routes on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario {
    Success,
    Reject,
    Pending,
}

impl Scenario {
    pub fn label(self) -> &'static str {
        match self {
            Scenario::Success => "success",
            Scenario::Reject => "reject",
            Scenario::Pending => "pending",
        }
    }

    fn address(self) -> &'static str {
        match self {
            Scenario::Success => "198.18.0.1",
            Scenario::Reject => "198.18.0.2",
            Scenario::Pending => "198.18.0.3",
        }
    }
}

/// The synthetic paired configuration with a single loopback bootstrap.
pub fn synthetic_config(port: u16, scenario: Scenario) -> String {
    let paired = PairedConfig {
        address: scenario.address().to_string(),
        receiver_address: "198.18.0.254".to_string(),
        receiver_key: SYNTHETIC_RECEIVER_KEY.to_string(),
    };
    let mut toml = paired
        .tunnel_toml()
        .expect("synthetic configuration is valid");
    toml.push_str(&format!(
        "[network]\nbootstrap = [\"{}\"]\n",
        loopback_bootstrap(port)
    ));
    toml
}

/// The worklet `start` message, byte-identical in shape to the one the session
/// sends. Diagnostics stay opt-in and fixed-code only.
pub fn start_message(config: &str, seed: &str) -> String {
    json!({ "type": "start", "config": config, "seed": seed, "caps": ["diag"] }).to_string()
}

/// The `ready` message that acknowledges `settings`.
pub fn ready_message() -> String {
    json!({ "type": "ready" }).to_string()
}

/// The only stage labels the harness will print or count. Anything else a frame
/// carries is dropped, so no string from the worklet can reach the output.
pub const STAGES: &[&str] = &[
    "config",
    "peers",
    "tun",
    "dht",
    "listen",
    "listen-return",
    "listen-reject",
    "startup-reject",
    "cleanup-begin",
    "cleanup-end",
    "settings-sent",
    "ready",
];

/// Map a stage name to the fixed label with the same spelling, or nothing.
pub fn stage(name: &str) -> Option<&'static str> {
    STAGES.iter().copied().find(|known| *known == name)
}

/// A decoded control frame the harness distinguishes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Control {
    Settings,
    Running,
    Stopped,
    /// `stage` is a fixed label from [`STAGES`], or `"unknown"`.
    Error {
        stage: &'static str,
    },
    /// Only fixed labels from [`STAGES`]; unknown names are dropped.
    Diag {
        stages: Vec<&'static str>,
    },
    Other,
}

/// Classify one control payload. Unknown shapes are `Other`, unknown stage names
/// are dropped, and no string from the frame is echoed.
pub fn classify(payload: &[u8]) -> Control {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return Control::Other;
    };
    match value.get("type").and_then(|v| v.as_str()) {
        Some("settings") => Control::Settings,
        Some("running") => Control::Running,
        Some("stopped") => Control::Stopped,
        Some("error") => Control::Error {
            stage: value
                .get("stage")
                .and_then(|v| v.as_str())
                .and_then(stage)
                .unwrap_or("unknown"),
        },
        Some("diag") => Control::Diag {
            stages: value
                .get("stages")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str())
                        .filter_map(stage)
                        .collect()
                })
                .unwrap_or_default(),
        },
        _ => Control::Other,
    }
}

/// How the run stopped reading. End of stream and timeout are different
/// observations and are never merged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum End {
    /// The harness stopped on a terminal control frame.
    #[default]
    Terminal,
    Eof,
    Timeout,
    /// The harness itself stopped: a frame, read or write failed.
    Aborted,
}

/// What one harness run observed. Only observed events count; nothing here
/// infers a state from a missing stage, because the diagnostic channel is
/// best-effort and a dropped frame is not evidence.
#[derive(Debug, Default)]
pub struct Observation {
    pub settings: bool,
    pub ready_sent: bool,
    pub running: bool,
    pub stopped: bool,
    pub error: Option<&'static str>,
    pub end: End,
    pub packets: u64,
    /// Fixed stage labels, in the order the worklet reported them.
    pub stages: Vec<&'static str>,
}

impl Observation {
    /// The last stage the worklet reported, if any.
    pub fn last_stage(&self) -> Option<&'static str> {
        self.stages.last().copied()
    }

    /// The fixed verdict label: a real outcome when one was observed, otherwise
    /// the last stage plus how the run stopped, which is a statement about the
    /// observation and not about the engine.
    pub fn verdict(&self) -> String {
        if self.running {
            return "settings-running".to_string();
        }
        if let Some(stage) = self.error {
            return format!("settings-error-{stage}");
        }
        if self.stopped {
            return "settings-stopped".to_string();
        }
        let end = match self.end {
            End::Eof => "eof",
            End::Timeout => "timeout",
            End::Aborted => "aborted",
            End::Terminal => "no-end",
        };
        if !self.settings {
            return format!("no-settings-{end}");
        }
        match self.last_stage() {
            Some(stage) => format!("last-observed-{stage}-{end}"),
            None => format!("no-stage-{end}"),
        }
    }

    /// True only when the run observed a real engine outcome. A stage without a
    /// terminal frame is not an outcome, and a timeout says nothing about the
    /// engine.
    pub fn outcome_known(&self) -> bool {
        self.running || self.error.is_some() || self.stopped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_config_is_loopback_only() {
        let toml = synthetic_config(1, Scenario::Success);
        assert!(toml.contains("[network]"));
        assert!(toml.contains("bootstrap = [\"127.0.0.1:1\"]"));
        assert!(!toml.contains("bootstrap.holepunch.to"));
        assert!(toml.contains(SYNTHETIC_RECEIVER_KEY));
        assert!(toml.contains("address = \"198.18.0.1\""));
    }

    #[test]
    fn synthetic_config_keeps_the_peer_table_first() {
        let toml = synthetic_config(1, Scenario::Success);
        assert!(toml.starts_with("peers = [{ label = \"receiver\""));
        // The bootstrap table must come after the peer and vpn tables, so it
        // cannot swallow their keys.
        let bootstrap = toml.find("[network]").unwrap();
        assert!(bootstrap > toml.find("[vpn]").unwrap());
    }

    #[test]
    fn the_bootstrap_port_is_the_one_the_harness_checked() {
        let toml = synthetic_config(54321, Scenario::Success);
        assert!(toml.contains("bootstrap = [\"127.0.0.1:54321\"]"));
        assert_eq!(loopback_bootstrap(54321), "127.0.0.1:54321");
    }

    #[test]
    fn each_scenario_has_its_own_address() {
        for scenario in [Scenario::Success, Scenario::Reject, Scenario::Pending] {
            let toml = synthetic_config(1, scenario);
            assert!(toml.contains(&format!("address = \"{}\"", scenario.address())));
            assert!(!toml.contains("address = \"198.18.0.254\"\npeers"));
        }
        assert_ne!(Scenario::Reject.address(), Scenario::Pending.address());
        assert_eq!(Scenario::Reject.label(), "reject");
    }

    #[test]
    fn start_message_requests_diagnostics_only() {
        let message = start_message("cfg", SYNTHETIC_SEED);
        let value: serde_json::Value = serde_json::from_str(&message).unwrap();
        assert_eq!(value["type"], "start");
        assert_eq!(value["config"], "cfg");
        assert_eq!(value["seed"], SYNTHETIC_SEED);
        assert_eq!(value["caps"], serde_json::json!(["diag"]));
    }

    #[test]
    fn classify_distinguishes_fixed_types() {
        assert_eq!(
            classify(br#"{"type":"settings","publicKey":"00"}"#),
            Control::Settings
        );
        assert_eq!(classify(br#"{"type":"running"}"#), Control::Running);
        assert_eq!(classify(br#"{"type":"stopped"}"#), Control::Stopped);
        assert_eq!(
            classify(br#"{"type":"error","stage":"listen"}"#),
            Control::Error { stage: "listen" }
        );
        assert_eq!(
            classify(br#"{"type":"diag","stages":["listen","listen-return"]}"#),
            Control::Diag {
                stages: vec!["listen", "listen-return"]
            }
        );
        assert_eq!(classify(b"not json"), Control::Other);
        assert_eq!(classify(br#"{"type":"unknown"}"#), Control::Other);
    }

    #[test]
    fn classify_drops_unknown_stage_strings() {
        // A stage that is not a fixed label is discarded, never echoed, so no
        // value from the worklet can appear in the output.
        assert_eq!(
            classify(br#"{"type":"diag","stages":["listen","seed=1111","../../secret",""]}"#),
            Control::Diag {
                stages: vec!["listen"]
            }
        );
        assert_eq!(
            classify(br#"{"type":"error","stage":"198.18.0.2"}"#),
            Control::Error { stage: "unknown" }
        );
        assert_eq!(
            classify(br#"{"type":"error","stage":42}"#),
            Control::Error { stage: "unknown" }
        );
        assert_eq!(
            classify(br#"{"type":"diag","stages":[1,null,{}]}"#),
            Control::Diag { stages: vec![] }
        );
    }

    #[test]
    fn a_missing_stage_is_never_an_outcome() {
        let mut observation = Observation::default();
        observation.settings = true;
        observation.ready_sent = true;
        observation.stages = vec!["listen"];

        // End of stream after entering `listen` says only what was last seen.
        observation.end = End::Eof;
        assert_eq!(observation.verdict(), "last-observed-listen-eof");
        assert!(!observation.outcome_known());

        // A timeout is a different observation and is not merged with it.
        observation.end = End::Timeout;
        assert_eq!(observation.verdict(), "last-observed-listen-timeout");
        assert!(!observation.outcome_known());

        // A rejection without `cleanup-end` is not "cleanup pending".
        observation.stages = vec!["listen", "listen-reject"];
        assert_eq!(observation.verdict(), "last-observed-listen-reject-timeout");
        assert!(!observation.outcome_known());
    }

    #[test]
    fn only_observed_outcomes_are_known() {
        let mut observation = Observation::default();
        assert_eq!(observation.verdict(), "no-settings-no-end");
        assert!(!observation.outcome_known());

        observation.end = End::Eof;
        assert_eq!(observation.verdict(), "no-settings-eof");

        observation.settings = true;
        assert_eq!(observation.verdict(), "no-stage-eof");
        assert!(!observation.outcome_known());

        observation.error = Some("listen");
        assert_eq!(observation.verdict(), "settings-error-listen");
        assert!(observation.outcome_known());

        observation.running = true;
        assert_eq!(observation.verdict(), "settings-running");

        observation.running = false;
        observation.error = None;
        observation.stopped = true;
        assert_eq!(observation.verdict(), "settings-stopped");
        assert!(observation.outcome_known());
    }

    #[test]
    fn stage_names_are_a_fixed_list() {
        assert_eq!(stage("listen"), Some("listen"));
        assert_eq!(stage("listen-return"), Some("listen-return"));
        assert_eq!(stage("Listen"), None);
        assert_eq!(stage(""), None);
        assert_eq!(stage("2222222222"), None);
    }
}
