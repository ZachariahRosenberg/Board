// D18: agent html boards render in the host chrome — unsandboxed, scripts
// run — at the owner's explicit decision (risk acceptance in
// docs/decisions.md); there is no iframe embed anymore. A full board
// document cannot go through innerHTML (its <script> elements would never
// execute), so this module parses the stored document and mounts it by hand:
// the head's styles (board templates keep their CSS in <head>), the body's
// children, then a pass that re-creates every script element in place — a
// fresh element the browser actually evaluates. What those scripts may reach
// is still bounded by the host CSP (daemon.ts hostSecurityHeaders);
// connect-src 'self' remains the exfiltration kill-switch.

export function mountBoardDocument(
  content: string,
  container: HTMLElement,
): void {
  const doc = new DOMParser().parseFromString(content, "text/html");
  const owner = container.ownerDocument;
  container.textContent = "";
  for (const el of [
    ...doc.head.querySelectorAll("style, link[rel='stylesheet']"),
  ]) {
    container.append(owner.adoptNode(el.cloneNode(true)));
  }
  for (const child of [...doc.body.childNodes]) {
    container.append(owner.adoptNode(child.cloneNode(true)));
  }
  remountScripts(container);
}

// innerHTML / adoptNode do not (re)execute scripts: a script element only
// runs when the parser inserts it or when it is created fresh and inserted.
// Replace every script in place, copying attributes, forcing async=false so
// external scripts keep document order.
function remountScripts(container: HTMLElement): void {
  const owner = container.ownerDocument;
  for (const stale of [...container.querySelectorAll("script")]) {
    const fresh = owner.createElement("script");
    for (const attr of [...stale.attributes]) {
      fresh.setAttribute(attr.name, attr.value);
    }
    fresh.async = false;
    fresh.text = stale.textContent ?? "";
    stale.replaceWith(fresh);
  }
}
