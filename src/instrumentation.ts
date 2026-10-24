/**
 * Runs once when the Next.js server starts. Resumes live paper-order monitoring so
 * pending orders and open positions are reconciled after the app was offline.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.TRADELAB_DISABLE_LIVE === "1") return;
  try {
    const { getLiveFeed } = await import("./lib/server/services/live");
    getLiveFeed();
  } catch (err) {
    console.error("[live] failed to start live feed", err);
  }
}
