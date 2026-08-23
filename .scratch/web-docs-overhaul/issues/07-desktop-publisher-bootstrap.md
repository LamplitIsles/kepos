# 07 — Idempotent desktop publisher identity bootstrap

**What to build:** Let the packaged macOS and Windows desktop applications start an enabled publisher from their normal TOML configuration without requiring the user to clone the repository or run a CLI publisher setup command.

**Blocked by:** None — can start immediately.

Status: done

- [x] When the desktop configuration enables a publisher and its publisher state is absent, startup creates the publisher identity and state from the configured display name, allowlist, and services before starting the role.
- [x] Repeated startup preserves the existing publisher identity and validates that its state remains compatible with the configured publisher policy; it never rotates or replaces an existing seed silently.
- [x] Publisher bootstrap uses the same shared implementation on packaged macOS and Windows paths and does not duplicate platform-specific setup logic.
- [x] Subscriber-only first launch remains unchanged and does not create publisher state when the publisher role is absent or disabled.
- [x] Failure to create or validate publisher state is visible as a publisher startup failure without damaging an existing config, subscriber identity, or publisher state.
- [x] Behavior tests cover first creation, idempotent relaunch, existing-state preservation, disabled publisher, malformed/conflicting state, and both macOS and Windows path resolution using test-owned directories.
- [x] Desktop checks and the full repository check pass without reading or writing live Kepos state.
