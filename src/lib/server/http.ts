import { ZodError, type ZodType } from "zod";
import { EngineError } from "@/lib/engine/types";
import { MarketDataError } from "@/lib/market/provider";
import { DuplicateExecutionError } from "./repo/trading";
import { ConflictError, NotFoundError } from "./services/backtest";

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

function errorResponse(err: unknown) {
  if (err instanceof ZodError) {
    return json({ error: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") }, { status: 400 });
  }
  if (err instanceof NotFoundError) return json({ error: err.message }, { status: 404 });
  if (err instanceof ConflictError || err instanceof DuplicateExecutionError) return json({ error: err.message, conflict: true }, { status: 409 });
  if (err instanceof EngineError) return json({ error: err.message }, { status: 422 });
  if (err instanceof MarketDataError) return json({ error: `Market data unavailable: ${err.message}` }, { status: 502 });
  console.error(err);
  return json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 });
}

/** Wrap a route handler with uniform error mapping. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new EngineError("Request body must be JSON");
  }
  return schema.parse(raw);
}

export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}
