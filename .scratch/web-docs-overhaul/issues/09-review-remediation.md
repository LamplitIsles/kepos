# 09 — Remediate completed web/docs review

**What to build:** Correct the desktop publisher bootstrap boundary, complete the manual publisher exchange, document Android QR pairing and desktop manual pairing accurately, reconcile architecture/platform guidance, and remove repeated or redundant public-docs copy.

**Blocked by:** 07 — Idempotent desktop publisher identity bootstrap; 08 — Separate desktop and CLI publisher guides.

Status: done

- [x] Desktop startup creates missing publisher identity from TOML, then validates and reuses existing state without rejecting mutable allow/service policy changes; CLI setup remains strict.
- [x] Bootstrap behavior tests cover policy changes, malformed state, disabled and subscriber-only roles, and test-owned macOS/Windows paths.
- [x] CLI and desktop manual exchange instructions are complete, including public-key retrieval, allowlist update, restart boundary, and publisher pinning.
- [x] Docs and architecture accurately describe Android-only interactive QR pairing, desktop manual pairing, packaged identity bootstrap, mutable TOML policy, and verification boundaries.
- [x] Visible docs copy passes the information/repetition audit, including the landing downloads section, platform-table wording, subscriber quickstart states, lifecycle/trust explanations, and reported before/after main-doc word counts.
- [x] Targeted bootstrap tests, `npm run desktop:check`, `npm run web:verify`, `npm run check`, browser inspection, final diff review, and a clean scoped commit pass.
