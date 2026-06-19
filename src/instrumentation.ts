// Next.js startup hook. The node-only continuous-loop bootstrap (heartbeat + rebake) lives in ./bootstrap
// and is imported ONLY behind the `NEXT_RUNTIME === "nodejs"` guard below — the shape Next's bundler
// recognizes to keep node-only deps (the scheduler → `pg` cross-process lock) out of the edge bundle.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrap } = await import("./bootstrap");
    await bootstrap();
  }
}
