---
name: board
description: Publish plans and results to the shared board for async human review, then consume the anchored feedback that comes back. Use when the user asks to publish or put something "on the board", wants human review of a plan or result, mentions board feedback or the board daemon, or when board_* MCP tools are available.
---

# board — async human review

## What boards are

- Shared review artifacts hosted by the always-on board daemon (`127.0.0.1:7800`): you publish markdown, the human reads it in a browser and annotates it with anchored comments, you consume the feedback and respond.
- The loop is asynchronous. Publish and move on — **never block waiting on the human**. Check for feedback between task steps, not constantly.
- Boards are append-only and versioned. Every publish is a new immutable version; history is never rewritten (only `board_restore` rolls a board back).

## The loop

1. **Create**: `board_create` (title, format, tags) — a new board starts at v0, empty.
2. **Publish**: `board_publish` (board id, content, `expected_version`) — see conflicts below.
3. **Tell the human**: say the board is ready and how to open it — `board open <id>` from the CLI, or `make open <id>` in the repo. Do not open a browser yourself.
4. **Poll**: run the capped poller (below) between task steps.
5. **Reply**: for each new comment, `board_reply` (comment id, body) in that comment's thread — answer questions, say what you changed.
6. **Resolve**: `board_resolve` (comment id) ONLY when the thread is actually addressed. Never resolve to make noise go away — an unresolved comment is the human's signal that work remains.
7. **End**: when the work is done and threads are settled, `board_end` (board id) closes the loop.

## Tool reference

| Tool | Does | Key inputs |
|---|---|---|
| `board_create` | opens a new board (v0, empty) | title, format, tags |
| `board_publish` | pushes content as a new immutable version | board_id, content, expected_version |
| `board_list` | lists boards with unresolved-comment counts | — |
| `board_get` | board + current version metadata | board_id |
| `board_get_comments` | **the** feedback path: comments + `last_seq` cursor | board_id, since |
| `board_reply` | answers in a comment's thread | comment_id, body |
| `board_resolve` | marks a thread addressed | comment_id |
| `board_restore` | rolls the board back to a prior version | board_id, version |
| `board_end` | closes the board's review loop | board_id |
| `board_status` | daemon liveness + counts | — |
| `board_subscribe` | registers a webhook for signed event push | board_id, webhook_url, webhook_secret? |
| `board_upload_image` | copies a local image into a board, verified + sanitized | board_id, path (absolute, on the daemon host) |
| `board_export` | exports a board as a self-contained zip bundle, base64-encoded | board_id |

## Images

To put a screenshot or diagram on a board, call `board_upload_image` with the image's **absolute path on this host** (the daemon copies and verifies it — png, jpeg, gif, webp, or svg, 10 MB per image / 8 MB per board). The result carries `asset_id` plus ready-to-paste embed snippets:

- markdown boards: `![image](asset:<id>)` — write this in your next `board_publish`
- html boards: `<img src="/assets/<id>">` — reference the URL directly

Never invent asset ids or reference `/assets/<id>` URLs you did not get from the tool — unknown ids render as broken images.

### Annotating an image (overlay schema)

Comments can anchor to an image and carry an **overlay** — arrows and positioned text labels the web UI draws over the image. The anchor is `{type: "image", asset_id, overlay}`; coordinates are **normalized to 0..1 of the displayed image box** (not pixels), so an overlay scales with any layout: `x` is the fraction across the image's width, `y` the fraction down its height, `(0,0)` top-left. Post it as a comment via REST:

```sh
curl -X POST "http://127.0.0.1:7800/api/boards/<board_id>/comments" \
  -H "authorization: Bearer $BOARD_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "anchor": {
      "type": "image",
      "asset_id": "<asset_id>",
      "overlay": {
        "arrows": [{ "x1": 0.3, "y1": 0.4, "x2": 0.55, "y2": 0.4 }],
        "boxes": [{ "x": 0.6, "y": 0.38, "text": "this label overflows" }]
      }
    },
    "body": "Arrow points at the overflow; label marks the fix.",
    "version_n": 1
  }'
```

- `arrows` — `{x1,y1,x2,y2}`: tail → head coordinates (the head renders at x2,y2).
- `boxes` — `{x,y,text}`: the label's top-left anchor point plus its text (200-char cap).
- The overlay may hold only arrows, only boxes, or be omitted entirely for a plain "on image" comment; each list caps at 50 items and every coordinate must be in [0,1].
- To find coordinates for a local image, read its pixel dimensions and divide: `x = pixel_x / width`, `y = pixel_y / height`.

## Export / import

- `board_export {board_id}` returns the board's bundle — manifest, version sources, comments, assets, event audit snapshot — as a zip **base64-encoded in the result's `data` field** (`encoding: "base64"`, `bytes` = raw zip length). Decode and save: e.g. `echo "<data>" | base64 -d > <board_id>.zip`, then write it where the human asked. Bundles over 8 MB are refused by the tool — fetch `GET /api/boards/<id>/export` over REST instead.
- Import (`POST /api/boards/import` with the raw zip, or `board import <file>` / `make import <file>`) is a human/CLI surface — it always mints a NEW board id and re-runs the quarantine pipeline, so embeds and comments survive but ids change. Never assume an imported board keeps its old asset or comment ids.

## Consumption rule — exactly one

Read feedback ONLY via `board_get_comments` with a `since` cursor. First poll uses `since=0` (or omits it); the result carries `last_seq` — persist it and pass it back as `since` on every later poll. Never re-read all comments from scratch; never scrape the web UI or REST routes for feedback.

## Poller (capped)

Run between task steps — never unbounded, never instead of the task:

```
cursor = 0                       # persist last_seq across polls
repeat up to 30 times:           # hard cap — exit the loop no matter what
    res = board_get_comments(board_id, since=cursor)
    cursor = res.last_seq
    if res.comments.length > 0:
        break                    # act on the new comments now
    sleep 10 seconds
```

Thirty iterations at 10 s covers ~5 minutes. If the cap hits with nothing new, get on with the task and poll again later.

## Version conflicts (409)

`board_publish` fails with a conflict when `expected_version` is stale — someone published first. Retry recipe:

1. `board_get` the board and read its current version.
2. Re-apply your change on top of the current content (read it first — never blind-overwrite).
3. `board_publish` again with `expected_version` set to the version you just fetched.
4. Still conflicting after two tries? Stop and surface the conflict to the human instead of looping.

## Daemon down

`board_status` fails or connections are refused: tell the human to start the daemon with `make serve`. Agents do NOT start, stop, or restart the daemon. Once it is back up, re-check with `board_status` and continue the loop.

## Style

- Boards are markdown: headings, tables, and mermaid diagrams render in the UI.
- One topic per board — split unrelated work into separate boards.
- Label versions: lead with a line like `v2 — trimmed rollout section per feedback` so the human sees what changed and why.
