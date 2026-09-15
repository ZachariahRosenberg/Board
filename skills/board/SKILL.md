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
