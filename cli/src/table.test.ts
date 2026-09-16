import { describe, expect, test } from "bun:test";
import { renderTable } from "./table.ts";

// Golden pins: the CLI's rendered tables are dogfood-visible, so the exact
// spacing is part of the contract (P3-3 extraction must be byte-identical).
describe("renderTable", () => {
  test("pads columns to the widest cell and trims the ragged right edge", () => {
    expect(
      renderTable(
        ["ID", "STATUS"],
        [
          ["abc123", "open"],
          ["x", "ended"],
        ],
      ),
    ).toEqual(["ID      STATUS", "abc123  open", "x       ended"]);
  });

  test("the header width wins when longer than every cell", () => {
    expect(renderTable(["NAME"], [["a"]])).toEqual(["NAME", "a"]);
  });
});
