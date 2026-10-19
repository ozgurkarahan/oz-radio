# Oz Radio — product brief

Oz Radio turns slide decks into AI-hosted audio and video. A live avatar presents a
deck, and two AI hosts discuss it as a podcast. This brief is the product view: who
the public site is for, what a visitor can do without signing in, and the acceptance
criteria the public experience is held to. Technical details are in the
[README](README.md).

## Who it is for

- **A first-time visitor (anonymous).** Someone who clicks the Oz Radio link on the
  site owner's portfolio, usually on a phone or a work laptop, with no account and no
  context. Within seconds they should understand what Oz Radio is and what they can try.
- **The site owner**, and the users the owner invites. They sign in with Microsoft
  Entra ID to upload decks, render episodes, publish them and run the operator tools.
  Visitors cannot sign in, so the sign-in control is a text link labelled
  **Owner sign-in**, never a button.

Out of scope for the public site: authoring, playlists, search, Teams, SCORM and every
signed-in flow.

## What a visitor can do

| Task | What the visitor does |
|---|---|
| **T1 Arrive and understand** | Reads the first screen, which says what Oz Radio is and what can be tried without signing in |
| **T2 Listen or watch** | Listens to or watches a published episode in their own language and level, with a transcript (audio) or captions (video) |
| **T3 Live demo** | Starts the live avatar on a deck marked *Live demo* and follows the narration with captions. Questions can be asked by voice or typed, when the owner enables them |

Every failure leads to something still useful: the same deck's recording, the list of
episodes or the decks. A visitor should never end on a dead end.

## Acceptance criteria

These were approved by the site owner on 2026-10-18 (UX evidence spec). A referee is
the published standard a criterion is taken from; **[owner]** marks a limit the site
owner set where no published standard exists.

| Task | Criterion | Referee |
|---|---|---|
| T1 | C1.1 Branded feedback that explains any wait is visible ≤ 1 s after the click, cold or warm | Nielsen 1 s |
| T1 | C1.2 Usable Home (actionable CTA) ≤ 10 s cold; lab LCP ≤ 2.5 s warm on the Slow 4G phone profile | Nielsen 10 s; web.dev (lab reference line) |
| T1 | C1.3 Primary CTAs keep their label and target after first paint; lab CLS ≤ 0.1 | web.dev |
| T1 | C1.4 First viewport says what Oz Radio is and what a visitor can do without signing in; no visible control leads to a wall without saying so first | cognitive walkthrough [owner] |
| T2 | C2.1 ≤ 2 taps from Home to audible audio or playing video (warm) | [owner] |
| T2 | C2.2 Feedback ≤ 1 s after the tap; audible ≤ 3 s on Slow 4G (warm) | Nielsen 1 s; [owner] |
| T2 | C2.3 Language and level visible before play; transcript (audio) and captions (video) available | WCAG 1.2.1 / 1.2.2 (Level A) |
| T2 | C2.4 Sampled media: 0 contradictions with sources, no language mixing | content/ai-enablement sources |
| T3 | C3.1 ≤ 2 taps from Home to starting the demo; progress shown ≤ 1 s after the tap | Nielsen 1 s; [owner] |
| T3 | C3.2 Avatar's first audible word ≤ 10 s after the tap (warm); ≤ 10 % of the session cap used before it | Nielsen 10 s; [owner] |
| T3 | C3.3 Every failure state shows a cause + a next action that still gives value (e.g. a recorded episode); 100 % of the matrix | [owner] |
| T3 | C3.4 Narration has captions or a synchronized transcript; a French voice question gets a French answer | WCAG 1.2.4 (applicability to confirm); pilot feedback |

## Free and owner-only

| Free, no sign-in | Owner-only (Entra sign-in and allow-list) |
|---|---|
| Home, and the published decks (slide images, titles and visible slide text) | Uploading decks, rendering videos and podcasts, publishing and unpublishing them |
| Published episodes: watching videos with captions, and listening to podcasts when the owner enables public audio | The live presenter, Search, Playlists and the creation pages |
| The live demo on decks marked *Live demo*, within the daily allowance the owner sets | Marking a deck *Live demo* and the admin avatar |
| The recording of a demo, whenever the live demo cannot run | Unpublished items and their full details |

## Principles

- **No sign-in to try.** Everything a visitor needs for T1 to T3 works anonymously.
  Sign-in is for the owner only.
- **Every failure offers a recording.** A busy, capped, blocked or silent live demo
  ends with the cause, the next step, and the same deck's recording.
- **Honest copy.** A failed load is never shown as an empty library, and raw error
  text is never shown to a visitor. A recording is never presented as a live session.
- **Bounded by design.** Daily allowances and session caps limit what a public visitor
  can use, and the visitor is told when a limit has been reached.
