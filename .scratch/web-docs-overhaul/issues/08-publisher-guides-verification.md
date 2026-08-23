# 08 — Separate desktop and CLI publisher guides

**What to build:** Give users distinct Publisher (Desktop) and Publisher (CLI) documentation paths, and move cryptographic release verification out of the main onboarding flow into an optional reference page.

**Blocked by:** 07 — Idempotent desktop publisher identity bootstrap.

Status: done

- [x] Documentation navigation exposes separate Publisher (Desktop) and Publisher (CLI) entries with no CLI initialization command in the desktop path.
- [x] Publisher (Desktop) explains config, automatic identity bootstrap, application launch, Add device approval, and identity preservation using only packaged desktop behavior.
- [x] Publisher (CLI) owns repository checkout, `setup publisher`, state-directory, TOML/manual key, and headless lifecycle instructions.
- [x] Full SHA-256 and Minisign instructions live on an optional verification reference page rather than in the primary onboarding article or main sidebar flow.
- [x] The download section contains only a concise optional-verification reference link while retaining honest unsigned/ad-hoc-signed platform warnings.
- [x] New routes, navigation, sitemap entries, internal links, responsive layout, and accessibility behavior pass website checks and browser review without adding a docs framework or runtime Markdown dependency.
