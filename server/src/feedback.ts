import type { Board, Comment } from "./domain.ts";

// The feedback markdown grammar (docs/plan.md "feedback markdown grammar"):
// one artifact, human-readable AND agent-parseable. Threads are root comments
// in seq order; replies render flat under their thread root, seq order.

function anchorDescriptor(anchor: Comment["anchor"]): string {
  switch (anchor.type) {
    case "board":
      return "board";
    case "section":
      return `section ${anchor.section_id}`;
    case "text":
      return `text ${anchor.section_id}: "${anchor.originalText}"`;
    case "row":
      return `row ${anchor.section_id}/${anchor.row_id}`;
    case "image":
      return `image ${anchor.asset_id}`;
  }
}

// Resolve a comment's thread root (walks in_reply_to; cycle-safe).
export function threadRootOf(
  comments: Comment[],
  comment: Comment,
): Comment | null {
  let current: Comment | null = comment;
  const seen = new Set<string>();
  while (current !== null && current.in_reply_to !== null) {
    if (seen.has(current.id)) {
      return null;
    }
    seen.add(current.id);
    const parent: Comment | undefined = comments.find(
      (candidate) => candidate.id === current?.in_reply_to,
    );
    current = parent ?? null;
  }
  return current;
}

export function serializeFeedback(board: Board, comments: Comment[]): string {
  const roots = comments
    .filter((comment) => comment.in_reply_to === null)
    .sort((a, b) => a.seq - b.seq);
  const unresolved = roots.filter(
    (comment) => comment.resolved_at === null,
  ).length;

  const lines: string[] = [];
  lines.push(
    `# Feedback: "${board.title}" (${board.id}, v${board.current_version})`,
  );
  lines.push("");
  lines.push(`Unresolved: ${unresolved} of ${roots.length} threads.`);
  lines.push("");

  if (roots.length === 0) {
    lines.push("No comments yet.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("---");
  lines.push("");

  roots.forEach((root, index) => {
    const i = index + 1;
    const status = root.resolved_at === null ? "UNRESOLVED" : "RESOLVED";
    lines.push(`## ${i}. ${status} — ${anchorDescriptor(root.anchor)}`);
    lines.push("");
    for (const line of root.body.split("\n")) {
      lines.push(line.length === 0 ? ">" : `> ${line}`);
    }
    lines.push("");
    lines.push(`— ${root.author}, ${root.created_at}`);
    lines.push("");
    const replies = comments
      .filter(
        (comment) =>
          comment.in_reply_to !== null &&
          threadRootOf(comments, comment)?.id === root.id,
      )
      .sort((a, b) => a.seq - b.seq);
    replies.forEach((reply, replyIndex) => {
      lines.push(
        `- ${i}.${replyIndex + 1} ${reply.author}, ${reply.created_at}: ${reply.body}`,
      );
    });
    if (replies.length > 0) {
      lines.push("");
    }
  });

  return `${lines.join("\n")}\n`;
}
