// D18: agent html boards render in the host chrome — unsandboxed, scripts
// run — at the owner's explicit decision (risk acceptance in
// docs/decisions.md); there is no iframe embed anymore. A full board
// document cannot go through innerHTML (its <script> elements would never
// execute), so this module parses the stored document and mounts it by hand:
// the head's styles (board templates keep their CSS in <head>), the body's
// children, then a sequential pass that re-creates every script element — a
// fresh element the browser actually evaluates. What those scripts may reach
// is still bounded by the host CSP (daemon.ts hostSecurityHeaders);
// connect-src 'self' remains the exfiltration kill-switch.

interface RecordedScript {
  src: string | null;
  text: string;
}

export async function mountBoardDocument(
  content: string,
  container: HTMLElement,
): Promise<void> {
  const doc = new DOMParser().parseFromString(content, "text/html");
  const owner = container.ownerDocument;

  // Scripts are RECORDED and stripped before anything enters the DOM, for
  // two reasons a plain append would get wrong:
  // 1. a script parsed in an inert document (DOMParser) is never marked
  //    "already started", so inserting the original into the live document
  //    would execute it — and then the re-created copy would execute it AGAIN
  //    (double wiring, double charts). Originals never enter the DOM.
  // 2. head scripts (templates load /libs libs from <head>) must survive the
  //    mount — a styles-only head pass silently dropped them, which is half
  //    of the dogfooded "Chart is not defined".
  // Head first, then body: document order.
  const recorded: RecordedScript[] = [];
  const strip = (el: Element): void => {
    recorded.push({ src: el.getAttribute("src"), text: el.textContent ?? "" });
    el.remove();
  };
  for (const el of [...doc.head.querySelectorAll("script")]) {
    strip(el);
  }
  for (const el of [...doc.body.querySelectorAll("script")]) {
    strip(el);
  }

  container.textContent = "";
  for (const el of [
    ...doc.head.querySelectorAll("style, link[rel='stylesheet']"),
  ]) {
    container.append(owner.adoptNode(el.cloneNode(true)));
  }
  for (const child of [...doc.body.childNodes]) {
    container.append(owner.adoptNode(child.cloneNode(true)));
  }

  // Re-create scripts in document order at the container end. External
  // scripts are AWAITED before the next one is created: an inline script
  // must never run before its dependency is defined (the other half of the
  // dogfooded "Chart is not defined" — async=false only orders externals
  // among themselves, never against inline code). A script left detached by
  // a version switch means this mount was superseded — abort the sequence
  // rather than execute into the replaced document.
  for (const record of recorded) {
    const fresh = owner.createElement("script");
    if (record.src !== null) {
      fresh.setAttribute("src", record.src);
      container.append(fresh);
      await new Promise<void>((resolve) => {
        fresh.addEventListener("load", () => resolve(), { once: true });
        fresh.addEventListener("error", () => resolve(), { once: true });
      });
      if (!fresh.isConnected) {
        return;
      }
    } else {
      // a fresh, connected script with text content executes the moment it
      // is inserted — that IS the mechanism (innerHTML would not do this)
      fresh.text = record.text;
      container.append(fresh);
    }
  }
}
