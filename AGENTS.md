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

Use only `dev` (default, direct development) and `release` (production). Release pushes publish the verified Web artifact to EdgeOne after portable and browser checks. Version-tagged native competition packages remain optional manual delivery.
