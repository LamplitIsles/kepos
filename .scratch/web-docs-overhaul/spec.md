Status: implemented

## Problem Statement

Kepos now ships stable direct-download artifacts for Android, Apple Silicon macOS, and Windows 10/11 x64, but its public explanation and onboarding have not caught up with the product. The landing page technically exposes all three downloads yet always emphasizes Android, visually describes the desktop product as macOS-only, contains a stale statement that Bare powers only Android and Mac, and offers no route from download to a first working service. The README mixes product introduction, user guidance, implementation architecture, and contributor commands, while the existing platform Markdown is oriented toward developers and operators rather than being the primary public documentation.

A prospective user therefore cannot quickly answer what publisher and subscriber mean, which application belongs on each device, how to install and pair on a chosen platform, why Kepos keeps mature self-hosted applications instead of rebuilding them as P2P applications, how Kepos differs from Holesail, or what to check when the UI remains connecting.

## Solution

Make the public website the primary user-documentation surface by adding a real `/docs/` route. It begins with a short publisher/subscriber concept explanation and two action-oriented entrances: **Share services from this device** and **Connect to shared services**. The same route carries the supported download, installation, pairing, first-service, trust, platform-boundary, and troubleshooting guidance needed for a successful first use without sending the reader to GitHub for the main flow.

Update the landing page to present Android, macOS, and Windows as first-class supported platforms with Lucide device icons, while truthfully identifying Android as subscriber-only and the two desktop platforms as publisher/subscriber capable. Keep every download visible and progressively emphasize the visitor's detected platform; an unknown platform receives no arbitrary recommendation. All artifact links continue to use GitHub's versionless `releases/latest/download` URLs, which follow the latest stable release without a website deployment.

Give the product philosophy and Holesail comparison visible, concise landing-page treatments and fuller documentation sections. Restructure the README as a concise repository entry point and move its detailed developer/architecture explanation into a prominent standalone architecture document linked from the README.

## User Stories

1. As a new visitor, I want to see Android, macOS, and Windows presented together with their actual role support, so that I download the right application for the device I am using.
2. As a prospective user, I want a brief explanation of publisher and subscriber before setup instructions, so that I understand which device shares services and which device receives them.
3. As a service owner, I want a publisher-oriented path from installation through choosing services and approving a device, so that I can share an existing self-hosted service without exposing its public TCP port.
4. As a connecting user, I want a subscriber-oriented path for Android, macOS, and Windows from installation through pairing and opening or copying the first local service address, so that I can reach a shared service successfully.
5. As a reader evaluating the product, I want to understand why Kepos makes the access channel P2P rather than rebuilding mature applications, so that I can see how it preserves the functionality and UX of Navidrome, Jellyfin, Forgejo/Gitea, SSH, and similar services.
6. As a reader comparing tools, I want a factual and respectful Kepos-versus-Holesail explanation, so that I can choose between a direct port tunnel and Kepos's persistent device relationship, named service registry, separate device identities, and per-service authorization model.
7. As a user facing platform warnings or a connection that does not complete, I want one troubleshooting path for supported installation warnings, firewall/VPN/TUN interference, bootstrap reachability, configuration, and sanitized diagnostics, so that I can take the next safe action.
8. As a developer or architecture reader, I want the implementation model in a dedicated document linked prominently from the README, so that user onboarding and technical depth no longer compete in one long page.

## Delivery Boundary

This spec is implemented and reviewed as one PR. It may be decomposed into multiple tickets on the same branch when that makes execution easier.

## Implementation Decisions

- Add one new static, build-produced `/docs/` route using the existing Vite website and shared visual language. It is a comprehensive documentation page with stable internal section links, not a new documentation framework, client-side router, content management system, or duplicate application. Multiple nested documentation routes are intentionally deferred until navigation volume proves one page insufficient.
- Make `/docs/` the canonical end-user guide. Existing repository Markdown remains the contributor, operator, evidence, ADR, and deep technical source. Correct contradictions in existing platform Markdown and link it to the public guide where useful, but do not mirror every user paragraph into both locations.
- The documentation information architecture starts with **Publisher and subscriber**, followed by two primary entry cards: **Set up a publisher** and **Connect as a subscriber**. The canonical first-success flow is a macOS or Windows desktop publisher paired through **Add device** with an Android or desktop subscriber. The manual public-key/TOML flow for headless CLI, Nix, container, or NUC publishers is a clearly labeled advanced alternative.
- The subscriber path contains platform-specific install guidance for Android 12+ arm64, Apple Silicon macOS, and Windows 10 x64 build 19045+/Windows 11 x64. The publisher path identifies macOS and Windows desktop as the graphical publisher choices and points advanced operators to the supported headless forms. Instructions must describe only behavior the repository and current release actually support.
- Explain startup ownership truthfully: packaged desktop applications create their default configuration and device identities idempotently when absent, preserve existing configuration and identities, and use packaged bootstrap endpoints. Android creates and preserves its app-private subscriber identity. Never instruct users to copy secret identity state between devices.
- Keep all three platform downloads visible on the landing page and docs page. Use Lucide's device-oriented icons rather than introducing brand-logo assets or another icon dependency. A small pure recommendation function may classify Android, macOS, Windows, or unknown from browser platform information; it changes emphasis and accessible recommendation text only, never hides or redirects a download. Unknown and unsupported systems show equal choices.
- Preserve `releases/latest/download/<artifact>` links and explain that they follow the latest stable GitHub release, not prereleases. Ordinary quickstart guidance may proceed after clearly stating the unsigned/ad-hoc-signed developer-preview boundary. SHA-256 and Minisign verification remains prominent and recommended, with the complete verification procedure available without making Minisign installation a prerequisite to understand setup.
- Add a concise landing-page philosophy section and a fuller docs section built around: **keep mature applications; change service distribution; preserve their existing client experience**. State that Kepos makes selected access channels direct, authenticated, and P2P while browsers, media clients, Git clients, and SSH continue to use ordinary local URLs or ports. Do not claim that every application protocol itself becomes P2P.
- Add a concise landing-page Holesail distinction and a fuller cited docs comparison. Use Holesail's current official repository and documentation as the authority. The comparison must acknowledge Holesail's direct encrypted P2P model, QR/connection-key flow, and TCP and UDP support. Contrast its port-oriented tunnel workflow with Kepos's persistent publisher/subscriber device relationship, multiple named services over one authenticated outer connection, separate device-owned keys, publisher pinning, allowlists, registry, native service presentation, and current TCP-only service path. Present each as a fit for different needs; do not imply affiliation, endorsement, inferiority, or unsupported absences in Holesail.
- Update the landing-page technical lineage so Bare and desktop support are not described as macOS-only. Add a visible Docs navigation entry without weakening the existing product focus.
- Create a standalone developer/architecture document that absorbs the README's detailed transport path, Holepunch stack, Bare/native host boundaries, lifecycle model, and links to the deeper network document and ADRs. Reduce the README to a concise product description, truthful support matrix, stable download links, short getting-started pointers, contributor checks, and prominent links to the public docs and architecture document.
- Add the docs URL to the sitemap and metadata appropriate for a public indexed page. The route must build and deploy under the existing Cloudflare static-assets configuration and work with its `drop-trailing-slash` HTML handling.
- The troubleshooting section covers only observed, actionable boundaries: expected Android sideload/macOS Gatekeeper/Windows SmartScreen warnings; Windows WebView2 and Visual C++ prerequisites; Windows Defender Firewall; VPN or TUN software that can intercept UDP; a configured-but-connecting subscriber; publisher key and allowlist mismatch; publisher restart after headless policy edits; packaged bootstrap versus custom bootstrap configuration; keeping the desktop process alive in the notification area/menu bar; and copying sanitized diagnostics. It must not promise relay fallback or generic firewall bypass.
- Keep public prose in English for this PR. Maintain accessible headings, landmarks, keyboard-visible links, alt text, reduced-motion behavior, and responsive layouts.

## Testing Decisions

- Extend the existing website behavioral tests at their current static-document/build seam. Verify that the new docs route is a Vite build input, appears in built output and the sitemap, has valid local fragment/label references, and links back to the landing page.
- Test the platform recommendation as a pure behavior with representative Android, macOS, Windows, unknown, and misleading/unsupported inputs. Verify that recommendation never removes any of the three download links and that no platform is preferred for unknown input.
- Retain the contract that all platform artifacts use accessible `releases/latest/download` URLs without version-pinned release paths. Verify Android is identified as subscriber-only and both desktop artifacts remain available, without asserting exact marketing prose or editorial order.
- Extend icon registration coverage to every Lucide icon used across both public pages.
- Verify critical public-document contracts rather than source wording: both publisher and subscriber entry targets resolve; platform install sections are reachable; philosophy, Holesail comparison, trust/verification, troubleshooting, and architecture links resolve; external new-tab links keep safe `rel` values.
- Run the existing root website verification and full repository check. Perform browser review of the landing page and `/docs/` at desktop and mobile widths, including OS recommendation emphasis, navigation, long code/URL wrapping, focus order, and reduced-motion behavior. Use browser inspection rather than screenshot tests for visual acceptance.
- Do not add tests that assert exact sentences, comparison table wording, README text, or source-file shape.

## Out of Scope

- A documentation generator, Markdown-to-site pipeline, search service, CMS, localization system, versioned docs, or nested multi-page docs framework.
- Automatic download redirects, user-agent blocking, analytics-based personalization, update notifications, or prerelease selection.
- New application capabilities, setup wizards, service configuration UI, relay support, UDP transport in Kepos, signing/notarization, or changes to release artifacts.
- Reproducing ADRs, evidence reports, release-maintainer procedures, or every CLI flag on the public website.
- Claiming feature parity with Holesail or turning the comparison into a benchmark.

## Further Notes

The existing landing page already links all three stable artifact names, and GitHub's `releases/latest/download` endpoint updates them when a new non-prerelease becomes latest; a release alone does not require redeploying the site. Website content changes still deploy locally from merged `main` with `npm run web:deploy` because Cloudflare Git Builds are disabled.

Primary Holesail references checked while drafting this spec:

- https://github.com/holesail/holesail
- https://docs.holesail.io/usage-guide/overview
- https://docs.holesail.io/usage-guide/start-a-holesail-server
- https://github.com/holesail/docs

The current website is a Vite static-assets Worker with a single landing input plus a 404 input, shared Lucide registration, static behavioral tests, and Cloudflare `html_handling: "drop-trailing-slash"`. Adding one docs input is the smallest implementation that provides a real route while retaining the repository's current architecture.
