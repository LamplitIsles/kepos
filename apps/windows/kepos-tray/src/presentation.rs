use kepos_vpn::{ErrorCode, Phase, Snapshot};

pub struct MenuState {
    pub status: &'static str,
    pub detail: Option<&'static str>,
    pub copy_key: bool,
    pub pair: bool,
    pub acknowledge: bool,
    pub connect: bool,
    pub disconnect: bool,
}

pub fn menu(state: &Snapshot, running: bool) -> MenuState {
    let busy = matches!(state.phase, Phase::Pairing | Phase::Connecting | Phase::Connected);
    let status = if !running { "Kepos VPN: restart required" } else { match state.phase {
        Phase::Idle => "Kepos VPN: disconnected",
        Phase::Pairing => "Kepos VPN: pairing…",
        Phase::Connecting => "Kepos VPN: connecting…",
        Phase::Connected if state.receiver.as_ref().is_some_and(|receiver| {
            state.peers.iter().any(|peer| peer.public_key == receiver.public_key && peer.connected)
        }) => "Kepos VPN: connected",
        Phase::Connected => "Kepos VPN: waiting for receiver",
        Phase::Failed => "Kepos VPN: needs attention",
    }};
    let detail = if !running && state.pairing_unknown {
        Some("Check receiver, then restart Kepos VPN")
    } else if !running {
        Some("Restart Kepos VPN to continue")
    } else if state.pairing_unknown {
        Some("Pairing uncertain — check the receiver")
    } else {
        state.error.as_ref().map(|error| match error.code {
            ErrorCode::StateInvalid => "Cannot read or save Kepos state",
            ErrorCode::IdentityInUse => "Kepos identity is already in use",
            ErrorCode::NotPaired => "Pair with a receiver first",
            ErrorCode::InvitationInvalid => "Invitation invalid — request a new one",
            ErrorCode::PairingUnknown | ErrorCode::PairingUnacknowledged => "Pairing uncertain — check the receiver",
            ErrorCode::PairUnavailable => "Receiver unavailable — try again",
            ErrorCode::PairRejected => "Receiver rejected the pairing request",
            ErrorCode::AdminRequired => "Restart Kepos VPN as administrator",
            ErrorCode::DeviceFailed => "Cannot create the VPN device",
            ErrorCode::EngineFailed => "VPN engine stopped — restart Kepos VPN",
        }).or_else(|| match state.phase {
            Phase::Idle if state.receiver.is_some() => Some("Paired with receiver"),
            Phase::Idle => Some("Not paired"),
            Phase::Connected => Some("VPN is running"),
            _ => None,
        })
    };
    MenuState {
        status,
        detail,
        copy_key: state.public_key.is_some(),
        pair: running && !busy && !state.pairing_unknown,
        acknowledge: running && !busy && state.pairing_unknown,
        connect: running && !busy && state.address.is_some() && !state.pairing_unknown,
        disconnect: running && busy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_pairing_requires_receiver_check_before_retry() {
        let mut state = Snapshot::idle(Some("public-key".into()));
        state.pairing_unknown = true;
        let view = menu(&state, true);
        assert!(!view.pair);
        assert!(!view.connect);
        assert!(view.acknowledge);
        assert!(view.copy_key);
    }

    #[test]
    fn connected_device_can_disconnect_but_cannot_repair() {
        let mut state = Snapshot::idle(None);
        state.address = Some("198.18.20.2".into());
        state.phase = Phase::Connected;
        let view = menu(&state, true);
        assert!(view.disconnect);
        assert!(!view.pair);
        assert!(!view.connect);
    }

    #[test]
    fn running_engine_reports_receiver_connection_separately() {
        use kepos_vpn::state::{PeerState, ReceiverState};

        let mut state = Snapshot::idle(None);
        state.phase = Phase::Connected;
        state.receiver = Some(ReceiverState {
            public_key: "receiver-key".into(),
            address: "198.18.20.1".into(),
        });
        state.peers.push(PeerState {
            public_key: "other-key".into(),
            label: "other".into(),
            connected: true,
        });
        assert_eq!(menu(&state, true).status, "Kepos VPN: waiting for receiver");

        state.peers.push(PeerState {
            public_key: "receiver-key".into(),
            label: "receiver".into(),
            connected: true,
        });
        assert_eq!(menu(&state, true).status, "Kepos VPN: connected");
        state.peers.last_mut().unwrap().connected = false;
        assert_eq!(menu(&state, true).status, "Kepos VPN: waiting for receiver");
    }

    #[test]
    fn idle_menu_shows_whether_a_receiver_is_paired() {
        use kepos_vpn::state::ReceiverState;

        let mut state = Snapshot::idle(None);
        assert_eq!(menu(&state, true).detail, Some("Not paired"));
        state.receiver = Some(ReceiverState {
            public_key: "receiver-key".into(),
            address: "198.18.20.1".into(),
        });
        assert_eq!(menu(&state, true).detail, Some("Paired with receiver"));
    }

    #[test]
    fn a_stopped_backend_requires_restart_before_any_command() {
        let mut state = Snapshot::idle(Some("public-key".into()));
        state.pairing_unknown = true;
        let view = menu(&state, false);
        assert!(!view.pair && !view.acknowledge && !view.connect && !view.disconnect);
        assert!(view.copy_key);
        assert_eq!(view.status, "Kepos VPN: restart required");
        assert_eq!(view.detail, Some("Check receiver, then restart Kepos VPN"));
    }
}
