import { eq } from "drizzle-orm";
import { z } from "zod";
import { EngineError } from "@/lib/engine/types";
import { getDb } from "@/lib/server/db/client";
import { paperAccounts } from "@/lib/server/db/schema";
import { LIVE_ACCOUNT_ID } from "@/lib/server/db/seed";
import { body, json, route } from "@/lib/server/http";
import { appendEvents, getAccount, listOrders, listPositions } from "@/lib/server/repo/trading";
import { costsSchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Reset the live paper balance (and optionally its cost model). Only allowed when
 * flat, so no open exposure is silently re-based. Past trades stay in the journal.
 */
export const POST = route(async (req: Request) => {
  const input = await body(req, z.object({ startingBalance: z.number().positive().max(1e12), costs: costsSchema.optional() }));
  const db = getDb();
  if (listPositions(db, LIVE_ACCOUNT_ID, { status: "open" }).length || listOrders(db, LIVE_ACCOUNT_ID, { status: ["pending"] }).length) {
    throw new EngineError("Close all live positions and cancel pending orders before resetting");
  }
  const before = getAccount(db, LIVE_ACCOUNT_ID)!;
  db.transaction((tx) => {
    tx.update(paperAccounts)
      .set({ startingBalance: input.startingBalance, balance: input.startingBalance, ...(input.costs ? { costs: input.costs } : {}), updatedAt: Date.now() })
      .where(eq(paperAccounts.id, LIVE_ACCOUNT_ID))
      .run();
    appendEvents(tx, LIVE_ACCOUNT_ID, null, [
      { type: "account_reset", simTime: Date.now(), payload: { previousBalance: before.balance, startingBalance: input.startingBalance, costs: input.costs ?? before.costs } },
    ]);
  });
  return json(getAccount(db, LIVE_ACCOUNT_ID));
});
