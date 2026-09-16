// M7 final smoke (docs/plan.md "Milestones" — "full smoke: two simulated agents
// + human comments → async feedback consumed via cursor and webhook"). One
// command, full loop, self-verifying: boots a throwaway daemon on a temp
// BOARD_DATA_DIR + scratch ports (never the real ~/.board or :7800 — AGENTS.md
// invariant), walks the feedback-grammar loop (docs/feedback-grammar.md) as
// three principals, asserts every step, prints SMOKE PASS/FAIL, exits 0/1.
//
// Run: bun scripts/smoke.ts (or `make smoke`).

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/src/db.ts";
import type {
  Board,
  BoardEvent,
  Comment,
  Version,
  VersionMeta,
} from "../server/src/domain.ts";
import { createExchangeToken } from "../server/src/sessions.ts";
import { createToken } from "../server/src/tokens.ts";

// Receiver-side verification of the `X-Board-Signature` webhook header — the
// exact recipe from docs/feedback-grammar.md ("Webhook consumption"): HMAC-
// SHA256 keyed by the subscription secret over the EXACT raw body bytes,
// constant-time compare. Exported for scripts/smoke.test.ts.
export function verifyBoardSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  const given = header?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
  if (given === undefined) {
    return false;
  }
  const mac = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(given, "hex"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry-tolerant await: poll until the predicate holds or the deadline passes —
// no fixed sleeps, so the smoke is fast on a warm machine and never flakes on
// a slow one (deliveries are async by design; see awaitDelivery).
async function waitFor<T>(
  what: string,
  fn: () => T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(250);
  }
}

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) {
    throw new Error(message);
  }
}

interface Delivery {
  event: BoardEvent | null;
  raw: Buffer;
  sigOk: boolean;
}

// The simulated consumer's webhook endpoint: records every POST and verifies
// the signature over the raw bytes. Ephemeral port (Bun.serve port 0) — the
// same scratch-port pattern the daemon side uses.
function startReceiver(secret: string): {
  url: string;
  deliveries: Delivery[];
  stop(): void;
} {
  const deliveries: Delivery[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const raw = Buffer.from(await req.arrayBuffer());
      let event: BoardEvent | null = null;
      // A body that doesn't parse as the event envelope stays null: the
      // awaiter's predicate simply never matches it, and the failure surfaces
      // as the step's timeout instead of a receiver crash.
      try {
        event = JSON.parse(raw.toString()) as BoardEvent;
      } catch {
        // not the envelope — recorded, never crashes the receiver
      }
      deliveries.push({
        event,
        raw,
        sigOk: verifyBoardSignature(
          secret,
          raw,
          req.headers.get("x-board-signature") ?? undefined,
        ),
      });
      return new Response("ok");
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/webhook`,
    deliveries,
    stop: () => server.stop(true),
  };
}

async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    }
  } catch {
    // the pipe dies with the process — nothing to drain anymore
  }
}

// Read the daemon's stdout until the listen line (the readiness seam the
// daemon subprocess test in cli/src/main.test.ts uses), returning its URL.
// Every read is raced against the deadline so a daemon that dies mid-boot
// fails the smoke with a message instead of hanging the script.
async function readListenLine(
  proc: { stdout: ReadableStream<Uint8Array> },
  timeoutMs: number,
): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let out = "";
  for (;;) {
    const match = /board: host app listening on (http:\S+)/.exec(out);
    if (match !== null) {
      // Drain the rest in the background: nothing more is printed on the
      // happy path, but an unread pipe could eventually block the daemon.
      void drain(reader);
      return match[1] ?? "";
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `daemon not ready after ${timeoutMs}ms; stdout so far: ${out.trim() || "(none)"}`,
      );
    }
    const chunk = await Promise.race([
      reader.read(),
      sleep(remaining).then(() => null),
    ]);
    if (chunk === null) {
      throw new Error(
        `daemon not ready after ${timeoutMs}ms; stdout so far: ${out.trim() || "(none)"}`,
      );
    }
    if (chunk.done) {
      throw new Error(
        `daemon exited before becoming ready; stdout: ${out.trim() || "(none)"}`,
      );
    }
    out += decoder.decode(chunk.value, { stream: true });
  }
}

const V1_MD = [
  "# Release plan",
  "",
  "## Deployment checklist",
  "",
  "The rollout must wait for the migration to finish.",
  "",
  "- [ ] freeze deploys",
  "- [ ] run the smoke",
  "",
].join("\n");

const V2_MD = V1_MD.replace(
  "The rollout must wait for the migration to finish.",
  "The rollout overlaps the migration — ops signed off in the resolved thread.",
);

function payloadId(ev: BoardEvent | null | undefined, key: string): string {
  const value = ev?.payload[key];
  return typeof value === "string" ? value : "";
}

async function run(): Promise<0 | 1> {
  const dataDir = mkdtempSync(join(tmpdir(), "board-smoke-"));
  console.log(`board smoke: temp data dir ${dataDir}`);

  // Mint-before-spawn: the temp db is opened, seeded, and CLOSED in-process
  // BEFORE the daemon ever opens it — the smoke is the only writer, so there
  // is no WAL race to reason about (and no bootstrap step spawning anything).
  // Plaintext tokens exist only in this process's memory; at rest they are
  // SHA-256 hashes (invariant 8, docs/security.md).
  const db = openDb(dataDir);
  const alpha = createToken(db, { name: "smoke-alpha" });
  const beta = createToken(db, { name: "smoke-beta" });
  const exchange = createExchangeToken(db);
  db.close();

  // Scratch ports end to end: BOARD_PORT=0 lets the daemon bind an ephemeral
  // port and print it (the value read back from the listen line below); env
  // names per server/src/config.ts. BOARD_BIND is pinned so an inherited
  // BOARD_BIND from the operator's shell can never widen the bind list.
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "server", "src", "main.ts")],
    {
      env: {
        ...process.env,
        BOARD_DATA_DIR: dataDir,
        BOARD_HOST: "127.0.0.1",
        BOARD_PORT: "0",
        BOARD_BIND: "127.0.0.1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Daemon stderr is kept (tail only) purely as the FAIL-path debugging aid.
  let daemonStderr = "";
  void (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        daemonStderr = (
          daemonStderr + decoder.decode(value, { stream: true })
        ).slice(-4000);
      }
    } catch {
      // dies with the process
    }
  })();

  // The subscriber picks its secret (docs/feedback-grammar.md); a fixed value
  // keeps runs reproducible and the receiver's verification honest.
  const secret = "smoke-webhook-secret";
  const receiver = startReceiver(secret);

  let baseUrl = "";
  let lastResponse: { status: number; body: string } | undefined;
  let stepNo = 0;
  let stepLabel = "";

  // The response is buffered once (status + exact body text): the same bytes
  // feed both the FAIL-path report and json<T>() — a body can be read once.
  async function api(
    method: "GET" | "POST" | "DELETE",
    path: string,
    token: string | undefined,
    body?: unknown,
  ): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = {};
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = { status: res.status, body: await res.text() };
    lastResponse = result;
    return result;
  }

  function json<T>(res: { body: string }): T {
    return JSON.parse(res.body) as T;
  }

  function expectStatus(
    res: { status: number },
    status: number,
    what: string,
  ): void {
    if (res.status !== status) {
      throw new Error(
        `${what}: expected HTTP ${status}, got ${res.status} — ${lastResponse?.body.slice(0, 500) ?? "(no body)"}`,
      );
    }
  }

  // Each step runs, prints its `ok N` line, and hands its value to the next
  // step — a step that throws fails the smoke with its own number/label.
  async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
    stepNo += 1;
    stepLabel = label;
    lastResponse = undefined;
    const value = await fn();
    console.log(`ok ${stepNo} ${label}`);
    return value;
  }

  // Deliveries are fire-and-forget with per-subscription serialization
  // (docs/feedback-grammar.md): the event is already committed when the
  // daemon turns to POST it, so the receiver polls its own buffer on a short
  // cadence with a deadline instead of the script guessing a fixed sleep.
  function awaitDelivery(
    what: string,
    pred: (d: Delivery) => boolean,
  ): Promise<Delivery> {
    return waitFor(what, () => receiver.deliveries.find(pred));
  }

  try {
    baseUrl = await readListenLine(proc, 15_000);
    console.log(
      `board smoke: daemon ${baseUrl}, webhook receiver ${receiver.url}`,
    );

    await step("daemon healthy", async () => {
      const res = await api("GET", "/api/health", undefined);
      expectStatus(res, 200, "health");
      assert((await json<{ ok: boolean }>(res)).ok === true, "health not ok");
    });

    const board = await step("board created (smoke-alpha)", async () => {
      const res = await api("POST", "/api/boards", alpha.token, {
        title: "M7 smoke — release plan",
        format: "markdown",
      });
      expectStatus(res, 201, "create board");
      const created = await json<Board>(res);
      assert(
        created.id.length > 0 &&
          created.current_version === 0 &&
          created.created_by === "smoke-alpha",
        `unexpected board shape: ${JSON.stringify(created)}`,
      );
      return created;
    });

    const { sectionId, quote } = await step(
      "v1 published (markdown)",
      async () => {
        const res = await api(
          "POST",
          `/api/boards/${board.id}/publish`,
          alpha.token,
          {
            format: "markdown",
            content: V1_MD,
            expected_version: 0,
            label: "initial draft",
          },
        );
        expectStatus(res, 201, "publish v1");
        const v1 = await json<Version>(res);
        assert(v1.n === 1, `expected version 1, got n=${v1.n}`);
        // The heading's extracted anchor is the comment target: render.ts
        // sets a heading's label to its textContent, and anchor validation
        // matches the quote against that same textContent — a quote that
        // cannot miss.
        const heading = v1.anchors.find(
          (a) => a.kind === "heading" && a.label === "Deployment checklist",
        );
        assert(
          heading !== undefined,
          `heading anchor missing from v1 anchors: ${JSON.stringify(v1.anchors)}`,
        );
        assert(
          typeof heading.label === "string" && heading.label.length > 0,
          "heading anchor should carry its text as label",
        );
        return { sectionId: heading.id, quote: heading.label };
      },
    );

    await step(
      "beta subscribed — agent.subscribed delivered and signed",
      async () => {
        const res = await api(
          "POST",
          `/api/boards/${board.id}/subscribe`,
          beta.token,
          { webhook_url: receiver.url, webhook_secret: secret },
        );
        expectStatus(res, 201, "beta subscribe");
        const sub = await json<{
          id: string;
          principal: string;
          created_seq: number;
        }>(res);
        assert(
          sub.principal === "smoke-beta",
          `subscription principal should be smoke-beta, got ${sub.principal}`,
        );
        // The subscription's own event is delivered to the new webhook — the
        // immediate end-to-end confirmation (docs/feedback-grammar.md).
        const delivery = await awaitDelivery(
          "agent.subscribed delivery",
          (d) => d.event?.type === "agent.subscribed",
        );
        assert(
          delivery.sigOk,
          "agent.subscribed delivery signature did not verify",
        );
        assert(
          delivery.event?.seq === sub.created_seq,
          `agent.subscribed seq mismatch: delivery ${delivery.event?.seq} vs created_seq ${sub.created_seq}`,
        );
      },
    );

    const humanToken = await step("human session exchanged", async () => {
      const res = await api("POST", "/api/session/exchange", undefined, {
        token: exchange,
      });
      expectStatus(res, 200, "session exchange");
      const session = await json<{ token: string }>(res);
      assert(
        session.token.length > 0 && session.token !== exchange,
        "exchange should mint a fresh session token",
      );
      return session.token;
    });

    const comment = await step(
      "human comment posted (text anchor)",
      async () => {
        const res = await api(
          "POST",
          `/api/boards/${board.id}/comments`,
          humanToken,
          {
            // Richest anchor the API accepts without a rendered DOM: the
            // server validates the quote against v1's stored section.
            anchor: {
              type: "text",
              section_id: sectionId,
              originalText: quote,
              startOffset: 0,
              endOffset: quote.length,
            },
            body: "Does the rollout really need to wait for the migration? Ops signed off on overlap.",
            version_n: 1,
          },
        );
        expectStatus(res, 201, "human comment");
        const created = await json<Comment>(res);
        assert(
          created.author === "human" &&
            created.in_reply_to === null &&
            created.seq > 0 &&
            created.resolved_at === null,
          `unexpected comment shape: ${JSON.stringify(created)}`,
        );
        assert(
          created.anchor.type === "text",
          "anchor should round-trip as text",
        );
        return created;
      },
    );

    const cursor = await step(
      "alpha consumed the comment via the cursor (since=0)",
      async () => {
        const res = await api(
          "GET",
          `/api/boards/${board.id}/comments?since=0`,
          alpha.token,
        );
        expectStatus(res, 200, "cursor poll");
        const page = await json<{ comments: Comment[]; last_seq: number }>(res);
        assert(
          page.comments.length === 1 && page.comments[0]?.id === comment.id,
          `first poll should see exactly the human comment: ${JSON.stringify(page.comments)}`,
        );
        assert(
          page.last_seq === comment.seq,
          `last_seq should be the comment's seq: ${page.last_seq} vs ${comment.seq}`,
        );
        return page.last_seq;
      },
    );

    await step("webhook: comment.created delivered and signed", async () => {
      const delivery = await awaitDelivery(
        "comment.created delivery",
        (d) => d.event?.type === "comment.created",
      );
      assert(
        delivery.sigOk,
        "comment.created delivery signature did not verify",
      );
      assert(
        payloadId(delivery.event, "comment_id") === comment.id,
        "comment.created delivery should name the human comment",
      );
    });

    const reply = await step(
      "alpha replied (addressed feedback → act)",
      async () => {
        const res = await api(
          "POST",
          `/api/comments/${comment.id}/reply`,
          alpha.token,
          {
            body: "Waiting on the migration — re-publishing with the ordering fixed.",
          },
        );
        expectStatus(res, 201, "alpha reply");
        const created = await json<Comment>(res);
        assert(
          created.in_reply_to === comment.id &&
            created.author === "smoke-alpha",
          `unexpected reply shape: ${JSON.stringify(created)}`,
        );
        assert(
          JSON.stringify(created.anchor) === JSON.stringify(comment.anchor) &&
            created.version_n === comment.version_n,
          "reply must inherit the parent's anchor + version_n (thread semantics)",
        );
        return created;
      },
    );

    await step("webhook: comment.replied delivered and signed", async () => {
      const delivery = await awaitDelivery(
        "comment.replied delivery",
        (d) => d.event?.type === "comment.replied",
      );
      assert(
        delivery.sigOk,
        "comment.replied delivery signature did not verify",
      );
      assert(
        payloadId(delivery.event, "parent_id") === comment.id,
        "comment.replied delivery should name the parent comment",
      );
    });

    await step("human resolved the thread", async () => {
      const res = await api(
        "POST",
        `/api/comments/${comment.id}/resolve`,
        humanToken,
        {},
      );
      expectStatus(res, 200, "resolve");
      const resolved = await json<Comment>(res);
      assert(
        resolved.resolved_at !== null && resolved.resolved_by === "human",
        `resolve should stamp resolved_at/resolved_by on the root: ${JSON.stringify(resolved)}`,
      );
    });

    await step(
      "alpha's next cursor poll consumed the reply + resolved state",
      async () => {
        // Cursor continuation: since is exclusive, so the reply (not yet
        // consumed) is exactly what comes back.
        const nextRes = await api(
          "GET",
          `/api/boards/${board.id}/comments?since=${cursor}`,
          alpha.token,
        );
        expectStatus(nextRes, 200, "next cursor poll");
        const nextPage = await json<{ comments: Comment[]; last_seq: number }>(
          nextRes,
        );
        assert(
          nextPage.comments.length === 1 &&
            nextPage.comments[0]?.id === reply.id,
          `next poll should consume exactly the reply: ${JSON.stringify(nextPage.comments)}`,
        );
        // Resolve mutates the ROOT row, whose seq is already behind alpha's
        // cursor — an exclusive poll can never re-surface it (docs/
        // feedback-grammar.md "Cursor semantics"), so the resolved state is
        // checked on a fresh since=0 read of the same cursor endpoint.
        const backRes = await api(
          "GET",
          `/api/boards/${board.id}/comments?since=0`,
          alpha.token,
        );
        expectStatus(backRes, 200, "catch-up poll");
        const back = await json<{ comments: Comment[]; last_seq: number }>(
          backRes,
        );
        assert(
          back.comments.length === 2,
          `catch-up poll should see the whole thread, got ${back.comments.length}`,
        );
        const backRoot = back.comments.find((c) => c.id === comment.id);
        const backReply = back.comments.find((c) => c.id === reply.id);
        assert(
          backRoot !== undefined &&
            backRoot.resolved_at !== null &&
            backRoot.resolved_by === "human",
          "resolved state should be visible on the root comment",
        );
        assert(
          backReply !== undefined &&
            backReply.in_reply_to === comment.id &&
            backReply.resolved_at === null,
          "replies never carry resolve state — it lives on the root",
        );
      },
    );

    await step("webhook: comment.resolved delivered and signed", async () => {
      const delivery = await awaitDelivery(
        "comment.resolved delivery",
        (d) => d.event?.type === "comment.resolved",
      );
      assert(
        delivery.sigOk,
        "comment.resolved delivery signature did not verify",
      );
      assert(
        payloadId(delivery.event, "comment_id") === comment.id,
        "comment.resolved delivery should name the resolved thread",
      );
      // Serialized per subscription (docs/feedback-grammar.md): arrival order
      // is event order, and every delivery must verify.
      const seen = receiver.deliveries.map(
        (d) => d.event?.type ?? "(unparseable)",
      );
      assert(
        JSON.stringify(seen) ===
          JSON.stringify([
            "agent.subscribed",
            "comment.created",
            "comment.replied",
            "comment.resolved",
          ]),
        `receiver should have seen the four events in order, got: ${seen.join(", ")}`,
      );
      assert(
        receiver.deliveries.every((d) => d.sigOk),
        "every webhook delivery must carry a valid signature",
      );
    });

    await step("audit trail: the whole chain in order", async () => {
      const res = await api(
        "GET",
        `/api/events?board_id=${board.id}`,
        alpha.token,
      );
      expectStatus(res, 200, "events");
      const log = await json<{ events: BoardEvent[]; last_seq: number }>(res);
      const types = log.events.map((e) => e.type);
      assert(
        JSON.stringify(types) ===
          JSON.stringify([
            "board.created",
            "board.published",
            "agent.subscribed",
            "comment.created",
            "comment.replied",
            "comment.resolved",
          ]),
        `audit chain out of order: ${types.join(" → ")}`,
      );
      const actors = log.events.map((e) => e.actor);
      assert(
        JSON.stringify(actors) ===
          JSON.stringify([
            "smoke-alpha",
            "smoke-alpha",
            "smoke-beta",
            "human",
            "smoke-alpha",
            "human",
          ]),
        `event actors unexpected: ${actors.join(", ")}`,
      );
      const deadRes = await api(
        "GET",
        "/api/events?type=webhook.failed",
        alpha.token,
      );
      const dead = await json<{ events: BoardEvent[] }>(deadRes);
      assert(
        dead.events.length === 0,
        "no webhook.failed dead-letters expected — every delivery verified",
      );
    });

    await step(
      "v2 published (loop versioned once more, API-level)",
      async () => {
        const res = await api(
          "POST",
          `/api/boards/${board.id}/publish`,
          alpha.token,
          {
            format: "markdown",
            content: V2_MD,
            expected_version: 1,
            label: "after human feedback",
            note: "addresses the resolved thread",
          },
        );
        expectStatus(res, 201, "publish v2");
        const v2 = await json<Version>(res);
        assert(v2.n === 2, `expected version 2, got n=${v2.n}`);
        const boardRes = await api(
          "GET",
          `/api/boards/${board.id}`,
          alpha.token,
        );
        expectStatus(boardRes, 200, "board get");
        const view = await json<{ board: Board; versions: VersionMeta[] }>(
          boardRes,
        );
        assert(
          view.board.current_version === 2 && view.versions.length === 2,
          `board should be at v2 with two versions: current=${view.board.current_version}, versions=${view.versions.length}`,
        );
      },
    );

    const verified = receiver.deliveries.filter(
      (d) => d.sigOk && d.event !== null,
    ).length;
    console.log(
      `SMOKE PASS — ${stepNo} steps, ${verified} webhook deliveries verified`,
    );
    return 0;
  } catch (err) {
    console.error(
      `SMOKE FAIL — step ${stepNo} (${stepLabel}): ${err instanceof Error ? err.message : String(err)}`,
    );
    if (lastResponse !== undefined) {
      console.error(
        `  last response: HTTP ${lastResponse.status} ${lastResponse.body.slice(0, 2000)}`,
      );
    }
    const stderr = daemonStderr.trim();
    if (stderr.length > 0) {
      console.error(`  daemon stderr (tail):\n${stderr}`);
    }
    return 1;
  } finally {
    // ALWAYS tear down — scratch daemon, scratch receiver, temp dir die with
    // the script, including on failure.
    proc.kill("SIGTERM");
    const exited = await Promise.race([
      proc.exited,
      sleep(8000).then(() => null),
    ]);
    if (exited === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    receiver.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await run());
}
