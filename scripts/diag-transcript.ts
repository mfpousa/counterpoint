// Diagnostic: fetch a real YouTube transcript via the backend module.
// Needs TLS handled (corporate CA), e.g.:
//   ALLOW_INSECURE_TLS=1 npx tsx scripts/diag-transcript.ts <videoIdOrUrl>
import { fetchYouTubeTranscript, youTubeVideoId } from "../server/transcripts";

async function main() {
  const arg = process.argv[2] ?? "dQw4w9WgXcQ";
  const id = youTubeVideoId(arg) ?? arg;
  const t = await fetchYouTubeTranscript(id);
  if (!t) {
    console.log(`No transcript available for ${id}`);
  } else {
    console.log(`Transcript for ${id}: ${t.length} chars`);
    console.log("--- first 400 chars ---");
    console.log(t.slice(0, 400));
  }
}

void main();
