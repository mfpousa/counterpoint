// LOCAL (no network) probe of Node's global fetch (undici) compression behavior:
//   1. Does undici auto-send Accept-Encoding?
//   2. If I set Accept-Encoding myself, does it reach the server (or is it stripped as a
//      "forbidden header")?
//   3. Does undici transparently DECOMPRESS a gzip response (so res.text() is the plain body)?
// This decides whether shared rss.ts can enable gzip via a fetch header, or whether the
// server needs a lower-level fetcher.
//
//   node scripts/testUndiciGzip.mjs

import http from "node:http";
import { gzipSync } from "node:zlib";

const BODY = "<rss><channel><title>hello compression</title></channel></rss>".repeat(50);

const server = http.createServer((req, res) => {
  const ae = req.headers["accept-encoding"] || "(none)";
  // Always gzip so we can see if the client decompresses.
  const gz = gzipSync(Buffer.from(BODY, "utf8"));
  res.writeHead(200, {
    "Content-Type": "application/rss+xml",
    "Content-Encoding": "gzip",
    "Content-Length": String(gz.length),
    "X-Saw-Accept-Encoding": ae,
  });
  res.end(gz);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/`;

async function probe(label, headers) {
  const r = await fetch(url, headers ? { headers } : undefined);
  const saw = r.headers.get("x-saw-accept-encoding");
  const ce = r.headers.get("content-encoding");
  let text = "";
  let err = "";
  try {
    text = await r.text();
  } catch (e) {
    err = e.message;
  }
  const ok = text === BODY;
  console.log(
    `${label}\n  server saw Accept-Encoding: "${saw}"\n  resp content-encoding: ${ce}\n  res.text() decompressed correctly: ${ok}${err ? ` (err: ${err})` : ""}  [len=${text.length}/${BODY.length}]\n`,
  );
}

await probe("(a) fetch with NO headers", null);
await probe("(b) fetch setting Accept-Encoding: gzip, deflate, br", { "Accept-Encoding": "gzip, deflate, br" });
await probe("(c) fetchXml-style headers (Accept + UA, NO Accept-Encoding)", {
  Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
  "User-Agent": "Mozilla/5.0 (compatible; CounterpointReader/1.0)",
});

server.close();
console.log(`Node ${process.version}`);
