// Live briefing token stream kept OUTSIDE React state. The briefing streams token
// by token; if each token updated global AppContext state, EVERY context consumer
// (the whole Today screen — feed list, globe, …) would re-render per token, causing
// page-wide stutter. Instead the tokens live here and ONLY BriefingCard subscribes
// (via useSyncExternalStore), so streaming never touches the rest of the tree.
//
// Notifications are COALESCED to one per animation frame, so a fast burst of tokens
// can't fire more renders than the display can show.

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
  // rAF batches a burst of tokens into a single render per frame.
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

/** Append a streamed token and schedule a (coalesced) notify. */
export function appendBriefingStream(delta: string): void {
  if (!delta) return;
  text += delta;
  schedule();
}

/** Clear the live stream (cached briefing replaced it, or it finished). Notifies
 *  IMMEDIATELY so the card swaps to the final/cached view without a frame's lag. */
export function resetBriefingStream(): void {
  if (text === "") return;
  text = "";
  for (const l of listeners) l();
}

/** Current accumulated stream text (stable reference between mutations). */
export function getBriefingStream(): string {
  return text;
}

/** Subscribe to stream changes; returns an unsubscribe fn (for useSyncExternalStore). */
export function subscribeBriefingStream(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
