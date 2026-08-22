# 03 — Publisher setup and connection troubleshooting

**What to build:** Let a service owner configure a supported desktop publisher, approve a subscriber, and resolve the observed conditions that prevent a configured device from reaching its first service.

**Blocked by:** 02 — Subscriber documentation journey.

Status: completed

- [x] The canonical publisher path covers the supported macOS and Windows desktop flow from startup through choosing services and approving a device with Add device.
- [x] A clearly secondary advanced path covers headless CLI, Nix, container, or NUC publishers through manual public-key and TOML configuration without implying an unavailable graphical flow.
- [x] Guidance accurately describes idempotent packaged configuration and identity creation, packaged bootstrap endpoints, policy reload boundaries, and the prohibition on copying secret identity state.
- [x] Troubleshooting gives safe next actions for Connecting, publisher pin or allowlist mismatch, headless policy restart, Windows prerequisites and firewall, VPN/TUN UDP interception, custom bootstrap configuration, tray/menu-bar lifecycle, and sanitized diagnostics.
- [x] The documentation does not promise relay fallback, UDP service transport, automatic firewall bypass, or another unsupported capability.
