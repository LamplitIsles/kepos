//! Overlay to worklet packet policy.
//!
//! The adapter is still read on every tick while the tunnel is not up, but a
//! packet read before the session is `Connected` is dropped: the worklet
//! bridge only accepts packets once the engine is running. Reading continues
//! so the adapter is not left unread; it does not promise the adapter is
//! empty.
//!
//! Two limits are worth stating:
//! * One bounded drain only removes the packets it reads. A backlog larger
//!   than the per-tick budget can outlive the startup window, and what is left
//!   in the ring after the transition may still be forwarded. Draining
//!   unboundedly to prevent that would starve the rest of the tick, so it is
//!   not done; `leftover_backlog_survives_the_transition` records the limit.
//! * The gate opens when the host processes the worklet `running` frame, which
//!   is slightly after the bridge starts accepting packets. Packets arriving
//!   in that window are still dropped. That direction is safe, but the window
//!   exists.

use std::io;

use crate::state::Phase;

/// The result of one bounded read of the overlay adapter.
#[derive(Debug)]
pub struct Drain {
    /// Packets that may be handed to the worklet, in the order they were read.
    pub packets: Vec<Vec<u8>>,
    /// The first read failure, if the adapter reported one.
    pub failure: Option<io::Error>,
}

/// Whether a packet read from the overlay may be handed to the worklet.
pub fn forwards(phase: Phase) -> bool {
    phase == Phase::Connected
}

/// Read at most `budget` packets, forwarding only when the session itself says
/// the tunnel is connected. This is the exact decision the runtime uses.
pub fn drain_from<F>(session: &crate::session::Session, budget: usize, read: F) -> Drain
where
    F: FnMut(&mut [u8]) -> io::Result<usize>,
{
    drain(budget, forwards(session.snapshot().phase), read)
}

/// Read at most `budget` packets. The packets this call reads are taken out of
/// the adapter, but only a `forward`ing drain keeps them. Anything beyond
/// `budget` stays in the adapter and is read on a later tick.
pub fn drain<F>(budget: usize, forward: bool, mut read: F) -> Drain
where
    F: FnMut(&mut [u8]) -> io::Result<usize>,
{
    let mut buffer = [0u8; crate::framing::MTU];
    let mut packets = Vec::new();
    for _ in 0..budget {
        match read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if forward {
                    packets.push(buffer[..read].to_vec());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => {
                return Drain {
                    packets,
                    failure: Some(error),
                }
            }
        }
    }
    Drain {
        packets,
        failure: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(packets: Vec<Vec<u8>>) -> impl FnMut(&mut [u8]) -> io::Result<usize> {
        let mut remaining = packets.into_iter();
        move |buffer: &mut [u8]| match remaining.next() {
            Some(packet) => {
                buffer[..packet.len()].copy_from_slice(&packet);
                Ok(packet.len())
            }
            None => Err(io::ErrorKind::WouldBlock.into()),
        }
    }

    #[test]
    fn only_a_connected_session_forwards_packets() {
        assert!(forwards(Phase::Connected));
        assert!(!forwards(Phase::Connecting));
        assert!(!forwards(Phase::Idle));
    }

    #[test]
    fn packets_read_during_startup_are_taken_but_not_forwarded() {
        let drain = drain(64, false, source(vec![vec![1; 20], vec![2; 20]]));
        assert!(drain.packets.is_empty());
        assert!(drain.failure.is_none());
    }

    #[test]
    fn packets_read_after_the_session_is_connected_are_forwarded() {
        let drain = drain(64, true, source(vec![vec![1; 20], vec![2; 20]]));
        assert_eq!(drain.packets, vec![vec![1; 20], vec![2; 20]]);
    }

    #[test]
    fn the_read_budget_is_still_respected() {
        let packets = vec![vec![7u8; 20]; 5];
        let mut reads = 0;
        let mut remaining = packets.into_iter();
        let drain = drain(2, true, |buffer: &mut [u8]| {
            reads += 1;
            match remaining.next() {
                Some(packet) => {
                    buffer[..packet.len()].copy_from_slice(&packet);
                    Ok(packet.len())
                }
                None => Err(io::ErrorKind::WouldBlock.into()),
            }
        });
        assert_eq!(reads, 2);
        assert_eq!(drain.packets.len(), 2);
    }

    #[test]
    fn a_real_session_gates_the_runtime_drain() {
        use serde_json::json;

        use crate::config::PairedConfig;
        use crate::session::{Command, Event, Session};

        let config = PairedConfig {
            address: "198.18.0.1".to_string(),
            receiver_address: "198.18.0.254".to_string(),
            receiver_key: "22".repeat(32),
        };
        let mut session = Session::new("11".repeat(32), Some(config), false, None, None);
        session.command(Command::Connect);
        let queued = vec![vec![1u8; 20], vec![2u8; 20]];
        let reader = |packets: Vec<Vec<u8>>| {
            let mut remaining = packets.into_iter();
            move |buffer: &mut [u8]| match remaining.next() {
                Some(packet) => {
                    buffer[..packet.len()].copy_from_slice(&packet);
                    Ok(packet.len())
                }
                None => Err(io::ErrorKind::WouldBlock.into()),
            }
        };

        // The session is connecting: what the adapter holds is read and dropped.
        let starting = drain_from(&session, 64, reader(queued.clone()));
        assert!(starting.packets.is_empty());

        session.event(Event::WorkletControl(json!({ "type": "running" })));
        assert_eq!(session.snapshot().phase, Phase::Connected);

        // Once the session is connected the same drain produces the packets the
        // runtime turns into `Action::SendPacket`.
        let connected = drain_from(&session, 64, reader(queued.clone()));
        assert_eq!(connected.packets, queued);
    }

    #[test]
    fn leftover_backlog_survives_the_transition() {
        // A backlog larger than one tick's budget is not cleared by a single
        // startup drain: the packet that was still queued is read on the next
        // tick, when the session is already connected, and is forwarded. The
        // fix therefore removes the packets it reads during startup, not every
        // packet that was queued then.
        let mut queued = vec![vec![1u8; 20], vec![2u8; 20], vec![3u8; 20]].into_iter();
        let mut read = move |buffer: &mut [u8]| match queued.next() {
            Some(packet) => {
                buffer[..packet.len()].copy_from_slice(&packet);
                Ok(packet.len())
            }
            None => Err(io::ErrorKind::WouldBlock.into()),
        };

        let startup = drain(2, false, &mut read);
        assert!(startup.packets.is_empty());

        let connected = drain(2, true, &mut read);
        assert_eq!(connected.packets, vec![vec![3u8; 20]]);
    }

    #[test]
    fn a_read_failure_is_reported_and_stops_the_drain() {
        let drain = drain(64, true, |_buffer: &mut [u8]| {
            Err(io::Error::other("adapter read failed"))
        });
        assert!(drain.packets.is_empty());
        assert_eq!(
            drain.failure.expect("failure").to_string(),
            "adapter read failed"
        );
    }
}
