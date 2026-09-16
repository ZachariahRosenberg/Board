export type Route =
  | { name: "list" }
  | { name: "board"; id: string }
  | { name: "audit" };

const BOARD_PREFIX = "#/boards/";
const AUDIT_HASH = "#/audit";

export function parseHash(hash: string): Route {
  if (hash === AUDIT_HASH) {
    return { name: "audit" };
  }
  if (hash.startsWith(BOARD_PREFIX)) {
    const id = hash.slice(BOARD_PREFIX.length);
    if (id.length > 0) {
      return { name: "board", id };
    }
  }
  return { name: "list" };
}

export function currentRoute(): Route {
  return parseHash(location.hash);
}

export function onRouteChange(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => {
    window.removeEventListener("hashchange", callback);
  };
}
