---
name: media
description: Media for an OpenFilm film. Read it before you add music, a sound effect, a transition, an effect, a filter, a sticker, a text animation or a template, and before you make voice-over, pictures, video or transcripts, or search the web.
---

# Media

`openfilm get`: media for the film. First OpenFilm's own library, free, offline and CC0: `get music-search`, `get sfx-search`, `get transition`, `get effect`, `get filter`, `get sticker`, `get text` and `get template`, each `--prompt "<what>"` in any words and language; each match says what of your prompt it has and lacks, and `--take <id>` copies the one you choose into the project and prints what to put in film.html. Look there before writing a transition, an effect, a text or a template yourself. The rest is made by a service the person connected in Studio (Settings → Services): voice-over, music and sound effects to your prompt and length (`get music`, `get sfx`, at a cost), transcripts, images, image search, video and web search. Make music or a sound when the person asks for something original, when it must fit the picture exactly, or when the matches lack what was asked; when the person says which they want, do that. `get` alone lists what works now; for a kind not connected, tell the person which services make it and where they connect one. A video clip costs a lot: the person confirms it in Studio first. Its `--help` lists the verbs and their options.

Media can come from `get` (OpenFilm's library, or a service that makes it), any service the person uses (with its API docs and their key), or your own code. Save it under `assets/`.

When the person wants a service that is not built in to make pictures, clips or sounds (on the canvas too), add it as a provider: `openfilm get` ends by naming its folder, the contract it follows and a built-in one to read. Write it from the service's API docs, then try it with `get <verb> --via <id>` once the person has added its key in Settings → Services.
## Analysing a clip: `openfilm analyze`

`openfilm analyze <media>` runs the analysis pipeline on one clip and answers with a card (who it is
about, what happens, a confidence), the graded evidence (`videoMd`: card / overview / timeline / shot)
and a vector for recall. It is the same pipeline the app runs.

```
openfilm analyze clip.mp4 --project . --json
openfilm analyze clip.mp4 --frames 6 --long-edge 512
```

- `--frames` (1-64, default **6**) and `--long-edge` (128-4096, default **512**): the defaults are
  measured. On the machine this was benchmarked on a frame at 1280 cost ~20 s of vision time and at
  512 ~4 s; twelve frames of every clip in a large library is not a budget anyone has.
- `--project <dir>` puts the cache in `<dir>/.openfilm/analysis`; without it, the current folder.
- `--json` prints one object: `{ok, uploaded, cache, timings, states, summary}`. It never says where
  the media lives, so the answer is safe to paste into a log or a message.

Exit codes, so you can branch without reading prose:

| code | meaning |
| ---: | --- |
| 0 | analysed (published to an index or not: the local result is worth having) |
| 2 | the command was wrong (no media, unknown option, number out of range) |
| 4 | the analysis component (`services/rea-video`) is not installed — it is installed on first use, never shipped |
| 5 | the analysis ran and failed: `code` is `frames-empty`, `analyzer-malformed`, … |

`states` says what actually ran: `scene`, `ocr`, `transcribe`, `judge`, `embed`; `not-configured` there
means that part is not installed, and the rest of the analysis still stands. Words in the card and the
evidence come from the metadata you pass and from OCR — never from the vision model's guess at
on-screen text, which stays in `summary.hints`.

Before you analyse a clip the person cares about, check the exit code: 4 and 5 are ordinary answers,
not crashes, and 0 does not promise an upload.