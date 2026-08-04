# Kepos repository instructions

## Formal releases

- The formal release workflow in `docs/releasing.md` uses standard `git` and
  `gh`. Never use `og` for release tags, tag pushes, release drafts, asset
  uploads, or publication.
- Release tags must be annotated. Use `git tag -a`, then push the exact tag
  with `git push origin <tag>`.
- All normal source changes still use a feature branch and a pull request.

## Website

- The website lives in `apps/web` and uses the root npm workspace and lockfile.
- Keep Cloudflare configuration in `apps/web/wrangler.jsonc`.
- Cloudflare Git Builds are disabled. Run the local Wrangler deploy only after
  the website change has merged and passed checks.
