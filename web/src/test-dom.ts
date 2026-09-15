import { Window } from "happy-dom";

// Minimal EventSource test double: BoardStream only needs addEventListener +
// close, and tests need to fire frames and inspect instances.
export class StubEventSource {
  static instances: StubEventSource[] = [];

  readonly url: string;
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, callback: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(callback);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const callback of this.listeners.get(type) ?? []) {
      callback(event);
    }
  }

  close(): void {
    this.listeners.clear();
  }
}

// happy-dom globals for the web tests (no browser, no jsdom): install exactly
// what the app + react-dom/client touch, nothing more.
export function installDom(): Window {
  const window = new Window({ url: "http://127.0.0.1:5173/" });
  StubEventSource.instances = [];
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
    // test double, not the real SSE client (see StubEventSource above)
    EventSource: StubEventSource as unknown as typeof EventSource,
  });
  return window;
}
