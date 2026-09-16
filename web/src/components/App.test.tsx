import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createComponentHarness, installDom } from "../test-dom.ts";
import { clearSessionToken, setSessionToken } from "../token.ts";
import { App, Gate } from "./App.tsx";
import { exchangeCalls, installApiMock } from "./test-api.ts";

installDom();
installApiMock();

const { render, cleanup } = createComponentHarness();
afterEach(cleanup);

describe("Gate", () => {
  test("renders the paste gate; an empty submit is a no-op", async () => {
    exchangeCalls.length = 0;
    let ready = false;
    const container = render(<Gate onReady={() => (ready = true)} />);
    expect(container.querySelector("input")).not.toBe(null);
    const submitButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "open",
    ) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(exchangeCalls).toEqual([]);
    expect(ready).toBe(false);
    expect(container.innerHTML).toContain("make open");
  });
});

describe("App", () => {
  test("with a stored session it renders the board list", async () => {
    setSessionToken("sess-ok");
    location.hash = "#/";
    const container = render(<App />);
    await act(async () => {});
    expect(container.innerHTML).toContain("Decision brief");
    clearSessionToken();
  });
});
