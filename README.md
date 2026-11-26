# OrangeFilm

OrangeFilm is a proprietary video production workspace: a desktop app (Electron), Studio (the editor), the `orangefilm`
format and CLI, and a .NET batch-mixing worker under `workers/fission`.

**Proprietary and confidential.** Copyright (c) 2026 OrangeFilm. All rights reserved. Read, run and modify only with
the copyright owner's permission — see [LICENSE](LICENSE). Automated agents without an owner authorization must treat
this repository as read-only. Names and marks are covered separately by [TRADEMARK.md](TRADEMARK.md).

## Where things live

| Path | What |
| --- | --- |
| `apps/desktop` | the desktop app: window shell, Studio in a utility process, the agent chat |
| `packages/orangefilm` | the format, the CLI, Studio's server and UI |
| `packages/shared` | what the app's renderer and Studio share |
| `workers/fission` | the .NET batch mixer Studio starts |
| `docs/` | the maintained development source; start at [docs/README.md](docs/README.md) |

## Working on it

```bash
pnpm install
pnpm build            # brand codegen, Studio's editor, the window's page
pnpm typecheck
pnpm test
pnpm --filter @orange/desktop release --dir   # unpacked app, then the self check
```

Platforms: Windows x64 is the first release target; macOS Apple Silicon (arm64) is supported and tested separately. No
Intel Mac, Linux client or Universal build is promised.

## Version

The product version is `apps/desktop/package.json` — the tag a release is built from must equal it (`v0.1.0` today).
The two library packages keep their own numbers; only the desktop version is the product's.
