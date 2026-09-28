import assert from "node:assert/strict";

// Native pi-subagents owns the capacity and its process-terminal proof. This
// scheduler only prevents our concurrent review launches from racing for the
// same parent's slots; it never creates, releases, or overrides a native slot.
export function createReviewLaunchScheduler(events) {
  assert.equal(typeof events?.on, "function", "Pi event bus required");
  const tails = new Map();

  return async function scheduleReviewLaunch(
    { owner, rpc, signal, timeoutMs },
    launch,
  ) {
    assert.ok(typeof owner === "string" && owner, "review owner required");
    assert.equal(typeof rpc?.ping, "function", "native RPC ping required");
    assert.equal(typeof rpc?.request, "function", "native RPC status required");
    assert.equal(typeof launch, "function", "review launch required");
    assert.ok(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
      "bounded review deadline required",
    );
    const previous = tails.get(owner) ?? Promise.resolve();
    let release;
    const baton = new Promise((resolve) => {
      release = resolve;
    });
    tails.set(owner, baton);
    await previous;
    try {
      signal?.throwIfAborted();
      const ping = await rpc.ping();
      assert.equal(ping?.capabilities?.status, true, "native status required");
      const names = [ping.events?.asyncComplete, ping.events?.processTerminal];
      assert.ok(
        names.every((name) => typeof name === "string" && name),
        "native completion events required",
      );
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        signal?.throwIfAborted();
        const remaining = deadline - Date.now();
        assert.ok(remaining > 0, "review capacity wait deadline reached");
        // Subscribe before status so a completion between the read and wait
        // cannot strand a queued review. An unrelated event only rechecks.
        let dispose;
        const wake = new Promise((resolve, reject) => {
          const unsubscribes = names.map((name) => events.on(name, resolve));
          const onAbort = () =>
            reject(new Error("review capacity wait cancelled"));
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
          const timer = setTimeout(
            () => reject(new Error("review capacity wait deadline reached")),
            Math.min(remaining, 2_147_483_647),
          );
          dispose = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            for (const unsubscribe of unsubscribes) unsubscribe?.();
          };
        });
        // The status call may finish after an abort/timeout; its own error must
        // remain authoritative without leaking a rejection from the unused wake.
        void wake.catch(() => {});
        try {
          const status = await rpc.request("status");
          const capacity = status?.fleet?.topLevelAsyncCapacity;
          assert.ok(
            Number.isSafeInteger(capacity?.used) &&
              capacity.used >= 0 &&
              Number.isSafeInteger(capacity?.limit) &&
              capacity.limit >= 0,
            "native active-async capacity snapshot missing",
          );
          if (capacity.limit === 0 || capacity.used < capacity.limit) {
            signal?.throwIfAborted();
            return await launch();
          }
          await wake;
        } finally {
          dispose();
        }
      }
    } finally {
      release();
      if (tails.get(owner) === baton) tails.delete(owner);
    }
  };
}
