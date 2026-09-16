import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyBoardSignature } from "./smoke.ts";

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret)
    .update(Buffer.from(body))
    .digest("hex")}`;
}

// The receiver-side half of docs/feedback-grammar.md's webhook contract.
describe("verifyBoardSignature", () => {
  const secret = "smoke-webhook-secret";
  const body = JSON.stringify({ seq: 42, type: "comment.created" });

  test("accepts a valid signature", () => {
    expect(
      verifyBoardSignature(secret, Buffer.from(body), sign(secret, body)),
    ).toBe(true);
  });

  test("rejects a signature made with a different secret", () => {
    expect(
      verifyBoardSignature(secret, Buffer.from(body), sign("other", body)),
    ).toBe(false);
  });

  test("rejects a tampered body (the raw bytes are what is signed)", () => {
    expect(
      verifyBoardSignature(secret, Buffer.from(`${body} `), sign(secret, body)),
    ).toBe(false);
  });

  test("rejects a missing header", () => {
    expect(verifyBoardSignature(secret, Buffer.from(body), undefined)).toBe(
      false,
    );
  });

  test("rejects malformed headers", () => {
    for (const header of [
      "sha256",
      "deadbeef",
      `sha256=${"0".repeat(63)}`,
      `sha256=${`${"0".repeat(63)}g`}`,
      `sha256=${"0".repeat(64)}extra`,
      `sha256=${"0".repeat(64).toUpperCase()}`,
    ]) {
      expect(
        verifyBoardSignature(secret, Buffer.from(body), header),
        header,
      ).toBe(false);
    }
  });
});
