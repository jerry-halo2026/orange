---
name: replicate
description: Remake a video in OrangeFilm so that it looks and moves like the reference, shot for shot, with only the content the person names changed (their product, people, words, topic or footage), or as an exact copy, frame for frame. Use when the person gives a video, as a file or a link, and asks for a copy of it, one like it, its style or pacing, or the same video for their product or topic (复刻, 照着做, 做个同款, 一模一样, 仿这个视频).
---

# Replicate a video

The reference made again in OrangeFilm: each shot looks and moves as the reference's does, at the same moments, and only
what the person names changes, every part editable. When they name nothing to change, it is a copy, frame for frame.

**A replica is the reference's look and time, carrying new content.** The cut lands on the same frame; a title starts,
speeds up and settles when the reference's does; a shot keeps its framing, light, colour and type. Not a replica: one on
its own clock, or a filmed shot redrawn as a drawing.

## What has to be true

- **The same moments and the same look, measured.** Every cut, change and sound hit of the reference is in the remake
  within a frame or two, at its pace, and each shot has its palette and layout; `compare` measures this on the render;
  report its numbers, which drop where content changed.
- **Each part made with what can look like it.** Text, captions, graphics, interfaces, charts and their motion are
  pages, exact and editable. What was filmed stays filmed: the person's footage, a clip made from the reference's shot
  or from a still matching it, or footage found to fit; each shot keeps what the change allows.
- **A shot's sound comes with its picture.** Who speaks on screen speaks in the picture: lips, voice and captions are
  one take, the voice made with the picture or the picture made from the voice, never laid over a clip made without it.
  The room, steps and hits a clip makes come with it; only what runs across cuts (music, a voice off screen) is a track
  of its own. A person keeps one face and one voice; captions are what is said, when it is said.
- **Their content, and no one else's.** The reference's subject is content: name first what it shows and sells (whose
  product, app, brand or story), then show the person's in its place: their app's own screens (with none given, designed
  as such an app is), not the reference's interface renamed or around them; their thing, not the reference's relabelled.
  How it is shown stays: framing, camera, type, colour, motion, time. A person made up for the film passes for no real
  one, not even the reference's people. The reference's footage, music or voice are used, in the film or a service, only
  when the person says they may.
- **Seen before it costs.** Before anything costly, the person has seen the shot list: the subject and theirs, then each
  shot's what stays and changes, what makes it and its rough cost. What they change there is what is made.

## What you have

- `node <this skill's folder>/scripts/measure.mjs study <video>`: the reference in time: every cut to the frame, each
  change's place and pace, its holds, its sound's hits and beat.
- `orangefilm look <video> a-b` shows a stretch frame by frame, `t` one frame.
- `node <this skill's folder>/scripts/measure.mjs compare <reference> <render>`: the film against the reference: cuts,
  changes and hits with their offsets, each change's pace, each shot's palette and layout, how alike the frames are,
  side-by-side pictures of the worst, and any of the reference in it. Render first (`orangefilm render`); `--fit`
  when lengths differ.
- `orangefilm get`: pictures made from the reference's frames with what to change (`--ref`, `--mask`, `--markup`);
  video clips from a stretch of the reference (`--video`), from frames and pictures, or of a person speaking (the words
  in the prompt and `--voice`, or a recording with `--audio`); clips and pictures found on the web; voice, music, sound
  effects, transcripts timed word by word; anything else that makes a clip.

The reference and its stretches stay in `references/`.

## With the person

What they ask for comes first. Ask for the reference (a file or a link), what is to change and their material for it
(product, footage, logo, script, voice), whether they may use the reference's own footage, music and voice, and where it
will be posted, without holding up the work. When done, tell them briefly what was kept and changed, `compare`'s
numbers, what could not be matched and why, and, if they will post it, which parts are someone else's.
