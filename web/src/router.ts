export type Route = { name: "list" } | { name: "board"; id: string };

const BOARD_PREFIX = "#/boards/";

export function parseHash(hash: string): Route {
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

export function navigate(route: Route): void {
  location.hash = route.name === "board" ? `${BOARD_PREFIX}${route.id}` : "#/";
}

export function onRouteChange(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => {
    window.removeEventListener("hashchange", callback);
  };
}
