import { Window } from "happy-dom";

// happy-dom globals for the web tests (no browser, no jsdom): install exactly
// what the app + react-dom/client touch, nothing more.
export function installDom(): Window {
  const window = new Window({ url: "http://127.0.0.1:5173/" });
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    DOMParser: window.DOMParser,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return window;
}
