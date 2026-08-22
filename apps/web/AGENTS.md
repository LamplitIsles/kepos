# Kepos website

## Tooling

- Use Node.js 24 and npm from the repository root.
- Keep dependencies in the root `package-lock.json`; do not create a second lockfile.
- Keep Cloudflare configuration in `wrangler.jsonc`.

## Content and tests

- Treat website copy as data, not code.
- Every visible line must add information that is not already clear from its heading, screenshot, control, or nearby copy.
- Let product screenshots speak for themselves. Do not label visible platform or device types, and do not repeat service counts, connection state, or other facts already shown inside the screenshot.
- Before keeping microcopy, ask what choice or action it helps the reader make. If it enables neither, remove it and keep the space.
- Keep useful accessible names and image alt text even when the same detail would be redundant as visible copy.
- Do not test exact wording, punctuation, capitalization, or editorial order.
- Do not add a test merely because a static section or sentence was added.
- Test behavior and stable contracts: working anchors, redirects, navigation state, accessibility semantics, critical URLs, build output, and deployment config.
- Avoid assertions on CSS classes or raw HTML fragments unless a script or accessibility behavior depends on them.
- Review visual changes in a browser at desktop and mobile sizes. Use tests for behavior, not as visual snapshots.

## Product boundaries

- Keep the landing page as one scrolling page. Public user documentation may use static routes under `/docs/`.
- Do not publish install commands until they are supported by the project.
- Do not imply that Kepos is affiliated with or endorsed by Holepunch, Pear, Keet, or Tether.
