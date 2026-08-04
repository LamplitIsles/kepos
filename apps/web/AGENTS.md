# Kepos website

## Tooling

- Use Node.js 24 and npm from the repository root.
- Keep dependencies in the root `package-lock.json`; do not create a second lockfile.
- Keep Cloudflare configuration in `wrangler.jsonc`.

## Content and tests

- Treat website copy as data, not code.
- Do not test exact wording, punctuation, capitalization, or editorial order.
- Do not add a test merely because a static section or sentence was added.
- Test behavior and stable contracts: working anchors, redirects, navigation state, accessibility semantics, critical URLs, build output, and deployment config.
- Avoid assertions on CSS classes or raw HTML fragments unless a script or accessibility behavior depends on them.
- Review visual changes in a browser at desktop and mobile sizes. Use tests for behavior, not as visual snapshots.

## Product boundaries

- Keep the site as one scrolling page.
- Do not publish install commands until they are supported by the project.
- Do not imply that Kepos is affiliated with or endorsed by Holepunch, Pear, Keet, or Tether.
