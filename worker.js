// Alight Motion Preset Finder
// Versi Cloudflare Workers: tempel seluruh isi file ini di editor Worker.

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

// ---------- downloader (TikTok) ----------

// Cara disarankan: isi secret bernama SECRET di Cloudflare (Settings > Variables and Secrets),
// jadi kode ini tidak perlu diedit. Teks di bawah hanya cadangan.
let SECRET = "GANTI-INI-DENGAN-KATA-ACAK-PANJANG";
const GATE_SECONDS = 8; // lama iklan ditampilkan sebelum HD bisa diunduh

const json = (body, status = 200) => Response.json(body, { status });

async function sign(msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeToken(url) {
  const ts = Date.now();
  return ts + "." + (await sign(ts + "|" + url));
}

async function checkToken(token, url) {
  const [ts, sig] = String(token || "").split(".");
  if (!ts || !sig || sig !== (await sign(ts + "|" + url))) return false;
  const age = (Date.now() - Number(ts)) / 1000;
  return age >= GATE_SECONDS - 0.5 && age <= 900; // berlaku 15 menit
}

async function getVideo(inputUrl) {
  const res = await fetch(inputUrl, {
    redirect: "follow",
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(12000),
  });
  const html = await res.text();
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookies = raw.map((c) => c.split(";")[0]).join("; ");
  return { item: readRehydration(html), cookies };
}

const codecName = (c) =>
  /265|hevc|hvc|hev/i.test(c || "") ? "H.265" : /264|avc/i.test(c || "") ? "H.264" : "";

function pickFormats(item) {
  const v = item?.video || {};
  // Urutkan dari resolusi tertinggi (lalu bitrate), karena bitrate saja menyesatkan:
  // H.265 bisa lebih tajam dengan bitrate lebih kecil dari H.264.
  const tiers = (v.bitrateInfo || [])
    .map((b) => ({
      url: (b.PlayAddr?.UrlList || [])[0],
      bitrate: b.Bitrate || 0,
      w: b.PlayAddr?.Width || 0,
      h: b.PlayAddr?.Height || 0,
      size: Number(b.PlayAddr?.DataSize) || 0,
      codec: codecName(b.CodecType),
    }))
    .filter((t) => t.url)
    .sort((a, b) => b.w * b.h - a.w * a.h || b.bitrate - a.bitrate);

  let std = null;
  if (v.playAddr) {
    const size = Number(v.size) || 0;
    const match = tiers.find((t) => size && t.size === size);
    std = { url: v.playAddr, w: v.width || 0, h: v.height || 0, size, codec: match ? match.codec : "" };
  } else if (tiers.length) {
    std = tiers[tiers.length - 1];
  }

  // HD hanya ditawarkan kalau benar-benar lebih baik: piksel minimal 10% lebih banyak
  // DAN ukuran file tidak lebih kecil dari standar (file lebih kecil = bitrate turun, bukan lebih tajam).
  const stdPx = std ? std.w * std.h : 0;
  const better = (t) =>
    t.url !== (std && std.url) &&
    t.w * t.h > stdPx * 1.1 &&
    (!std || !std.size || !t.size || t.size >= std.size * 0.9);
  const hd = tiers.find(better) || null;
  return { std, hd, audio: item?.music?.playUrl || null };
}

const brief = (t) => {
  const p = Math.min(t.w || 0, t.h || 0);
  return { label: p ? p + "p" : "", size: t.size || 0, codec: t.codec || "" };
};

async function handleInfo(u) {
  const url = (u.searchParams.get("url") || "").trim();
  if (!isTikTokUrl(url)) return json({ error: "Tempel link video TikTok yang valid (tiktok.com)." }, 400);
  const { item } = await getVideo(url);
  if (!item) return json({ error: "Video tidak bisa dibaca. Pastikan videonya publik, lalu coba lagi." }, 502);
  const f = pickFormats(item);
  if (!f.std && !f.hd && !f.audio) return json({ error: "Tidak ada file video yang bisa diunduh dari postingan ini." }, 404);
  return json({
    author: item.author?.uniqueId || "",
    caption: item.desc || "",
    std: f.std ? brief(f.std) : null,
    hd: f.hd ? brief(f.hd) : null,
    audio: !!f.audio,
  });
}

// Diagnosa: tampilkan struktur data video (tanpa link file) untuk melihat kualitas apa saja yang ada.
async function handleDebug(u) {
  const url = (u.searchParams.get("url") || "").trim();
  if (!isTikTokUrl(url)) return json({ error: "Link tidak valid." }, 400);
  const { item } = await getVideo(url);
  if (!item) return json({ error: "Data video tidak terbaca (kemungkinan TikTok memblokir server)." }, 502);
  const v = item.video || {};
  const f = pickFormats(item);
  return json({
    videoKeys: Object.keys(v),
    hasPlayAddr: !!v.playAddr,
    hasDownloadAddr: !!v.downloadAddr,
    videoWidth: v.width, videoHeight: v.height, definition: v.definition, size: v.size,
    tiers: (v.bitrateInfo || []).map((b) => ({
      gear: b.GearName, quality: b.QualityType, bitrate: b.Bitrate, codec: b.CodecType,
      w: b.PlayAddr?.Width, h: b.PlayAddr?.Height, bytes: b.PlayAddr?.DataSize,
      urls: (b.PlayAddr?.UrlList || []).length,
    })),
    stdOffered: !!f.std, hdOffered: !!f.hd, audioOffered: !!f.audio,
  });
}

async function handleGate(u) {
  const url = (u.searchParams.get("url") || "").trim();
  if (!isTikTokUrl(url)) return json({ error: "Link tidak valid." }, 400);
  return json({ token: await makeToken(url), seconds: GATE_SECONDS });
}

async function handleDownload(u) {
  const url = (u.searchParams.get("url") || "").trim();
  const q = u.searchParams.get("q") || "std";
  if (!isTikTokUrl(url)) return json({ error: "Link tidak valid." }, 400);
  if (q === "hd" && !(await checkToken(u.searchParams.get("t"), url))) {
    return json({ error: "Sesi HD belum selesai atau sudah habis. Ulangi dari tombol HD." }, 403);
  }

  const { item, cookies } = await getVideo(url);
  if (!item) return json({ error: "Video tidak bisa dibaca. Coba lagi." }, 502);
  const f = pickFormats(item);
  const target = q === "audio" ? f.audio : q === "hd" ? f.hd?.url : f.std?.url;
  if (!target) return json({ error: "Format ini tidak tersedia untuk video ini." }, 404);

  // CDN TikTok biasanya menolak permintaan tanpa Referer/Cookie, jadi file dialirkan lewat Worker.
  const media = await fetch(target, {
    headers: {
      "User-Agent": UA,
      Referer: "https://www.tiktok.com/",
      ...(cookies ? { Cookie: cookies } : {}),
    },
  });
  if (!media.ok || !media.body) return json({ error: "Gagal mengambil file dari TikTok." }, 502);

  const ext = q === "audio" ? "mp3" : "mp4";
  const name = ("rfht-" + (item.author?.uniqueId || "tiktok") + "-" + (item.id || Date.now()) + (q === "hd" ? "-hd" : "") + "." + ext)
    .replace(/[^\w.-]/g, "_");
  const headers = new Headers({
    "Content-Type": q === "audio" ? "audio/mpeg" : "video/mp4",
    "Content-Disposition": 'attachment; filename="' + name + '"',
    "Cache-Control": "no-store",
  });
  const len = media.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  return new Response(media.body, { headers });
}

// ---------- worker entry ----------

export default {
  async fetch(request, env) {
    if (env && env.SECRET) SECRET = env.SECRET;
    const u = new URL(request.url);
    try {
      if (u.pathname === "/api/find") {
        const out = await lookup((u.searchParams.get("url") || "").trim());
        return json(out.body, out.status);
      }
      if (u.pathname === "/api/info") return await handleInfo(u);
      if (u.pathname === "/api/debug") return await handleDebug(u);
      if (u.pathname === "/api/gate") return await handleGate(u);
      if (u.pathname === "/api/dl") return await handleDownload(u);
    } catch {
      return json({ error: "Terjadi kesalahan. Coba lagi." }, 500);
    }
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

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
  .ad { margin-top: 28px; text-align: center; overflow: hidden; }
  .ad:empty { display: none; }
  .ad:not(:empty)::before {
    content: "Iklan"; display: block; color: var(--muted); font-size: .78rem; margin-bottom: 6px;
  }
  button.ghost.big { padding: 14px 22px; font-size: 1rem; }
  .gate {
    position: fixed; inset: 0; z-index: 10; padding: 20px;
    background: rgba(10, 8, 25, .72); display: flex; align-items: center; justify-content: center;
  }
  .gate[hidden] { display: none; }
  .gate-box {
    background: var(--card); border: 1.5px solid var(--line); border-radius: 14px;
    padding: 22px; width: 100%; max-width: 420px;
  }
  .gate-box h2 { margin: 0 0 6px; font-size: 1.25rem; }
  .gate-box p { margin: 0; color: var(--muted); }
  .gate-box .actions { margin-top: 16px; }
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
  <p class="lede">Tempel link video TikTok, lalu cari link preset Alight Motion-nya atau unduh videonya.</p>

  <label for="url">Link video TikTok</label>
  <div class="row">
    <input id="url" type="url" inputmode="url" placeholder="https://www.tiktok.com/@creator/video/…" autocomplete="off">
    <button id="go" type="button">Cari preset</button>
    <button id="dl" type="button" class="ghost big">Unduh video</button>
  </div>

  <section id="out" aria-live="polite"></section>

  <div class="ad" id="ad-slot"><!-- TEMPEL KODE IKLAN DI SINI --></div>

  <div class="tips">
    <p>Tidak ketemu? Pencarian komentar hanya mencakup sekitar 150 komentar teratas, dan link yang ditulis di dalam video (overlay) tidak bisa dibaca. Coba cek langsung di aplikasinya.</p>
  </div>
</main>

<div class="gate" id="gate" hidden role="dialog" aria-modal="true" aria-labelledby="gate-title">
  <div class="gate-box">
    <h2 id="gate-title">Unduh kualitas HD</h2>
    <p>Tunggu sebentar. Iklan ini membantu RFHT tetap gratis.</p>
    <div class="ad" id="ad-gate"><!-- TEMPEL KODE IKLAN HD DI SINI --></div>
    <div class="actions">
      <button type="button" id="gate-go" disabled>Menyiapkan…</button>
      <button type="button" class="ghost" id="gate-cancel">Batal</button>
    </div>
  </div>
</div>

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

  const dlBtn = document.getElementById("dl");
  const gate = document.getElementById("gate");
  const gateGo = document.getElementById("gate-go");
  let gateTimer = null;

  function fmt(o) {
    return [o.label, o.codec, o.size ? (o.size / 1048576).toFixed(1) + " MB" : ""].filter(Boolean).join(" · ");
  }

  function dlLink(url, q, token) {
    return "/api/dl?url=" + encodeURIComponent(url) + "&q=" + q + (token ? "&t=" + encodeURIComponent(token) : "");
  }

  function closeGate() { clearInterval(gateTimer); gate.hidden = true; }

  async function openGate(url) {
    gate.hidden = false;
    gateGo.disabled = true;
    gateGo.textContent = "Menyiapkan…";
    clearInterval(gateTimer);
    try {
      const r = await fetch("/api/gate?url=" + encodeURIComponent(url));
      const d = await r.json();
      if (!r.ok) throw new Error("gate");
      let left = d.seconds;
      const tick = () => {
        if (left > 0) { gateGo.textContent = "Tunggu " + left + " detik"; left--; }
        else { clearInterval(gateTimer); gateGo.disabled = false; gateGo.textContent = "Unduh HD sekarang"; }
      };
      tick();
      gateTimer = setInterval(tick, 1000);
      gateGo.onclick = () => { location.href = dlLink(url, "hd", d.token); closeGate(); };
    } catch {
      gateGo.textContent = "Gagal. Tutup lalu coba lagi.";
    }
  }

  async function loadDownloads() {
    const value = input.value.trim();
    if (!value) { status("Tempel link TikTok dulu.", "err"); return; }
    dlBtn.disabled = true; dlBtn.textContent = "Memuat…";
    status("Membaca video…");
    try {
      const r = await fetch("/api/info?url=" + encodeURIComponent(value));
      const d = await r.json();
      if (!r.ok) { status(d.error || "Permintaan gagal.", "err"); return; }

      const box = document.createElement("div");
      box.className = "hit";
      const t = document.createElement("div");
      t.className = "url";
      t.textContent = d.author ? "@" + d.author : "Video TikTok";
      const m = document.createElement("div");
      m.className = "meta";
      m.textContent = (d.caption || "").slice(0, 140);
      const acts = document.createElement("div");
      acts.className = "actions";
      const add = (label, handler, ghost) => {
        const b = document.createElement("button");
        b.type = "button";
        if (ghost) b.className = "ghost";
        b.textContent = label;
        b.onclick = handler;
        acts.append(b);
      };
      if (d.std) add("Unduh MP4 Standar" + (fmt(d.std) ? " · " + fmt(d.std) : ""), () => { location.href = dlLink(value, "std"); });
      if (d.hd) add("Unduh MP4 HD" + (fmt(d.hd) ? " · " + fmt(d.hd) : ""), () => openGate(value));
      if (d.audio) add("Unduh MP3", () => { location.href = dlLink(value, "audio"); }, true);
      box.append(t, m, acts);
      if (d.hd && d.hd.codec === "H.265") {
        const n = document.createElement("div");
        n.className = "meta";
        n.textContent = "HD memakai codec H.265. Kalau tidak bisa diputar di HP lama, pakai VLC atau unduh versi Standar.";
        box.append(n);
      }
      out.replaceChildren(box);
    } catch {
      status("Server tidak bisa dihubungi. Sudah dijalankan?", "err");
    } finally {
      dlBtn.disabled = false; dlBtn.textContent = "Unduh video";
    }
  }

  dlBtn.addEventListener("click", loadDownloads);
  document.getElementById("gate-cancel").addEventListener("click", closeGate);
  gate.addEventListener("click", (e) => { if (e.target === gate) closeGate(); });

  btn.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
</script>
</body>
</html>`;
