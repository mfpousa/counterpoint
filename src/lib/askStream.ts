// Live token stream for the AI news search ("ask") synopsis, kept OUTSIDE React
// state for the same reason as the briefing stream (src/lib/briefingStream.ts): if
// each token updated component state the whole globe scene would re-render per token
// and stutter. Only the answer panel subscribes (via useSyncExternalStore), and
// notifications are COALESCED to one per animation frame.

let text = "";
const listeners = new Set<() => void>();
let frameScheduled = false;

function flush(): void {
  frameScheduled = false;
  for (const l of listeners) l();
}

function schedule(): void {
  if (frameScheduled) return;
  frameScheduled = true;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

/** Append a streamed token and schedule a (coalesced) notify. */
export function appendAskStream(delta: string): void {
  if (!delta) return;
  text += delta;
  schedule();
}

/** Clear the live stream (a new ask started, or it finished). Notifies immediately. */
export function resetAskStream(): void {
  if (text === "") return;
  text = "";
  for (const l of listeners) l();
}

/** Current accumulated synopsis text (stable reference between mutations). */
export function getAskStream(): string {
  return text;
}

/** Subscribe to stream changes; returns an unsubscribe fn (for useSyncExternalStore). */
export function subscribeAskStream(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
