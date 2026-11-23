# Naming: OpenFilm → OrangeFilm

Status: approved migration outline (2026-11-23).

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

- **P0** decision + naming guard.
- **P1** human text and internal symbols only.
- **P2** read-old/write-new: env, Studio protocol, home, CLI, localStorage, provider, skills.
- **P3** packages/resources/MCP, with old stubs for one release.
- **P4** bundle id + data migration + updater.
- **P5** remove aliases after two releases.

## Never by global replace

- `npx -y openfilm@latest`;
- `dev.openfilm.desktop*`;
- `github.com/openfilm` provenance;
- `docs/execution/**`;
- MCP 13-tool contract without a compatibility plan.
