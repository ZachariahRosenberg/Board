import { describe, expect, test } from "bun:test";
import { HttpError } from "./http.ts";
import {
  asEnum,
  asInt,
  asNonNegativeIntString,
  asOptionalString,
  asString,
  asStringArray,
} from "./validate.ts";

const FORMATS = ["markdown", "html"] as const;

function expectInvalid(run: () => unknown, field: string): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const httpErr = err as HttpError;
    expect(httpErr.status).toBe(400);
    expect(httpErr.code).toBe("invalid_request");
    expect(httpErr.message).toContain(field);
    return;
  }
  throw new Error(`expected invalid_request mentioning "${field}"`);
}

describe("asString", () => {
  test("returns the value for a string", () => {
    expect(asString("hello", "title")).toBe("hello");
  });

  test("rejects non-strings with the field name", () => {
    for (const bad of [42, null, undefined, true, ["x"], {}]) {
      expectInvalid(() => asString(bad, "title"), "title");
    }
  });
});

describe("asOptionalString", () => {
  test("passes undefined through", () => {
    expect(asOptionalString(undefined, "label")).toBeUndefined();
  });

  test("returns the value for a string", () => {
    expect(asOptionalString("note", "label")).toBe("note");
  });

  test("rejects non-strings with the field name", () => {
    for (const bad of [42, null, false]) {
      expectInvalid(() => asOptionalString(bad, "label"), "label");
    }
  });
});

describe("asInt", () => {
  test("returns integer numbers", () => {
    expect(asInt(0, "expected_version")).toBe(0);
    expect(asInt(42, "from_n")).toBe(42);
  });

  test("rejects non-numbers and non-integers with the field name", () => {
    for (const bad of ["1", 1.5, NaN, Infinity, null, undefined, true]) {
      expectInvalid(() => asInt(bad, "expected_version"), "expected_version");
    }
  });
});

describe("asEnum", () => {
  test("returns a member of the enum", () => {
    expect(asEnum("markdown", "format", FORMATS)).toBe("markdown");
    expect(asEnum("html", "format", FORMATS)).toBe("html");
  });

  test("rejects anything else, listing the options", () => {
    for (const bad of ["pdf", "", 3, null, undefined]) {
      expectInvalid(() => asEnum(bad, "format", FORMATS), "format");
    }
    try {
      asEnum("pdf", "format", FORMATS);
    } catch (err) {
      expect((err as HttpError).message).toContain("markdown, html");
    }
  });
});

describe("asStringArray", () => {
  test("returns a string array", () => {
    expect(asStringArray(["a", "b"], "tags")).toEqual(["a", "b"]);
    expect(asStringArray([], "tags")).toEqual([]);
  });

  test("rejects non-arrays and mixed arrays with the field name", () => {
    for (const bad of ["a", [1], ["a", 1], null, undefined, { 0: "a" }]) {
      expectInvalid(() => asStringArray(bad, "tags"), "tags");
    }
  });
});

describe("asNonNegativeIntString", () => {
  test("maps null to undefined and digit strings to numbers", () => {
    expect(asNonNegativeIntString(null, "since")).toBeUndefined();
    expect(asNonNegativeIntString("0", "since")).toBe(0);
    expect(asNonNegativeIntString("42", "since")).toBe(42);
  });

  test("rejects malformed strings with the field name", () => {
    for (const bad of [
      "abc",
      "",
      "-1",
      "1.5",
      "+1",
      " 1",
      "1 ",
      "99999999999999999999",
    ]) {
      expectInvalid(() => asNonNegativeIntString(bad, "since"), "since");
    }
  });
});
