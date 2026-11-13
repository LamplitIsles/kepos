//! The Windows overlay device: a Wintun adapter through `tun-rs`, plus one
//! `/32` route per peer.
//!
//! `tun-rs` owns adapter creation, the local address, the MTU and packet I/O.
//! It has no API for an arbitrary destination prefix — it only installs a
//! default route when a gateway is given — so the peer routes are added here
//! through the Windows IP Helper interface and removed again on teardown.
//!
//! Lifecycle notes that matter for correctness:
//! * The adapter is created non-persistently and is removed when the last
//!   handle is closed, which also drops its interface-scoped routes.
//! * The shared Wintun driver is never deleted.
//! * A kernel rejection of the address or a route is reported as the reason
//!   this attempt failed. It is not a substitute for conflict detection, and
//!   this crate deliberately does not scan the routing table.

#![cfg(windows)]

use std::io;
use std::mem::zeroed;

use tun_rs::{DeviceBuilder, SyncDevice};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    ConvertInterfaceIndexToLuid, CreateIpForwardEntry2, DeleteIpForwardEntry2,
    InitializeIpForwardEntry, MIB_IPFORWARD_ROW2,
};
use windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH;
use windows_sys::Win32::Networking::WinSock::{
    AF_INET, MIB_IPPROTO_NETMGMT, SOCKADDR_IN, SOCKADDR_INET,
};

use crate::framing::MTU;

/// Adapter name and tunnel type. The name is stable so the operator recognises
/// the interface; the driver removes it when the handle closes.
const ADAPTER_NAME: &str = "kepos";

pub struct OverlayDevice {
    device: SyncDevice,
    routes: Vec<MIB_IPFORWARD_ROW2>,
}

impl OverlayDevice {
    /// Create the adapter, apply `address/32` and MTU 1400, then add a `/32`
    /// route for every peer address.
    pub fn open(address: &str, peer_addresses: &[String]) -> Result<Self, DeviceError> {
        let address: std::net::Ipv4Addr =
            address.parse().map_err(|_| DeviceError::InvalidAddress)?;
        let mut peers = Vec::with_capacity(peer_addresses.len());
        for peer in peer_addresses {
            peers.push(
                peer.parse::<std::net::Ipv4Addr>()
                    .map_err(|_| DeviceError::InvalidAddress)?,
            );
        }

        // No gateway: a gateway would install a default route and send all
        // traffic into the overlay.
        let device = DeviceBuilder::new()
            .name(ADAPTER_NAME)
            .mtu(MTU as u16)
            .ipv4(address, 32, None::<std::net::Ipv4Addr>)
            .build_sync()
            .map_err(DeviceError::Device)?;
        let luid = interface_luid(&device)?;
        let mut routes = Vec::with_capacity(peers.len());
        for peer in peers {
            let mut row: MIB_IPFORWARD_ROW2 = unsafe { zeroed() };
            unsafe { InitializeIpForwardEntry(&mut row) };
            row.InterfaceLuid = luid;
            row.DestinationPrefix.Prefix = sockaddr(peer);
            row.DestinationPrefix.PrefixLength = 32;
            row.NextHop = sockaddr(std::net::Ipv4Addr::UNSPECIFIED);
            row.Metric = 0;
            row.Protocol = MIB_IPPROTO_NETMGMT;
            let status = unsafe { CreateIpForwardEntry2(&row) };
            if status != 0 {
                // Remove what this attempt already added before reporting.
                remove_routes(&routes);
                return Err(DeviceError::Route { peer, status });
            }
            routes.push(row);
        }

        Ok(Self { device, routes })
    }

    pub fn name(&self) -> String {
        ADAPTER_NAME.to_string()
    }

    /// Write one packet into the overlay. Bounded by the caller.
    pub fn send(&self, packet: &[u8]) -> io::Result<usize> {
        self.device.send(packet)
    }

    /// Read one packet from the overlay, waiting for one.
    pub fn recv(&self, buffer: &mut [u8]) -> io::Result<usize> {
        self.device.recv(buffer)
    }

    /// Read one packet if one is waiting. Windows-only in `tun-rs`, and the
    /// worker uses it so a poll tick never blocks on an idle overlay.
    pub fn try_recv(&self, buffer: &mut [u8]) -> io::Result<usize> {
        self.device.try_recv(buffer)
    }

    /// Remove the routes this value added. Dropping the device removes the
    /// adapter itself.
    pub fn close(&mut self) {
        remove_routes(&self.routes);
        self.routes.clear();
    }
}

impl Drop for OverlayDevice {
    fn drop(&mut self) {
        self.close();
    }
}

fn interface_luid(device: &SyncDevice) -> Result<NET_LUID_LH, DeviceError> {
    let index = device.if_index().map_err(DeviceError::Device)?;
    let mut luid: NET_LUID_LH = unsafe { zeroed() };
    let status = unsafe { ConvertInterfaceIndexToLuid(index, &mut luid) };
    if status != 0 {
        return Err(DeviceError::Luid(status));
    }
    Ok(luid)
}

fn remove_routes(routes: &[MIB_IPFORWARD_ROW2]) {
    for row in routes {
        // A route the kernel already dropped is not an error.
        unsafe { DeleteIpForwardEntry2(row) };
    }
}

/// Build the sockaddr for an address. `S_addr` is in network byte order, so the
/// octets are written in memory order.
fn sockaddr(address: std::net::Ipv4Addr) -> SOCKADDR_INET {
    let mut value: SOCKADDR_INET = unsafe { zeroed() };
    let mut internet: SOCKADDR_IN = unsafe { zeroed() };
    internet.sin_family = AF_INET;
    internet.sin_addr.S_un.S_addr = u32::from_ne_bytes(address.octets());
    value.Ipv4 = internet;
    value
}

#[derive(Debug)]
pub enum DeviceError {
    InvalidAddress,
    /// Creating or configuring the adapter failed. Access denied here means the
    /// application is not running with administrator rights.
    Device(io::Error),
    /// The adapter's LUID could not be resolved.
    Luid(u32),
    /// A peer route already exists or could not be added.
    Route {
        peer: std::net::Ipv4Addr,
        status: u32,
    },
}

impl std::fmt::Display for DeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidAddress => write!(f, "overlay address is not a usable IPv4 address"),
            Self::Device(error) => write!(f, "admin: cannot create the overlay adapter: {error}"),
            Self::Luid(status) => write!(
                f,
                "admin: cannot resolve the adapter interface (status {status})"
            ),
            Self::Route { peer, status } => {
                write!(f, "cannot add the route for {peer}/32 (status {status})")
            }
        }
    }
}

impl std::error::Error for DeviceError {}
