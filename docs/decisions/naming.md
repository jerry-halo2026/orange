# Naming: OpenFilm → OrangeFilm

Status: **clean break approved (2026-11-24)**. The earlier phased, read-old compatibility outline is
superseded: no compatibility layer is kept for the retired `openfilm` runtime, old configs, or old
installs. Execution plan: [plan.md](../execution/2026-11-24-orangefilm-clean-break/plan.md);
inventory: [inventory.md](../execution/2026-11-24-orangefilm-clean-break/inventory.md).

## Product identity

- Human-facing product name: **OrangeFilm / 橙子创作中心**.
- Runtime names converge on `orangefilm` / `ORANGE` in phases; no big-bang replacement.

## Three classes

1. **Human text / internal symbols** — comments, CLI help, errors, i18n, camelCase symbols, CSS prefixes.
   Change freely.
2. **Runtime identity** — `@openfilm/*`, `OPENFILM_*`, `~/.openfilm`, `resources/openfilm`, CLI bin,
   MCP server, skill uid, localStorage keys, provider id.
   Change only with read-old/write-new compatibility.
3. **External provenance** — upstream npm `openfilm`, `dev.openfilm.desktop`, `github.com/openfilm`
   provenance, `docs/execution/**`, LICENSE/NOTICE.
   Keep as provenance; never rewrite history or claim the upstream npm package.

## Target names

| Area | Target |
|---|---|
| Directory | `packages/orangefilm` |
| Scope | `@orange/*` |
| Env | `ORANGE_*` |
| Studio home | `~/.orangefilm` |
| Resources | `resources/orangefilm` |
| CLI | `orangefilm` |
| MCP server | `orangefilm` |
| Skill uid | `orangefilm/*` |
| localStorage | `orangefilm.*` |
| Bundle id | `com.orange.studio` |

## Phases

- **P0** decision + naming guard (`scripts/inventory-openfilm.mjs`, `scripts/rename-guard.mjs`).
- **P1** env `OPENFILM_*` → `ORANGE_*`, module specifiers, package bin/alias.
- **P2** Studio home `~/.orangefilm` only; old home becomes an explicit import.
- **P3** MCP prefix, provider id, skill metadata `orangefilm.json`, localStorage keys.
- **P4** `resources/orangefilm`, CSS class prefix, packaging, CI gates and secrets.
- **P5** product text and external links.
- **P6** machine cleanup (`scripts/cleanup-legacy-openfilm.mjs`, dry run first).

No read-old compatibility layer: the old runtime name is not a supported input after each phase lands.

## Never by global replace

- `npx -y openfilm@latest` (upstream package; we do not publish under that name);
- `dev.openfilm.desktop*` provenance in historical docs;
- `github.com/openfilm` provenance and upstream attribution;
- `docs/history/**` and `docs/execution/2026-1*/**` evidence;
- MCP 13-tool contract: rename the server, keep the tool set.
