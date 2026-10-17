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
   {"enabled": true}`). Anonymous visitors then see **▶ Try the live demo** on
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

It is idempotent (decks are matched by title, the playlist by name). Decks,
podcasts and videos get human-readable display titles (`DISPLAY_TITLES` in
`demos/backend/maintenance/content.py`, e.g. *AI, demystified · Beginner*);
content seeded earlier under the filename slug is still recognised, and
`python -m maintenance.content retitle [--dry-run]` renames it (Cosmos deck
title, playlist steps, AI Search chunks and library manifests). See
`demos/backend/maintenance/content.py` for podcast/video rendering and purge.

Podcast re-renders (staged, so visitors never see duplicates):

```bash
python -m maintenance.content inventory --json /tmp/before.json   # record current items
python -m maintenance.content warm-listeners                      # build the cached listener kits first
python -m maintenance.content render-podcast all --force          # new video + radio renditions
python -m maintenance.content publish --podcast-id <old-id> --off # unpublish each superseded item (kept for rollback)
python -m maintenance.content purge --podcast-id <old-id> --record /tmp/purge.json  # only after verification
```

`render-podcast --format audio` renders a radio-only episode. Run CLI renders
when nobody is rendering from the studio: the CLI process does not share the
server's render limits or batch-job pacing.
