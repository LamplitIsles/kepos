# 05 — README and architecture documentation reconciliation

**What to build:** Give repository visitors a concise README and a prominent standalone architecture guide while eliminating contradictions between public product claims, platform references, and the implemented three-platform desktop runtime.

**Blocked by:** 03 — Publisher setup and connection troubleshooting; 04 — Product philosophy and Holesail comparison.

Status: completed

- [x] The README is a concise repository entry point with the truthful support matrix, stable downloads, short getting-started pointers, contributor checks, and prominent public-docs and architecture links.
- [x] A standalone developer architecture document covers the transport path, Holepunch stack, Bare/native host boundaries, lifecycle model, and links to the deeper network document and relevant ADRs.
- [x] Detailed architecture is removed from the README only after its durable replacement exists; no user-critical setup guidance is lost.
- [x] Stale macOS-only desktop, Bare runtime, Windows support, installation, and release-boundary claims in existing documentation are corrected against current repository behavior.
- [x] The website docs remain the primary end-user flow, while repository Markdown has a clear contributor, operator, ADR, evidence, or deep-technical purpose and does not become a second conflicting user guide.
- [x] Root website verification, the full repository check, link/anchor contracts, and Markdown diff checks pass.
