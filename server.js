// Alight Motion Preset Finder
// Runtime: Node.js 18+ (uses built-in fetch). No npm packages needed.
// Run:  node server.js   ->  http://localhost:3000

const http = require("http");

const PORT = process.env.PORT || 3000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Alight Motion share links come in a few shapes.
const PRESET_RE =
  /https?:\/\/(?:www\.)?(?:alight\.link|alightcreative\.com\/am\/share|alightmotion\.com|alightmotion\.app\.link)[^\s"'<>\\)\]]*/gi;

// ---------- helpers ----------

function isTikTokUrl(raw) {
  try {
    const u = new URL(raw);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      /(^|\.)tiktok\.com$/i.test(u.hostname)
    );
  } catch {
    return false;
  }
}

function findPresetLinks(text) {
  if (!text) return [];
  const clean = String(text).replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  const found = clean.match(PRESET_RE) || [];
  return found.map((l) => l.replace(/[.,;:!?]+$/, ""));
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: "follow", // handles vm.tiktok.com / vt.tiktok.com short links
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(12000),
  });
  return { text: await res.text(), finalUrl: res.url, ok: res.ok };
}

function readRehydration(html) {
  const m = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    const item =
      data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
    return item || null;
  } catch {
    return null;
  }
}

// ---------- comments ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns an array of comment texts (top-level + replies when available).
async function fetchComments(videoId, videoUrl) {
  const texts = [];

  // 1) TikTok's own web endpoint. Works only sometimes: TikTok may demand signed params.
  if (videoId) {
    try {
      const { text } = await fetchText(
        `https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=${videoId}&count=50&cursor=0`
      );
      const d = JSON.parse(text);
      for (const c of d.comments || []) {
        texts.push(c.text);
        for (const r of c.reply_comment || []) texts.push(r.text);
      }
    } catch {
      /* fall through */
    }
  }
  if (texts.length) return texts;

  // 2) Fallback: tikwm.com public API, up to 3 pages (~150 comments), 1 req/sec.
  let cursor = 0;
  for (let i = 0; i < 3; i++) {
    try {
      const { text } = await fetchText(
        `https://www.tikwm.com/api/comment/list/?url=${encodeURIComponent(videoUrl)}&count=50&cursor=${cursor}`
      );
      const d = JSON.parse(text);
      for (const c of d?.data?.comments || []) texts.push(c.text);
      if (!d?.data?.hasMore) break;
      cursor = d.data.cursor;
    } catch {
      break;
    }
    await sleep(1100);
  }
  return texts;
}

// ---------- core lookup ----------

async function lookup(inputUrl) {
  if (!isTikTokUrl(inputUrl)) {
    return { status: 400, body: { error: "Tempel link video TikTok yang valid (tiktok.com)." } };
  }

  const sources = []; // {where, text}
  let meta = {};
  let finalUrl = inputUrl;

  // 1) The video page itself: caption + creator bio live in embedded JSON.
  try {
    const page = await fetchText(inputUrl);
    finalUrl = page.finalUrl || inputUrl;
    const item = readRehydration(page.text);
    if (item) {
      meta = {
        author: item.author?.uniqueId || "",
        caption: item.desc || "",
      };
      sources.push({ where: "caption", text: item.desc });
      sources.push({ where: "bio kreator", text: item.author?.signature });
    }
    // Fallback: scan the raw HTML in case the JSON shape changes.
    sources.push({ where: "page", text: page.text });
  } catch {
    /* fall through to oEmbed */
  }

  // 2) oEmbed: lightweight and stable, returns the caption as "title".
  try {
    const { text } = await fetchText(
      "https://www.tiktok.com/oembed?url=" + encodeURIComponent(inputUrl)
    );
    const o = JSON.parse(text);
    if (!meta.caption && o.title) meta.caption = o.title;
    if (!meta.author && o.author_unique_id) meta.author = o.author_unique_id;
    sources.push({ where: "caption", text: o.title });
  } catch {
    /* ignore */
  }

  if (!sources.length) {
    return {
      status: 502,
      body: { error: "Video tidak bisa dijangkau. Periksa linknya lalu coba lagi." },
    };
  }

  // Comments: caption and bio were pushed first, so they win the label if a link repeats.
  const videoId = (finalUrl.match(/\/video\/(\d+)/) || [])[1];
  const comments = await fetchComments(videoId, finalUrl);
  for (const c of comments) sources.push({ where: "komentar", text: c });

  // Collect, label by first place found, dedupe.
  const seen = new Map();
  for (const s of sources) {
    for (const link of findPresetLinks(s.text)) {
      if (!seen.has(link)) seen.set(link, s.where === "page" ? "halaman video" : s.where);
    }
  }

  const links = [...seen].map(([url, where]) => ({ url, where }));
  return { status: 200, body: { links, author: meta.author || null, caption: meta.caption || "" } };
}

// ---------- tiny rate limit (per IP, 20 req/min) ----------
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/api/find") {
    const ip = req.socket.remoteAddress || "x";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (limited(ip)) {
      res.statusCode = 429;
      return res.end(JSON.stringify({ error: "Terlalu banyak permintaan. Tunggu semenit." }));
    }
    try {
      const out = await lookup((u.searchParams.get("url") || "").trim());
      res.statusCode = out.status;
      return res.end(JSON.stringify(out.body));
    } catch {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: "Terjadi kesalahan. Coba lagi." }));
    }
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(PAGE);
});

server.listen(PORT, () => console.log(`RFHT running on http://localhost:${PORT}`));

// ---------- front end ----------

const PAGE = /* html */ `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RFHT: Pencari Preset Alight Motion</title>
<style>
  :root {
    --paper: #f3f1f8;
    --ink: #1c1736;
    --muted: #6b6585;
    --line: #d9d4e8;
    --key: #6a4cf5;
    --key-ink: #ffffff;
    --ok: #1c7a54;
    --err: #b3261e;
    --card: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #14102a; --ink: #eeeaff; --muted: #9a94b8; --line: #2c2650;
      --key: #8d76ff; --key-ink: #14102a; --ok: #5fd3a0; --err: #ff8a80; --card: #1d1840;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--paper); color: var(--ink);
    font-family: "Avenir Next", "Segoe UI", system-ui, sans-serif;
    line-height: 1.5; min-height: 100vh;
    padding: 56px 20px 80px;
  }
  main { max-width: 620px; margin: 0 auto; }
  h1 {
    font-size: clamp(2rem, 6vw, 3rem); line-height: 1.05; letter-spacing: -0.02em;
    margin: 0 0 12px; font-weight: 800;
  }
  .lede { color: var(--muted); margin: 0 0 32px; max-width: 46ch; }

  /* Timeline strip: the one memorable element */
  .brand {
    font-weight: 800; font-size: 1.5rem; letter-spacing: .04em; margin: 0 0 14px;
  }
  .strip {
    display: flex; align-items: center; gap: 0; margin: 0 0 28px; height: 22px;
  }
  .strip i { flex: 1; height: 2px; background: var(--line); }
  .strip b {
    width: 12px; height: 12px; background: var(--key); transform: rotate(45deg);
    margin: 0 6px; border-radius: 2px;
  }
  .strip b:nth-child(4) { background: transparent; border: 2px solid var(--key); }

  label { display: block; font-weight: 600; margin-bottom: 8px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  input {
    flex: 1 1 280px; min-width: 0; font: inherit; color: var(--ink);
    background: var(--card); border: 1.5px solid var(--line); border-radius: 10px;
    padding: 14px 14px;
  }
  input:focus-visible, button:focus-visible, a:focus-visible {
    outline: 3px solid var(--key); outline-offset: 2px;
  }
  button {
    font: inherit; font-weight: 700; cursor: pointer; border: 0; border-radius: 10px;
    padding: 14px 22px; background: var(--key); color: var(--key-ink);
  }
  button:disabled { opacity: .6; cursor: wait; }
  button.ghost {
    background: transparent; color: var(--key); border: 1.5px solid var(--key);
    padding: 8px 14px; font-size: .9rem;
  }

  #out { margin-top: 32px; }
  .status { margin: 0 0 12px; color: var(--muted); }
  .status.err { color: var(--err); }
  .status.ok { color: var(--ok); }
  .hit {
    background: var(--card); border: 1.5px solid var(--line); border-radius: 12px;
    padding: 14px 16px; margin: 0 0 10px; display: grid; gap: 10px;
  }
  .hit .url { word-break: break-all; color: var(--ink); font-weight: 600; }
  .hit .meta { color: var(--muted); font-size: .88rem; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions a { text-decoration: none; display: inline-block; }
  .tips { margin-top: 24px; color: var(--muted); font-size: .92rem; }
  .tips p { margin: 0 0 6px; }
  @media (prefers-reduced-motion: no-preference) {
    .hit { animation: in .25s ease-out; }
    @keyframes in { from { opacity: 0; transform: translateY(4px); } }
  }
</style>
</head>
<body>
<main>
  <div class="brand">RFHT</div>
  <div class="strip" aria-hidden="true"><i></i><b></b><i></i><b></b><i></i><b></b><i></i></div>
  <h1>Cari preset Alight Motion dari video edit TikTok</h1>
  <p class="lede">Tempel link video TikTok. Kami cari link preset di caption, komentar, dan bio kreatornya.</p>

  <label for="url">Link video TikTok</label>
  <div class="row">
    <input id="url" type="url" inputmode="url" placeholder="https://www.tiktok.com/@creator/video/…" autocomplete="off">
    <button id="go" type="button">Cari preset</button>
  </div>

  <section id="out" aria-live="polite"></section>

  <div class="tips">
    <p>Tidak ketemu? Pencarian komentar hanya mencakup sekitar 150 komentar teratas, dan link yang ditulis di dalam video (overlay) tidak bisa dibaca. Coba cek langsung di aplikasinya.</p>
  </div>
</main>

<script>
  const input = document.getElementById("url");
  const btn = document.getElementById("go");
  const out = document.getElementById("out");

  function status(msg, cls) {
    out.replaceChildren();
    const p = document.createElement("p");
    p.className = "status " + (cls || "");
    p.textContent = msg;
    out.append(p);
    return p;
  }

  function card(link) {
    const box = document.createElement("div");
    box.className = "hit";

    const url = document.createElement("div");
    url.className = "url";
    url.textContent = link.url;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = "Ditemukan di " + link.where;

    const actions = document.createElement("div");
    actions.className = "actions";

    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "ghost"; copy.textContent = "Salin link";
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(link.url); copy.textContent = "Tersalin"; }
      catch { copy.textContent = "Tekan Ctrl+C pada link"; }
      setTimeout(() => (copy.textContent = "Salin link"), 1600);
    };

    const open = document.createElement("a");
    open.href = link.url; open.target = "_blank"; open.rel = "noopener noreferrer";
    const openBtn = document.createElement("button");
    openBtn.type = "button"; openBtn.className = "ghost"; openBtn.textContent = "Buka di Alight Motion";
    open.append(openBtn);

    actions.append(copy, open);
    box.append(url, meta, actions);
    return box;
  }

  async function run() {
    const value = input.value.trim();
    if (!value) { status("Tempel link TikTok dulu.", "err"); return; }
    btn.disabled = true; btn.textContent = "Mencari…";
    status("Mencari di video…");
    try {
      const r = await fetch("/api/find?url=" + encodeURIComponent(value));
      const data = await r.json();
      if (!r.ok) { status(data.error || "Permintaan gagal.", "err"); return; }
      if (!data.links.length) {
        status("Link preset Alight Motion tidak ditemukan di caption, komentar, maupun bio kreator.", "err");
        return;
      }
      out.replaceChildren();
      const head = document.createElement("p");
      head.className = "status ok";
      head.textContent = data.links.length === 1 ? "Ditemukan 1 link preset" : "Ditemukan " + data.links.length + " link preset";
      out.append(head, ...data.links.map(card));
    } catch {
      status("Server tidak bisa dihubungi. Sudah dijalankan?", "err");
    } finally {
      btn.disabled = false; btn.textContent = "Cari preset";
    }
  }

  btn.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
</script>
</body>
</html>`;
