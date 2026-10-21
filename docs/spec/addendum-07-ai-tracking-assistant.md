# Addendum 07 — The AI tracking assistant

Master spec §9 and §10 ask for camera and 2D tracking that removes guesswork;
§19 asks that AI suggestions stay editable, that approval stays a human act,
that every operation is logged and reproducible, and that confidential footage
is processed locally where practical. Addendum 06 built the tracking module
around a command layer (`shared/camera/commands.ts`) "so a future AI tracking
assistant can call the same verbs". This addendum records that assistant: what
it does, how, what it costs, what leaves the machine, and what is proved.

## 1. What the artist does

In the Track tab of the viewer, the **AI assistant** panel docks on the right
(hide it with ✕; the tab on the edge brings it back). The artist types an
instruction — "Track the camera; ignore the actor; align to the LiDAR" — or
picks a preset: **Solve camera**, **Clean up and re-solve**, **Align to
LiDAR**, **Track this surface** (the last tracks a planar 2D track the artist
has drawn, or — with frames allowed — lets the assistant propose one).

While it works the panel lists every tool call, with the shot-log entry of each
command it ran (`camtrack.solve — Solve 2: RMS 0.43 px…`), short summaries of
its reasoning, the step, live progress of heavy commands, and the credits this
run has used against its limit and the month's allowance. **Stop** ends the run
at the next step. The run ends with a **report**: summary, final numbers,
whether the targets were met, concerns, frames to check (click to go there),
next steps — and **Undo the assistant's changes**, which restores the camera
track as it was before the run (a logged `camtrack.ai_revert`; the track cache
never reuses ids, so the earlier solves stay valid) and removes 2D tracks the
run created. A follow-up instruction continues the same conversation.

The assistant cannot approve: approval stays the existing named act in the
shot panel. Tracking and solving move the task to *needs review*, as the
artist's own commands do. Approved or locked work is refused by the dispatcher
for the assistant exactly as for the artist.

**Read-only / lapsed licence**: the panel is disabled with the reason (main
refuses too). **Allowance used up**: "AI allowance used up this month —
resets on 1 November."

## 2. Architecture

```
renderer (owns the project)          main process                         vc-vfx.com                     Anthropic
AiAssistant panel ── ai:track-run ──▶ runTrackAgent (shared/ai/agent.ts)
                                     │  tools → shared/ai/tools.ts
                                     │   → trackCommand (camera worker)
   applies ops via onTrack ◀─ apply ─┤   ops sent to the renderer
   (domain + log) ── ai:track-ack ──▶│   continues on the renderer's project
                                     └─ each model turn ── POST /api/ai/track-agent ──▶ licence, allowance,
                                                           (Bearer access token)        builds the request ──▶ Messages API
                                        ◀──────────────── NDJSON stream ◀────────── records usage ◀───── (streamed)
```

- **The loop runs in the desktop's main process** (`main/ai/service.ts`),
  beside the camera worker. Tools execute locally through the same command
  layer as the Track workspace's buttons.
- **The project stays the renderer's.** Every change the assistant makes is a
  list of ops (`shared/ai/ops.ts`: the camera verbs' `ProjectOp`s plus roto
  part/stroke/propagation for exclusion mattes, and the revert) sent to the
  panel, which applies them with the App's `onTrack` — through the domain, so
  approval rules apply and every change is logged, under "*operator* (AI
  assistant)". The panel answers with the project afterwards and the next
  command runs on that, so anything the artist did meanwhile is respected.
- **The loop** (`shared/ai/agent.ts`) is a manual tool-use loop (the
  transport is vc-vfx.com, not the SDK): append-only history (assistant turns
  go back exactly as received, thinking blocks and signatures included);
  parallel tool calls run one after another and all results return together in
  one user message; a failure is an `is_error` result; stops on `finish`, a
  turn without tool calls, the turn limit (40), the run's credit limit (the
  artist picks 10–100), Stop, `stop_reason: "refusal"` (that turn's tools are
  not run), a tool call cut off at `max_tokens` (not run), the monthly
  allowance (402), or a server error. After a mid-output refusal fallback the
  declined partial (before the last `fallback` block, except text) is neither
  echoed nor run.
- **The same loop runs in three places**: main (real model), the browser
  preview (a scripted model, the page's dispatcher — §8), and the tests (mock
  models).

## 3. Tools

`shared/ai/tools.ts`: each a strict JSON schema (`strict: true`,
`additionalProperties: false`, no numeric or length constraints — those are
checked locally), also validated before running. Results are compact summaries
and top-N lists.

| Tool | Runs |
| --- | --- |
| `get_shot_context` | — frame range, plate, handoff camera/lens, camera, lens, tracks, last 6 solves, exclusions, LiDAR, correspondences, roto parts, 2D tracks, task states and locks, targets, what the run may do |
| `get_track_stats` | — counts, lengths, per-frame coverage (thin frames as ranges), 3 × 3 spread on first/middle/last frames, track errors |
| `auto_track`, `detect_features`, `track_features` | `set_track_settings`, `auto_track`, `detect_features`, `track_features` |
| `delete_tracks` (ids / error above / shorter than / in a rectangle; refuses > 40 % unless `allow_large`) | `delete_tracks` |
| `search_cameras`, `set_camera` | — / `set_camera` |
| `set_lens_constraints` (known / approx / unknown, expected range, distortion refinement) | `set_lens` (the range is checked after each solve) |
| `solve`, `get_solve_report`, `select_solve` | `solve`, `get_report`, `select_solve` |
| `exclude_moving_objects` (existing roto parts), `exclude_region` (fixed rectangle) | `set_masks` |
| `create_exclusion_matte` (box on a frame → roto part with include/exclude strokes → roto Track engine both ways → excluded) | roto `addPart`, `addStroke`, `rotoRun`, `recordPropagation`, then `set_masks`; needs a Paint-to-roto task |
| `list_lidar_candidates`, `add_correspondence` (track or pixel ↔ point or named survey point), `remove_correspondence` | — / `add_correspondence` / `remove_correspondence` |
| `align_to_lidar` (similarity / ICP), `solve_with_lidar` | `align_to_lidar`, `solve` with LiDAR |
| `set_coordinate_system` | `set_coordinate_system` |
| `planar_track` (an artist-drawn track, or proposed corners **confirmed by the artist first**) | `track2d_create`, `track2d_track` |
| `export` (only when the run allows it: the checkbox, ticked automatically when the instruction mentions exporting) | `export_camera`, `track2d_export` |
| `get_frame_image` (≤ 1024 px, overlay none / tracks / errors; at most 8 per run) — **offered only when frames are allowed** | frame from the cache, downscaled, overlay drawn, JPEG |
| `finish` | — the report; refused if its RMS, frames or focal disagree with the active solve, or it claims targets met above the acceptable RMS |

`list_lidar_candidates` gives named survey points, existing correspondences,
and — only once the solve is aligned — the nearest scan point to each
best-solved track. There is no automatic global registration: without an
alignment or named points the assistant asks the artist for three or more
correspondences rather than guessing.

## 4. vc-vfx.com

`POST /api/ai/track-agent` (`apps/web/src/lib/ai.ts`, route
`app/api/ai/track-agent/route.ts`, `maxDuration = 300`):

1. 503 "AI assistant not configured" without `ANTHROPIC_API_KEY` or Supabase.
2. 401 without a valid Bearer token; 403 without a live licence (the domain's
   `bestLicense` / `licenseLive`; administrators pass); 402
   `{error, remaining: 0, resetsAt}` when the month's credits are used up.
3. The body is validated and stripped: system text, custom tools only (no
   server tools), user blocks text / base64 JPEG-PNG images / tool results,
   assistant blocks by type passed through unchanged (cache_control removed).
   The client cannot set the model, temperature, tool_choice or anything else.
4. The server builds the request: model from `AI_MODEL` (allow-list:
   `claude-opus-5-5` default, `claude-sonnet-5-5`), `max_tokens` capped
   (`AI_MAX_OUTPUT_TOKENS`, 32 000), `thinking: {type: "adaptive", display:
   "summarized"}`, `output_config.effort` from `AI_EFFORT` (default `high`;
   Opus 5.5's API default is medium), a cache breakpoint on the system block
   (tools + system cached together) plus top-level automatic caching of the
   conversation, `fallbacks: "default"` with beta
   `server-side-fallback-2026-07-01`, tool_choice left at auto (forced tool use
   is a 400 on these models), `metadata.user_id` a hash.
5. Streams back NDJSON (chosen over waiting for the whole message so the
   panel shows the reasoning as it happens): `start` (model, allowance),
   `block` / `delta` (thinking summaries and text), `final` (the message,
   usage, allowance after) or `error`. Desktop cancel aborts the upstream call.
6. Records one `ai_usage` row per call (also after a failure or cancel, from
   the stream's usage so far).

`GET /api/ai/allowance` → `{used, limit, remaining, resetsAt, model,
licensed}`. The account page shows the month's credits.

The prompt (`shared/ai/prompt.ts`) is frozen — no dates, names or settings —
and the tools are in a fixed order per run, so the prefix caches; per-run facts
(shot, targets, frames/export permissions, budget, what the artist drew) go in
the first user message. Toggling frames changes the tool set, so it starts a
new conversation.

## 5. The system prompt

An experienced matchmover; the goal is a solve a supervisor would approve: RMS
under the target by plate width (≤ 2100 px: 0.5 good / 0.8 acceptable; ≤
2600: 0.6 / 0.9; wider: 0.8 / 1.0), all frames solved, plausible stable focal,
≥ 20 well-spread tracks per frame, LiDAR residuals small. Inspect → act →
re-solve → verify, one change at a time; stop when targets are met, after
three attempts without improvement, or when a person is needed. Never claim
numbers the tools did not return; cannot approve; export only when allowed;
frames sparingly; proposed corners are confirmed; end with `finish`.

## 6. Metering and pricing

`packages/domain/src/ai-usage.ts` (one module, used by the site and the
desktop) and `packages/supabase/migrations/0003_ai_usage.sql`.

**Price table** (US$ per million tokens, list price October 2026 — update
`AI_PRICES` when Anthropic's prices change):

| Model | Input | Output | Cache read | Cache write (5 min) |
| --- | --- | --- | --- | --- |
| claude-opus-5-5 | 4.00 | 20.00 | 0.20 | 5.00 (1.25 ×) |
| claude-sonnet-5-5 | 2.00 | 10.00 | 0.20 | 2.50 |
| claude-opus-5 (fallback) | 5.00 | 25.00 | 0.50 | 6.25 |
| claude-opus-4-8 (fallback; taken as Opus 5's, unconfirmed) | 5.00 | 25.00 | 0.50 | 6.25 |
| claude-sonnet-5 (fallback) | 2.00 | 10.00 | 0.20 | 2.50 |

An unknown model is charged as the dearest known. **Cost of a call** = Σ over
attempts of tokens × rate: with a refusal fallback, `usage.iterations`
(`message` and `fallback_message` entries) is the source of truth, each at its
own model's rates; otherwise the top-level usage at the requested model's.
**1 credit = $0.05** of cost (rounded to the hundredth, at least 0.01 for a
non-zero call). **Allowance**: `AI_MONTHLY_CREDITS` (default 400 ≈ $20 of
model cost) per calendar month (UTC), summed from `ai_usage.cost_usd` since the
first; administrators are not metered. A call starts only with credit left; it
may overshoot the remainder by its own cost.

`ai_usage` (user, licence, time, model, input/output/cache-read/cache-write
tokens, `cost_usd numeric(10,4)`, shot_ref, session_id): RLS on, customers read
their own rows (`user_id = (select auth.uid())`), nobody but the service role
writes (no insert policy; insert/update/delete revoked from anon and
authenticated); indexes on `(user_id, created_at desc)` and `license_id`.

**Credit packs / top-ups — not built (TODO).** Design: a Stripe one-off price
per pack; an `ai_credit_grants` table (user, credits, expires_at, order_id)
whose unexpired sum is added to the month's limit; granted by the existing
webhook on `checkout.session.completed`; shown on the account page.

**What a run costs (estimate, not measured against the real API):** a turn
re-reads the cached prefix (~6–8 k tokens of tools + system at $0.20/M) and
sends the new conversation tail; the conversation grows by a few hundred
tokens per tool result. With output of ~0.5–3 k tokens per turn (thinking
included) at high effort on Opus 5.5, a 10-turn solve is roughly $0.30–$1
(6–20 credits); frames add ~800 tokens each. The panel shows actual credits
from the server after every turn.

## 7. Privacy

"**Let AI see frames**" is a per-project, per-computer choice (desktop
settings, keyed like the output root), off by default. Main checks the stored
choice, not only the renderer's word, before offering `get_frame_image`.

- Off: no frames leave the computer. What is sent (through vc-vfx.com to
  Anthropic) is the artist's instruction and the shot's tracking data —
  counts, errors, camera and lens settings, names (shot, roto parts, LiDAR
  files, 2D tracks).
- On: in addition, up to 8 frames per run, downscaled to ≤ 1024 px (JPEG),
  only when the assistant decides it needs one.
- The panel says, without overclaiming: frames are sent through vc-vfx.com to
  Anthropic, the AI provider, only to answer the request, and Anthropic does
  not use API data to train its models by default. vc-vfx.com stores no
  prompts or frames — only the usage row.

## 8. The browser preview

The panel shows, labelled "**Demo — the real assistant runs in the desktop
app**". There is no model and no request leaves the page: a scripted
matchmover (`shared/ai/demo.ts`) reads the real tool results and picks the next
real command from them, run by the page's dispatcher on the sample shot (solve
from nothing; clean up with a threshold of 3 × RMS; LiDAR: stops honestly when
fewer than three correspondences exist; surface: proposes a back-wall panel for
confirmation, then planar-tracks it). Credits are labelled "estimated" —
characters ÷ 4 at Opus 5.5 list price with the prefix read from cache.

## 9. What is proved, and what is not

**Proved by tests** — no API key here, the real API was never called:

- `packages/domain/src/__tests__/ai-usage.test.ts`: price arithmetic, cache
  rates, per-attempt fallback billing, unknown models, credits, the calendar
  month, allowance and admins.
- `apps/desktop/src/shared/__tests__/ai-agent.test.ts` (mock model, real
  commands on a rendered 480×270 36-frame shot): strict closed schemas in a
  byte-stable order; frames tool absent when disallowed; tool dispatch →
  commands → logged ops; parallel results in one message; thinking passed back
  unchanged; `is_error` for failing, invalid and unknown calls; turn limit;
  credit cap; Stop between tools and during a model call; refusal and
  max_tokens turns not run; 402 → allowance; fallback partials dropped;
  follow-ups; export refused unless allowed; proposed corners declined /
  accepted (adjusted); the report refused when its numbers disagree. Two full
  scripted sessions: from nothing to a solve under 0.5 px with the true numbers
  in the report; and with 40 drifting tracks injected (RMS 0.55 px) the
  assistant deletes tracks above 3 × RMS, re-solves and the RMS drops to
  ~0.43 px, under the target.
- `apps/desktop/src/main/__tests__/ai-service.test.ts`: the main-process
  service with a simulated renderer (ops applied and acknowledged, the next
  tool sees the change), read-only refusal, frames only when allowed, the
  confirm round trip, Stop; the vc-vfx.com client (bearer, NDJSON split across
  chunks, 402, error lines, allowance).
- `apps/desktop/src/renderer/__tests__/ai-assistant.test.tsx`: the panel
  applies main's ops through the App and acknowledges with the project, shows
  calls, credits and the report, Undo is logged; read-only disables it; the
  frames choice is stored per project with the privacy wording.
- `apps/web/src/lib/__tests__/ai.test.ts` (fake Supabase, fake SDK stream):
  503 unconfigured, 401, 403 without a live licence, admins, 402 with only
  this month counted, the request built server-side (allow-listed model,
  capped tokens, thinking, effort, caching, fallbacks, strict tools, client
  overrides stripped), server tools / URL images / system roles refused,
  assistant turns passed through exactly, streaming lines, usage recorded at
  list price, mid-stream failure still recorded, fallback billing, allowance.
- Screenshots of the built preview (idle, mid-run, report, frames on, confirm,
  surface report).

**Not verified here:** a real Anthropic call (no key in this environment —
request shape follows the SDK types and the Claude API skill documentation for
Opus 5.5 / Sonnet 5.5; the first real run should confirm `fallbacks:
"default"` with automatic caching, `display: "summarized"`, and that streamed
NDJSON passes through Vercel unbuffered); the model's actual matchmoving
judgement and real costs; `nativeImage` frame encoding and the roto-backed
exclusion matte in the packaged app (the code paths are typed, the roto engine
itself is tested in addendum 04); the migration against the live database and
the Supabase advisors (applied by the maintainer).
