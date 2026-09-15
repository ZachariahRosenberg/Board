export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestContext {
  body?: unknown;
}

export interface Route {
  method: HttpMethod;
  path: string;
  handler: (req: Request, ctx: RequestContext) => Response | Promise<Response>;
}
