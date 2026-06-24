// One-off probe: do real feeds honor gzip/br, how much smaller is the wire payload,
// and does Node 18's global fetch (undici) transparently DECOMPRESS when we send
// Accept-Encoding (so the shared rss.ts can just add the header and rely on res.text()).
//
//   node scripts/testFeedGzip.mjs

import https from "node:https";
import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";

const URLS = [
  // Reachable from this machine (curl hit raw.githubusercontent.com); supports gzip on
  // text. Used to confirm node has outbound + undici decompresses transparently.
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_tiny_countries.geojson",
  // Real feeds (may be firewall-blocked here, but prove gzip support if reachable).
  "https://www.theguardian.com/world/rss",
  "https://feeds.npr.org/1001/rss.xml",
];

const UA = "Mozilla/5.0 (compatible; CounterpointReader/1.0; +https://github.com/counterpoint)";

// Raw https GET counting on-wire bytes + reading Content-Encoding.
function rawGet(url, acceptEncoding) {
  return new Promise((resolve) => {
    const headers = { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" };
    if (acceptEncoding) headers["Accept-Encoding"] = acceptEncoding;
    https
      .get(url, { headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, enc: res.headers["content-encoding"] || null, wire: buf.length, buf });
        });
      })
      .on("error", () => resolve({ status: 0, enc: null, wire: 0, buf: Buffer.alloc(0) }));
  });
}

function decompress(buf, enc) {
  try {
    if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
    if (enc === "br") return brotliDecompressSync(buf);
    if (enc === "deflate") return inflateSync(buf);
    return buf;
  } catch {
    return buf;
  }
}

for (const url of URLS) {
  const plain = await rawGet(url, null);
  const gz = await rawGet(url, "gzip, deflate, br");
  const decoded = decompress(gz.buf, gz.enc);

  // Does undici fetch transparently decompress when we ask for gzip?
  let fetchOk = "?";
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate, br" } });
    const t = await r.text();
    const head = t.trimStart()[0];
    fetchOk = head === "<" || head === "{" || head === "[" ? `valid-text(${t.length}b)` : `BINARY?(${t.slice(0, 12).replace(/\s+/g, " ")})`;
  } catch (e) {
    fetchOk = `ERR ${e.message}`;
  }

  const kb = (n) => (n / 1024).toFixed(1) + "kb";
  const ratio = plain.wire > 0 ? ((1 - gz.wire / plain.wire) * 100).toFixed(0) + "%" : "—";
  console.log(
    `${url}\n  plain=${kb(plain.wire)}  gzipReq=${kb(gz.wire)} (enc=${gz.enc}, decoded=${kb(decoded.length)}, saved=${ratio})  fetch+gzip=${fetchOk}\n`,
  );
}
