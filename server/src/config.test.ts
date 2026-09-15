import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeConfig } from "./config.ts";

describe("makeConfig defaults", () => {
  test("applies documented defaults when env is empty", () => {
    const config = makeConfig({});
    expect(config.dataDir).toBe(join(homedir(), ".board"));
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(7800);
    expect(config.bind).toEqual(["127.0.0.1"]);
  });
});

describe("makeConfig env parsing", () => {
  test("reads every variable", () => {
    const config = makeConfig({
      BOARD_DATA_DIR: "/tmp/board-data",
      BOARD_HOST: "localhost",
      BOARD_PORT: "8000",
      BOARD_BIND: "127.0.0.1,host.docker.internal",
    });
    expect(config.dataDir).toBe("/tmp/board-data");
    expect(config.host).toBe("localhost");
    expect(config.port).toBe(8000);
    expect(config.bind).toEqual(["127.0.0.1", "host.docker.internal"]);
  });

  test("accepts port 0 for an ephemeral binding", () => {
    const config = makeConfig({ BOARD_PORT: "0" });
    expect(config.port).toBe(0);
  });

  test("expands ~ in BOARD_DATA_DIR", () => {
    const config = makeConfig({ BOARD_DATA_DIR: "~/.board-alt" });
    expect(config.dataDir).toBe(join(homedir(), ".board-alt"));
  });

  test("resolves a relative BOARD_DATA_DIR against the working directory", () => {
    const config = makeConfig({ BOARD_DATA_DIR: "data/here" });
    expect(config.dataDir).toBe(join(process.cwd(), "data/here"));
  });

  test("trims, lowercases, and dedupes BOARD_BIND entries", () => {
    const config = makeConfig({
      BOARD_BIND: " HOST.DOCKER.INTERNAL ,127.0.0.1, host.docker.internal ",
    });
    expect(config.bind).toEqual(["host.docker.internal", "127.0.0.1"]);
  });

  test("empty BOARD_BIND keeps the loopback-only default", () => {
    const config = makeConfig({ BOARD_BIND: "" });
    expect(config.bind).toEqual(["127.0.0.1"]);
  });
});

describe("makeConfig rejects bad values", () => {
  test("throws on a non-numeric BOARD_PORT", () => {
    expect(() => makeConfig({ BOARD_PORT: "abc" })).toThrow(/BOARD_PORT/);
  });

  test("throws on a negative BOARD_PORT", () => {
    expect(() => makeConfig({ BOARD_PORT: "-1" })).toThrow(/BOARD_PORT/);
  });

  test("throws on a fractional BOARD_PORT", () => {
    expect(() => makeConfig({ BOARD_PORT: "78.5" })).toThrow(/BOARD_PORT/);
  });

  test("throws on BOARD_PORT above 65535", () => {
    expect(() => makeConfig({ BOARD_PORT: "65536" })).toThrow(/BOARD_PORT/);
  });

  test("throws on an empty BOARD_PORT", () => {
    expect(() => makeConfig({ BOARD_PORT: "" })).toThrow(/BOARD_PORT/);
  });

  test("throws on an empty BOARD_HOST", () => {
    expect(() => makeConfig({ BOARD_HOST: "" })).toThrow(/BOARD_HOST/);
  });

  test("throws on a BOARD_HOST containing whitespace", () => {
    expect(() => makeConfig({ BOARD_HOST: "bad host" })).toThrow(/BOARD_HOST/);
  });

  test("throws on an empty BOARD_DATA_DIR", () => {
    expect(() => makeConfig({ BOARD_DATA_DIR: "" })).toThrow(/BOARD_DATA_DIR/);
  });

  test("throws on an empty BOARD_BIND entry", () => {
    expect(() => makeConfig({ BOARD_BIND: "a,,b" })).toThrow(/BOARD_BIND/);
  });
});
