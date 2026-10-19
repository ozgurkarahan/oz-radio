# AI enablement series

A three-level, avatar-narrated introduction to modern AI, built for Oz Radio.
Each deck is a native, editable PowerPoint (16:9, white "Build" style with
blue and amber accents) whose speaker notes are written to be **read aloud
verbatim** by the avatar: plain sentences, no URLs, acronyms expanded on first
use. Every slide has a title, short bullets, an original diagram drawn with
native shapes, a footer (`Oz Radio · AI enablement · <Level>`) and a slide number.

| File | Level | Title | Slides | Notes (words) | Narration at 150 wpm |
|---|---|---|---|---|---|
| `ai-enablement-1-beginner.pptx` | Beginner — no prior AI knowledge | AI, Demystified | 12 | 1,373 | ~9.2 min |
| `ai-enablement-2-practitioner.pptx` | Practitioner — builds with AI tools | Building with AI | 12 | 1,501 | ~10.0 min |
| `ai-enablement-3-expert.pptx` | Expert — wants the internals | Under the Hood | 12 | 1,639 | ~10.9 min |
| `ai-enablement-demo-beginner.pptx` | Public live demo | Beginner demo cut | 5 | 380 | ~2.5 min |
| `ai-enablement-demo-beginner-fr.pptx` | Public live demo (French) | Démo débutant | 5 | 414 | ~2.8 min |

Narration time is an estimate (words ÷ 150 words per minute) and excludes
slide transitions; the actual speaking rate depends on the selected voice.

- **Beginner** — what a model is, large vs. small language models, reasoning
  models, prompts/tokens/context window, agents, tools and MCP, speech and
  avatars, open vs. closed vs. open-weight, responsible use, recap.
- **Practitioner** — model choice per task, context engineering, the agent
  harness, MCP roles/transports/auth, speech architectures, evaluation and
  cost, tool design, guardrails, an end-to-end reference architecture.
- **Expert** — tokenization and attention, "lost in the middle", test-time
  compute, quantization and local runtimes, licences, planner/sub-agent
  patterns, compaction and regression evals, MCP security, tool poisoning and
  prompt injection, barge-in and turn detection, governance.
- **Demo cut** — model, agent and voice in five slides for the anonymous
  public live demo. The `-fr` file is the same cut in French (titles,
  bullets, diagram labels and notes translated once with gpt-4.1, reviewed and
  hard-coded in the generator), for a French (`fr-FR`) live demo.

Sources, the slides they support, and caveats (original diagrams; model names
are examples as of 2026) are in [SOURCES.md](SOURCES.md).

## Regenerate

```bash
pip install python-pptx
python scripts/generate_ai_enablement_pptx.py
```

The generator rewrites all five files in this folder. Output is deterministic
(fixed document properties and ZIP timestamps), so an unchanged script produces
byte-identical decks. Slide text and speaker notes live in `SLIDE_TEXT` inside
the script; edit them there, never in PowerPoint, then regenerate and run:

```bash
python -m pytest demos/backend/tests/test_ai_enablement_decks.py -q
```

The test checks slide counts, titles, non-empty notes, a word band per level,
the demo cuts' totals (≤ 420 words each), that the French cut mirrors the English one, footers and slide numbers, the absence of
secret-like strings, and that the committed files match the generator.

Fonts: everything uses Calibri. The app container renders slides with
LibreOffice, which substitutes the metric-compatible Carlito font, so line
breaks match PowerPoint. Builds are static (no animations).

## Seed the series in Oz Radio

Signed in as an admin:

1. **Upload.** Open **Decks** and upload each PPTX. Decks uploaded from the
   page get the language `en-US` (the upload default), which is correct for
   this series. With the API, send `language=en-US` with
   `POST /api/decks/upload`. Upload `ai-enablement-demo-beginner-fr.pptx` with
   `language=fr-FR` so the live demo narrates its French notes.
2. **Publish.** Click **Publish** on each deck's row (Decks page) so anonymous
   visitors can browse it (`POST /api/decks/{deck_id}/publish
   {"published": true}`).
3. **French narration (optional).** Open a deck's present page
   (`/decks/<deck_id>/present`) and pick **French** in the language selector.
   As an admin this calls `POST /api/decks/{deck_id}/translate-notes` with
   `{"target_language": "fr-FR"}`; the translated notes are cached on the deck
   and the avatar narrates in French. Repeat per deck (and per language).
4. **Playlist.** Open **Playlists → Create playlist** and create
   **"AI enablement path"** with the steps in this order: *AI, Demystified*
   (Beginner) → *Building with AI* (Practitioner) → *Under the Hood* (Expert).
   The playlist player presents the decks back to back.
5. **Live demo (demo cuts only).** After publishing
   `ai-enablement-demo-beginner.pptx` (and the `-fr` cut), click **Live demo off** on its row so it
   reads **Live demo on** (`POST /api/decks/{deck_id}/live-demo
   {"enabled": true}`). Anonymous visitors then see **Start the live demo** on Home, Decks and
   its present page when the public demo is enabled
   (`PUBLIC_DEMO_ENABLED=true`). See [docs/live-demo.md](../../docs/live-demo.md).
   The cut is sized for the default 180-second demo session
   (`DEMO_SESSION_SECONDS`): about 2.5 minutes of narration plus transitions.
   If the chosen voice speaks more slowly, raise the session limit rather than
   lengthening the notes. Only the demo cut should be a live demo; its notes
   are public by design.

### Operator seeding (maintenance CLI)

The same steps can be run non-interactively inside the app container with
the app's own managed identity (no sign-in), e.g. through
`az containerapp exec`:

```bash
python -m maintenance.content seed --dry-run   # plan only
python -m maintenance.content seed             # upload, publish, translate, live demo, playlist
```

Display titles contain non-ASCII characters (`·`, `é`): if `az containerapp exec`
aborts with a Unicode error, prefix the command with
`env PYTHONIOENCODING=ascii:backslashreplace` (the output then shows `\xb7`-style escapes).

It is idempotent (decks are matched by title, the playlist by name). Decks,
podcasts and videos get human-readable display titles (`DISPLAY_TITLES` in
`demos/backend/maintenance/content.py`, e.g. *AI, demystified · Beginner*);
content seeded earlier under the filename slug is still recognised, and
`python -m maintenance.content retitle [--dry-run]` renames it (Cosmos deck
title, playlist steps, AI Search chunks and library manifests). See
`demos/backend/maintenance/content.py` for the full command list (podcast and
video rendering, publish/unpublish, the staged switch below, purge).

#### Re-render podcasts and videos (staged rollout)

A re-render (for example after better scripts) is a **visibility change, not a
replacement**: script each item and read the text first, render exactly that
text privately, check the renders, then switch visitors over. The old items are
only unpublished, so a rollback is one command. **Never purge during the
rollout.**

```bash
python -m maintenance.content inventory --json /tmp/before.json    # record the current items
python -m maintenance.content warm-listeners                       # build the cached listener kits first

# 1. Script each item and read it BEFORE paying for a render: one model call, no render,
#    no library access, nothing published. Podcasts: beginner practitioner expert demo-fr;
#    videos: demo-en demo-fr practitioner.
python -m maintenance.content script-podcast expert --out /tmp/scripts/podcast-expert.json
python -m maintenance.content script-video demo-en --out /tmp/scripts/video-demo-en.json
#    Not good? Generate again to a new --out path (a script is never overwritten).

# 2. Render exactly the reviewed text, privately. One detached job at a time.
python -m maintenance.content --background /tmp/r-expert.log render-podcast expert --from-script /tmp/scripts/podcast-expert.json --force --unpublished
python -m maintenance.content logtail /tmp/r-expert.log -n 40      # progress; RENDERED podcast expert job-... = the new id
python -m maintenance.content --background /tmp/r-demo-en.log render-video demo-en --from-script /tmp/scripts/video-demo-en.json --force --unpublished
grep '^RENDERED ' /tmp/r-demo-en.log                               # just the new id (ids only, never URLs)

# 3. Inspect every new item as an admin (admins see unpublished items with their published flag).

# 4. Plan, preview, switch.
python -m maintenance.content plan-switch --out /tmp/switch.json   # published item -> its newer private re-render
python -m maintenance.content switch --manifest /tmp/switch.json --dry-run
python -m maintenance.content switch --manifest /tmp/switch.json   # per pair: publish new, then unpublish old

# 5. If something is wrong: publish each old item again, then unpublish each new one.
python -m maintenance.content rollback --manifest /tmp/switch.json --dry-run
python -m maintenance.content rollback --manifest /tmp/switch.json
```

- **`script-podcast` / `script-video`** run the render's own ingest and script
  generation (same spec inputs and prompts) and stop there: no render, no
  library access, nothing published. They write the script as JSON (`kind`,
  `key`, language, audience level, the model's `turns` or `narrations`,
  `generated_at`, the deck's SHA-256 and a `content_sha256` of the lines), print
  a compact transcript (`<turn> s<slide> <speaker> <text>`, where `[+id@n]` is a
  listener reaction after sentence n; for a video `slide <n> (<style>): <text>`)
  and a `SCRIPTED <kind> <name> <sha256> <file>` line. A script costs one model
  call, so a plain exec is enough (`--background LOG` works too). They never
  overwrite a file; `--dry-run` makes no model call and writes nothing. Under
  `PYTHONIOENCODING=ascii:backslashreplace` non-ASCII characters print as `\xNN`
  escapes (the file keeps the real text).
- **`--from-script FILE`** (one episode, not `all`) renders exactly the turns or
  narrations of that file and skips script generation; it combines with
  `--unpublished`, `--force`, `--format` and `--background`. The file is
  validated before any ingest, model call or library access: size cap, JSON,
  exact schema, same kind and key, the spec's language, style and audience (and
  voice), the deck unchanged since the script was written, the lines matching
  `content_sha256` (a file edited after it was generated is refused: generate it
  again) and the routers' limits. It prints
  `USING_SCRIPT <kind> <name> <sha256> <file>`, the digest the review printed.
- **`--unpublished`** archives the render with `published: false`, never
  publishes it and prints one `RENDERED <podcast|video> <name> <job id>` line
  as soon as it is archived (ids only, never URLs). Pass `--force` as well for
  a re-render: without it an item that already has the title is only reported
  (and, under `--unpublished`, never published). A failed render prints no
  `RENDERED` line and no item appears in the library. Run the renders one
  after the other, and when nobody renders from the studio (the CLI process
  does not share the server's render limits or batch-job pacing);
  `--format audio` renders a radio-only episode. Without the review step,
  `render-podcast all --force --unpublished` (and `render-video all ...`)
  generate and render every item in one go.
- **`plan-switch`** pairs each published item with the single newer
  unpublished item of the same kind, title, format and language, and writes the
  manifest. Published items without a re-render are listed as `unmatched`.
  Matches it cannot decide (several published items, or several newer private
  re-renders, for one title) are left out and reported in `errors` (exit code
  1), never guessed: add that pair to the manifest by hand. It never overwrites
  an existing file (the manifest holds the switch record), and `--dry-run`
  prints the plan without writing.
- **The manifest** is plain JSON, so it can also be written by hand; only
  these keys are needed (`plan-switch` adds title, format, language and
  creation times for review):

  ```json
  {"pairs": [
    {"kind": "podcast", "old_id": "job-1a2b3c4d", "new_id": "job-5e6f7a8b"},
    {"kind": "video", "old_id": "sv-1a2b3c4d", "new_id": "sv-5e6f7a8b"}
  ]}
  ```

- **`switch` / `rollback`** check the whole manifest before changing anything
  (ids valid and present; old and new share title, format and language), then
  go pair by pair and stop at the first failure. The item that must be visible
  always goes live before the other one is hidden, so visitors never see a gap
  (a failed unpublish leaves both visible, never neither). Both are
  idempotent: re-run them after a failure, and a step already in its target
  state is reported `already`. Every step is appended to the pair's `log` in
  the manifest (`at`, `command`, `step`, `id`, `outcome`) and the pair's
  `status` is kept current; `--dry-run` writes nothing, not even the manifest.
  Exit codes: 0 done, 1 a step failed or the plan is incomplete, 2 invalid
  request (nothing was changed).
- **Single items:** `publish --podcast-id job-... --video-id sv-... [--off]`
  and `unpublish ...` (the same as `publish --off`) accept `--dry-run`; ids are
  validated first and nothing is deleted.
- The manifest lives on the replica's filesystem: keep the JSON that `switch`
  prints (a rollback only needs the pairs). Purge old items in a later,
  separate clean-up once the new ones have proven themselves (`purge
  --podcast-id/--video-id ... --record /tmp/purge.json` refuses to delete the
  last published copy of a catalog item).
