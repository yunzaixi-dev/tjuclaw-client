# TJUClaw Client Instructions

This repository is the standalone client frontend and native shell for TJUClaw.

## Project Details
- Standalone Repository: `github.com/yunzaixi-dev/tjuclaw-client`
- Package: `@tjuclaw/client` (version 0.0.25)
- Runtime: React 19 + TypeScript + Vite + Tailwind CSS v4 + Tauri v2
- Toolchain: Node 24, pnpm 11.3.0, Task 3.49.1

## Conventions
- Follow UI guidelines in `UI.md` and semantic design tokens.
- All API communication assumes same-origin `/api/...` proxies.
- Do not add backend Go dependencies or private audit fixtures to build inputs.
- Use explicit-path staging and `EMOJI [vVERSION] type(scope): summary` commit subjects;
  VERSION comes from the staged package.json. Do not commit or push without task authorization.
- Client build jobs receive no private-component credentials. The explicit release-only
  package staging workflow may use a package-scoped GitLab deploy token.

## Branches

Use `release` as the primary branch for rapid iteration and production deployments. `dev` is retained without deleting it. Release pushes publish the verified Web artifact to EdgeOne after portable and browser checks. Version-tagged native competition packages remain optional manual delivery.

## Public client downloads

Release branch pushes build Linux, Android and Windows Actions artifacts automatically.
The CI `publish-downloads` job then waits for the same push's Windows Installer run and
publishes a package.json version that is not yet published to both Cloudflare R2
(`client/v<version>/`, `client/latest/`, `client/latest.json`) and a GitHub Release;
an unchanged version is skipped, so bump package.json to ship. `Publish Client Downloads`
remains the manual path for an exact source SHA. Versions, tags and releases are
immutable; R2 `latest` only moves forward and `latest.json` flips last.
Wiki buttons use the stable `https://tjuclaw-release.zaixi.dev/client/latest/` names.
Desktop builds check `latest.json` with `tauri-plugin-updater`; the minisign public key
lives in `tauri.conf.json`, the private key only in repository secrets.
The publish job signs CI's unsigned arm64 release APK as `TJUClaw-android-arm64.apk` with
the permanent keystore secret and refuses any certificate other than the pinned
`ANDROID_CERT_SHA256`; never rotate or regenerate that key. Debug APKs change keys per build.
Windows packages are unsigned; Android packages use debug signing. GitLab competition
packaging remains a separate manual flow.
