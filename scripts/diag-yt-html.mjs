// Inspect what YouTube returns for a cookieless watch-page request.
const id = process.argv[2] ?? "dQw4w9WgXcQ";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function get(url, headers) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  return { status: res.status, text: await res.text() };
}

for (const label of ["plain", "consent-cookie"]) {
  const headers =
    label === "consent-cookie"
      ? { "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1" }
      : { "Accept-Language": "en-US,en;q=0.9" };
  const { status, text } = await get(`https://www.youtube.com/watch?v=${id}&hl=en`, headers);
  const hasCaptions = text.includes("captionTracks");
  const isConsent = text.includes("consent.youtube.com") || text.includes("Before you continue");
  const m = text.match(/"captionTracks":(\[.*?\])/);
  console.log(
    `[${label}] status=${status} len=${text.length} captionTracks=${hasCaptions} consent=${isConsent} trackArrayLen=${m ? m[1].length : 0}`,
  );
  if (m) {
    let tracks = [];
    try {
      tracks = JSON.parse(m[1]);
    } catch (e) {
      console.log(`  JSON.parse failed: ${e.message}`);
    }
    console.log(`  tracks=${tracks.length} langs=${tracks.map((t) => t.languageCode).join(",")}`);
    const t = tracks.find((x) => (x.languageCode || "").startsWith("en")) || tracks[0];
    if (t?.baseUrl) {
      console.log(`  baseUrl head: ${t.baseUrl.slice(0, 120)}`);
      for (const variant of ["", "&fmt=srv3", "&fmt=json3"]) {
        const r = await get(t.baseUrl + variant, headers);
        console.log(`    fetch${variant || "(plain)"} -> status=${r.status} len=${r.text.length} head=${JSON.stringify(r.text.slice(0, 80))}`);
      }
    }
  }
}
