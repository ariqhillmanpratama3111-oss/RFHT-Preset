// Alight Motion Preset Finder
// Versi Cloudflare Workers: tempel seluruh isi file ini di editor Worker.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Alight Motion share links come in a few shapes.
const PRESET_RE =
  /https?:\/\/(?:www\.)?(?:alight\.link|alightcreative\.com\/am\/share|alightmotion\.com|alightmotion\.app\.link)[^\s"'<>\\)\]]*/gi;

// ---------- helpers ----------

// Link dari tombol Bagikan (vm.tiktok.com, /t/xxxx, atau yang buntutnya panjang penuh parameter)
// diubah jadi bentuk bersih: https://www.tiktok.com/@user/video/ID
async function resolveUrl(input) {
  let url = input;
  for (let i = 0; i < 4 && !/\/video\/\d+/.test(url); i++) {
    const r = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    const loc = r.headers.get("location");
    if (!loc || r.status < 300 || r.status > 399) break;
    const next = new URL(loc, url).toString();
    if (!isTikTokUrl(next)) return input;
    url = next;
  }
  const m = url.match(/^https?:\/\/(?:[\w-]+\.)?tiktok\.com\/(@[^\/?#]+)\/video\/(\d+)/i);
  return m ? "https://www.tiktok.com/" + m[1] + "/video/" + m[2] : url;
}


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
  if (!m) {
    const old = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (old) {
      try {
        const first = Object.values(JSON.parse(old[1]).ItemModule || {})[0];
        if (first) return first;
      } catch {
        /* ignore */
      }
    }
    return null;
  }
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
  let target = inputUrl;
  try {
    target = await resolveUrl(inputUrl);
  } catch {
    /* pakai link asli */
  }

  // 1) The video page itself: caption + creator bio live in embedded JSON.
  try {
    const page = await fetchText(target);
    finalUrl = page.finalUrl || target;
    const item = readRehydration(page.text);
    if (item) {
      meta = {
        author: item.author?.uniqueId || "",
        caption: item.desc || "",
        cover: item.video?.cover || "",
        plays: Number(item.stats?.playCount) || 0,
      };
      sources.push({ where: "caption", text: item.desc });
      sources.push({ where: "bio kreator", text: item.author?.signature });
    } else {
      // Cadangan kalau struktur data berubah. Sengaja tidak dipakai kalau data video terbaca,
      // karena halaman memuat caption video lain (rekomendasi) yang bisa salah terbaca.
      sources.push({ where: "page", text: page.text });
    }
  } catch {
    /* fall through to oEmbed */
  }

  // 2) oEmbed (hanya kalau caption belum terbaca dari halaman).
  if (!meta.caption) try {
    const { text } = await fetchText(
      "https://www.tiktok.com/oembed?url=" + encodeURIComponent(target)
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
  return { status: 200, body: { links, author: meta.author || null, caption: meta.caption || "", cover: meta.cover || "", plays: meta.plays || 0 } };
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
  let target = inputUrl;
  try {
    target = await resolveUrl(inputUrl);
  } catch {
    /* pakai link asli */
  }
  const res = await fetch(target, {
    redirect: "follow",
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(12000),
  });
  const html = await res.text();
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookies = raw.map((c) => c.split(";")[0]).join("; ");
  const item = readRehydration(html);
  const meta = {
    resolvedUrl: target.split("?")[0],
    httpStatus: res.status,
    htmlLength: html.length,
    hasVideoData: !!item,
    looksLikeBlockPage: /captcha|verify to continue|Access Denied/i.test(html.slice(0, 20000)),
  };
  return { item, cookies, meta };
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
  const { item, meta } = await getVideo(url);
  if (!item) return json({ error: "Data video tidak terbaca.", meta }, 502);
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

// Cari video TikTok untuk sebuah lagu lewat hasil pencarian Google (layanan serper.dev).
// Butuh secret SERPER_API_KEY di Cloudflare. Hasil disimpan sementara di memori supaya hemat kuota.
let SERPER_KEY = "";
const searchCache = new Map(); // q -> { at, videos }
const CACHE_MS = 6 * 3600 * 1000;

async function handleSearch(u) {
  const q = (u.searchParams.get("q") || "").trim().slice(0, 80);
  if (q.length < 2) return json({ error: "Tulis judul lagunya dulu." }, 400);
  if (!SERPER_KEY) {
    return json({ error: "Pencarian lagu belum diaktifkan oleh pemilik web (API key pencarian belum diisi)." }, 503);
  }

  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return json({ videos: hit.videos });

  // Akun gratis Serper menolak operator pencarian seperti "site:", jadi pakai kata biasa saja.
  // Hasil yang bukan video TikTok disaring di bawah. Kalau num ditolak, ulangi tanpa num.
  const query = q + " alight motion preset tiktok";
  let d = null;
  let status = 0;
  for (const extra of [{ num: 20 }, {}]) {
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, gl: "id", hl: "id", ...extra }),
        signal: AbortSignal.timeout(12000),
      });
      status = res.status;
      d = await res.json().catch(() => null);
    } catch {
      d = null;
    }
    if (d && Array.isArray(d.organic)) break;
    if (status !== 400) break; // hanya 400 yang layak diulang
  }
  if (!d || !Array.isArray(d.organic)) {
    return json({
      error: "Pencarian lagu sedang tidak bisa dipakai. Coba lagi nanti, atau cari lewat link video.",
      detail: [{ via: "Serper", http: status, msg: String((d && (d.message || d.error)) || "").slice(0, 80) }],
    }, 502);
  }

  const seen = new Set();
  const videos = [];
  for (const r of d.organic) {
    const m = String(r.link || "").match(/tiktok\.com\/@([^\/?#]+)\/video\/(\d+)/i);
    if (!m || seen.has(m[2])) continue;
    seen.add(m[2]);
    const caption = String(r.snippet || r.title || "");
    videos.push({
      id: m[2],
      author: m[1],
      caption: caption.slice(0, 160),
      cover: "",
      plays: 0,
      url: "https://www.tiktok.com/@" + m[1] + "/video/" + m[2],
      relevant: /alight|preset|\bam\b|alightmotion|\bxml\b/i.test(caption + " " + (r.title || "")),
    });
    if (videos.length >= 15) break;
  }
  videos.sort((x, y) => Number(y.relevant) - Number(x.relevant));

  if (searchCache.size > 100) searchCache.clear();
  searchCache.set(key, { at: Date.now(), videos });
  return json({ videos });
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

const findCache = new Map();

export default {
  async fetch(request, env) {
    if (env && env.SECRET) SECRET = env.SECRET;
    if (env && env.SERPER_API_KEY) SERPER_KEY = env.SERPER_API_KEY;
    const u = new URL(request.url);
    try {
      if (u.pathname === "/api/find") {
        const url = (u.searchParams.get("url") || "").trim();
        const hit = findCache.get(url);
        if (hit && Date.now() - hit.at < 1800000) return json(hit.body, hit.status);
        const out = await lookup(url);
        if (out.status === 200) {
          if (findCache.size > 300) findCache.clear();
          findCache.set(url, { at: Date.now(), body: out.body, status: out.status });
        }
        return json(out.body, out.status);
      }
      if (u.pathname === "/api/info") return await handleInfo(u);
      if (u.pathname === "/api/debug") return await handleDebug(u);
      if (u.pathname === "/api/search") return await handleSearch(u);
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
    --paper: #f3f1f8; --ink: #1c1736; --muted: #6b6585; --line: #d9d4e8;
    --key: #6a4cf5; --key-ink: #ffffff; --ok: #1c7a54; --err: #b3261e; --card: #ffffff;
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
    line-height: 1.5; min-height: 100vh; padding: 44px 16px 80px;
  }
  main { max-width: 1040px; margin: 0 auto; }
  .brand { font-weight: 800; font-size: 1.5rem; letter-spacing: .04em; margin: 0 0 14px; }
  .strip { display: flex; align-items: center; margin: 0 0 24px; height: 22px; }
  .strip i { flex: 1; height: 2px; background: var(--line); }
  .strip b { width: 12px; height: 12px; background: var(--key); transform: rotate(45deg); margin: 0 6px; border-radius: 2px; }
  .strip b:nth-child(4) { background: transparent; border: 2px solid var(--key); }
  h1 { font-size: clamp(1.9rem, 5.5vw, 2.8rem); line-height: 1.08; letter-spacing: -0.02em; margin: 0 0 10px; font-weight: 800; }
  .lede { color: var(--muted); margin: 0 0 28px; max-width: 56ch; }

  .panels { display: grid; gap: 16px; grid-template-columns: 1fr; margin-bottom: 16px; }
  @media (min-width: 820px) { .panels.two { grid-template-columns: 1fr 1fr; } }
  .panel { background: var(--card); border: 1.5px solid var(--line); border-radius: 16px; padding: 20px; min-width: 0; }
  .panel h2 { margin: 0 0 4px; font-size: 1.2rem; letter-spacing: -0.01em; }
  .sub { margin: 0 0 14px; color: var(--muted); font-size: .92rem; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  input {
    flex: 1 1 180px; min-width: 0; font: inherit; color: var(--ink);
    background: var(--paper); border: 1.5px solid var(--line); border-radius: 10px; padding: 13px 14px;
  }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid var(--key); outline-offset: 2px; }
  button {
    font: inherit; font-weight: 700; cursor: pointer; border: 0; border-radius: 10px;
    padding: 13px 20px; background: var(--key); color: var(--key-ink);
  }
  button:disabled { opacity: .6; cursor: wait; }
  button.ghost { background: transparent; color: var(--key); border: 1.5px solid var(--key); padding: 8px 14px; font-size: .9rem; }
  .out { margin-top: 16px; }
  .status { margin: 0 0 10px; color: var(--muted); }
  .status.err { color: var(--err); }
  .status.ok { color: var(--ok); }
  .hit { background: var(--paper); border: 1.5px solid var(--line); border-radius: 12px; padding: 14px 16px; margin: 0 0 10px; display: grid; gap: 10px; }
  .hit .url { word-break: break-all; font-weight: 600; }
  .meta { color: var(--muted); font-size: .88rem; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions a { text-decoration: none; display: inline-block; }

  .vgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }
  .vcard {
    font: inherit; font-weight: 400; text-align: left; padding: 0; cursor: pointer; overflow: hidden;
    background: var(--paper); color: var(--ink); border: 1.5px solid var(--line); border-radius: 12px;
    display: flex; flex-direction: column;
  }
  .vcard img, .vcard .ph { width: 100%; aspect-ratio: 3 / 4; object-fit: cover; display: block; background: var(--line); }
  .vt { padding: 8px 10px; font-size: .82rem; }
  .vt b { display: block; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cap { color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  .ad { margin-top: 24px; text-align: center; overflow: hidden; }
  .ad:empty { display: none; }
  .ad:not(:empty)::before { content: "Iklan"; display: block; color: var(--muted); font-size: .78rem; margin-bottom: 6px; }

  .modal { position: fixed; inset: 0; z-index: 10; padding: 16px; background: rgba(10, 8, 25, .72); display: flex; align-items: center; justify-content: center; }
  .modal[hidden] { display: none; }
  .modal-box { background: var(--card); border: 1.5px solid var(--line); border-radius: 14px; padding: 20px; width: 100%; max-width: 460px; max-height: 92vh; overflow-y: auto; }
  .modal-box h2 { margin: 0 0 6px; font-size: 1.2rem; }
  .modal-box p { margin: 0; color: var(--muted); }
  .modal-box .actions { margin-top: 14px; }
  .embed { width: 100%; max-width: 325px; height: 540px; border: 0; border-radius: 12px; display: block; margin: 12px auto; background: var(--line); }
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
  <h1>Cari preset Alight Motion dari TikTok</h1>
  <p class="lede">Cari lewat link video atau judul lagu. Unduh video TikTok ada di panel tersendiri.</p>

  <div class="panels two">
    <section class="panel" aria-labelledby="a-title">
      <h2 id="a-title">Cari preset dari link TikTok</h2>
      <p class="sub">Tempel link video. Kami cari link preset di caption, komentar, dan bio kreatornya.</p>
      <div class="row">
        <input id="a-url" type="url" inputmode="url" placeholder="https://www.tiktok.com/@kreator/video/…" autocomplete="off" aria-label="Link video TikTok">
        <button id="a-go" type="button">Cari preset</button>
      </div>
      <div class="out" id="a-out" aria-live="polite"></div>
    </section>

    <section class="panel" aria-labelledby="b-title">
      <h2 id="b-title">Cari preset dari lagu</h2>
      <p class="sub">Ketik judul lagu, pilih video contoh yang kamu suka, lalu ambil link presetnya.</p>
      <div class="row">
        <input id="b-q" type="text" placeholder="Contoh: judul lagu atau nama artis" autocomplete="off" aria-label="Judul lagu">
        <button id="b-go" type="button">Cari lagu</button>
      </div>
      <div class="out" id="b-out" aria-live="polite"></div>
    </section>
  </div>

  <div class="panels">
    <section class="panel" aria-labelledby="c-title">
      <h2 id="c-title">Unduh video TikTok</h2>
      <p class="sub">Tempel link video untuk mengunduh MP4 atau MP3.</p>
      <div class="row">
        <input id="c-url" type="url" inputmode="url" placeholder="https://www.tiktok.com/@kreator/video/…" autocomplete="off" aria-label="Link video TikTok untuk diunduh">
        <button id="c-go" type="button">Ambil video</button>
      </div>
      <div class="out" id="c-out" aria-live="polite"></div>
    </section>
  </div>

  <div class="ad" id="ad-slot"><!-- TEMPEL KODE IKLAN DI SINI --></div>
</main>

<div class="modal" id="vm" hidden role="dialog" aria-modal="true" aria-labelledby="vm-title">
  <div class="modal-box">
    <h2 id="vm-title">Video contoh</h2>
    <iframe class="embed" id="vm-embed" title="Video contoh preset" allow="encrypted-media; fullscreen" src="about:blank"></iframe>
    <div id="vm-links"></div>
    <div class="actions"><button type="button" class="ghost" id="vm-close">Tutup</button></div>
  </div>
</div>

<div class="modal" id="gate" hidden role="dialog" aria-modal="true" aria-labelledby="gate-title">
  <div class="modal-box">
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
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function say(box, msg, cls) { box.replaceChildren(el("p", "status " + (cls || ""), msg)); }
  async function api(path) {
    const r = await fetch(path);
    let d = {};
    try { d = await r.json(); } catch (e) { d = {}; }
    return { ok: r.ok, d: d };
  }
  function busy(btn, on, idle, doing) { btn.disabled = on; btn.textContent = on ? doing : idle; }
  function fmtNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + " jt";
    if (n >= 1000) return Math.round(n / 1000) + " rb";
    return String(n);
  }

  function linkCard(link) {
    const box = el("div", "hit");
    const actions = el("div", "actions");
    const copy = el("button", "ghost", "Salin link");
    copy.type = "button";
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(link.url); copy.textContent = "Tersalin"; }
      catch (e) { copy.textContent = "Tekan Ctrl+C pada link"; }
      setTimeout(() => (copy.textContent = "Salin link"), 1600);
    };
    const open = el("a");
    open.href = link.url; open.target = "_blank"; open.rel = "noopener noreferrer";
    const ob = el("button", "ghost", "Buka di Alight Motion");
    ob.type = "button";
    open.append(ob);
    actions.append(copy, open);
    box.append(el("div", "url", link.url), el("div", "meta", "Ditemukan di " + link.where), actions);
    return box;
  }

  // ---- Panel A: preset dari link TikTok ----
  async function findByLink() {
    const v = $("a-url").value.trim(), out = $("a-out");
    if (!v) { say(out, "Tempel link TikTok dulu.", "err"); return; }
    busy($("a-go"), true, "Cari preset", "Mencari…");
    say(out, "Mencari di video…");
    try {
      const r = await api("/api/find?url=" + encodeURIComponent(v));
      if (!r.ok) { say(out, r.d.error || "Permintaan gagal.", "err"); return; }
      if (!r.d.links.length) { say(out, "Link preset Alight Motion tidak ditemukan di caption, komentar, maupun bio kreator.", "err"); return; }
      const head = el("p", "status ok", r.d.links.length === 1 ? "Ditemukan 1 link preset" : "Ditemukan " + r.d.links.length + " link preset");
      out.replaceChildren(head, ...r.d.links.map(linkCard));
    } catch (e) {
      say(out, "Server tidak bisa dihubungi. Sudah dijalankan?", "err");
    } finally {
      busy($("a-go"), false, "Cari preset", "Mencari…");
    }
  }

  // ---- Panel B: preset dari lagu ----
  function videoCard(v) {
    const b = el("button", "vcard");
    b.type = "button";
    if (v.cover) {
      const img = el("img");
      img.src = v.cover; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
      img.onerror = () => img.replaceWith(el("div", "ph"));
      b.append(img);
    } else {
      b.append(el("div", "ph"));
    }
    const t = el("div", "vt");
    t.append(el("b", null, "@" + v.author), el("div", "cap", v.caption || ""));
    if (v.plays) t.append(el("div", "meta", fmtNum(v.plays) + " tayangan"));
    b.append(t);
    b.onclick = () => openVideo(v);
    return b;
  }

  function tiktokSearchLink(q) {
    const a = el("a");
    a.href = "https://www.tiktok.com/search/video?q=" + encodeURIComponent("alight motion preset " + q);
    a.target = "_blank"; a.rel = "noopener noreferrer";
    const b = el("button", "ghost", "Cari langsung di TikTok");
    b.type = "button";
    a.append(b);
    const wrap = el("div", "actions");
    wrap.style.marginTop = "12px";
    wrap.append(a);
    return wrap;
  }

  // Periksa tiap video satu per satu (3 sekaligus). Hanya yang link presetnya terbaca yang ditampilkan.
  async function verifyAll(cands, out, q) {
    const found = [];
    const head = el("p", "status", "");
    const grid = el("div", "vgrid");
    const foot = el("div");
    out.replaceChildren(head, grid, foot);
    let done = 0, next = 0;
    const update = () => {
      const fin = done >= cands.length;
      head.className = "status" + (fin && found.length ? " ok" : "");
      head.textContent = (fin ? "Selesai memeriksa " + cands.length + " video. " : "Memeriksa video " + done + "/" + cands.length + "… ") + found.length + " punya link preset.";
    };
    update();
    async function runner() {
      while (next < cands.length) {
        const v = cands[next++];
        try {
          const r = await api("/api/find?url=" + encodeURIComponent(v.url));
          if (r.ok && r.d.links && r.d.links.length) {
            v.links = r.d.links;
            v.cover = r.d.cover || v.cover;
            v.plays = r.d.plays || v.plays;
            found.push(v);
            grid.append(videoCard(v));
          }
        } catch (e) { /* lewati video ini */ }
        done++;
        update();
      }
    }
    await Promise.all([runner(), runner(), runner()]);
    if (!found.length) {
      head.className = "status err";
      head.textContent = "Dari " + cands.length + " video yang diperiksa, belum ada yang link preset-nya terbaca. Coba judul lagu atau nama artis yang lebih singkat.";
    }
    foot.append(el("p", "meta", "Hanya video yang link preset-nya terbaca di caption atau bio kreator yang ditampilkan."), tiktokSearchLink(q));
  }

  async function findBySong() {
    const q = $("b-q").value.trim(), out = $("b-out");
    if (q.length < 2) { say(out, "Tulis judul lagunya dulu.", "err"); return; }
    busy($("b-go"), true, "Cari lagu", "Mencari…");
    say(out, "Mencari video preset…");
    try {
      const r = await api("/api/search?q=" + encodeURIComponent(q));
      if (!r.ok) {
        say(out, r.d.error || "Pencarian gagal.", "err");
        if (r.d.detail && r.d.detail.length) {
          out.append(el("div", "meta", "Info teknis: " + r.d.detail.map((x) => x.via + " " + (x.http || "") + " " + (x.msg || x.error || "")).join(" | ")));
        }
        out.append(tiktokSearchLink(q));
        return;
      }
      if (!r.d.videos.length) { say(out, "Belum ada video preset untuk lagu itu. Coba judul atau nama artis yang lebih singkat.", "err"); out.append(tiktokSearchLink(q)); return; }
      await verifyAll(r.d.videos, out, q);
    } catch (e) {
      say(out, "Server tidak bisa dihubungi. Sudah dijalankan?", "err");
    } finally {
      busy($("b-go"), false, "Cari lagu", "Mencari…");
    }
  }

  async function openVideo(v) {
    $("vm-title").textContent = "@" + v.author;
    $("vm-embed").src = /^[0-9]+$/.test(v.id) ? "https://www.tiktok.com/embed/v2/" + v.id : "about:blank";
    const box = $("vm-links");
    $("vm").hidden = false;
    if (v.links && v.links.length) { box.replaceChildren(...v.links.map(linkCard)); return; }
    say(box, "Mencari link preset…");
    try {
      const r = await api("/api/find?url=" + encodeURIComponent(v.url));
      if (!r.ok) { say(box, r.d.error || "Gagal mencari link.", "err"); return; }
      if (!r.d.links.length) { say(box, "Link preset tidak ditemukan di caption, komentar, atau bio video ini. Coba video contoh lain.", "err"); return; }
      box.replaceChildren(...r.d.links.map(linkCard));
    } catch (e) {
      say(box, "Server tidak bisa dihubungi.", "err");
    }
  }
  function closeVideo() { $("vm").hidden = true; $("vm-embed").src = "about:blank"; }

  // ---- Panel C: unduh video ----
  const gate = $("gate"), gateGo = $("gate-go");
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
      const r = await api("/api/gate?url=" + encodeURIComponent(url));
      if (!r.ok) throw new Error("gate");
      let left = r.d.seconds;
      const tick = () => {
        if (left > 0) { gateGo.textContent = "Tunggu " + left + " detik"; left--; }
        else { clearInterval(gateTimer); gateGo.disabled = false; gateGo.textContent = "Unduh HD sekarang"; }
      };
      tick();
      gateTimer = setInterval(tick, 1000);
      gateGo.onclick = () => { location.href = dlLink(url, "hd", r.d.token); closeGate(); };
    } catch (e) {
      gateGo.textContent = "Gagal. Tutup lalu coba lagi.";
    }
  }

  async function loadDownloads() {
    const value = $("c-url").value.trim(), out = $("c-out");
    if (!value) { say(out, "Tempel link TikTok dulu.", "err"); return; }
    busy($("c-go"), true, "Ambil video", "Memuat…");
    say(out, "Membaca video…");
    try {
      const r = await api("/api/info?url=" + encodeURIComponent(value));
      if (!r.ok) { say(out, r.d.error || "Permintaan gagal.", "err"); return; }
      const d = r.d;
      const box = el("div", "hit");
      const acts = el("div", "actions");
      const add = (label, handler, ghost) => {
        const b = el("button", ghost ? "ghost" : "", label);
        b.type = "button";
        b.onclick = handler;
        acts.append(b);
      };
      if (d.std) add("Unduh MP4 Standar" + (fmt(d.std) ? " · " + fmt(d.std) : ""), () => { location.href = dlLink(value, "std"); });
      if (d.hd) add("Unduh MP4 HD" + (fmt(d.hd) ? " · " + fmt(d.hd) : ""), () => openGate(value));
      if (d.audio) add("Unduh MP3", () => { location.href = dlLink(value, "audio"); }, true);
      box.append(el("div", "url", d.author ? "@" + d.author : "Video TikTok"), el("div", "meta", (d.caption || "").slice(0, 140)), acts);
      if (d.hd && d.hd.codec === "H.265") {
        box.append(el("div", "meta", "HD memakai codec H.265. Kalau tidak bisa diputar di HP lama, pakai VLC atau unduh versi Standar."));
      }
      out.replaceChildren(box);
    } catch (e) {
      say(out, "Server tidak bisa dihubungi. Sudah dijalankan?", "err");
    } finally {
      busy($("c-go"), false, "Ambil video", "Memuat…");
    }
  }

  // ---- wiring ----
  $("a-go").addEventListener("click", findByLink);
  $("b-go").addEventListener("click", findBySong);
  $("c-go").addEventListener("click", loadDownloads);
  $("a-url").addEventListener("keydown", (e) => { if (e.key === "Enter") findByLink(); });
  $("b-q").addEventListener("keydown", (e) => { if (e.key === "Enter") findBySong(); });
  $("c-url").addEventListener("keydown", (e) => { if (e.key === "Enter") loadDownloads(); });
  $("vm-close").addEventListener("click", closeVideo);
  $("vm").addEventListener("click", (e) => { if (e.target === $("vm")) closeVideo(); });
  $("gate-cancel").addEventListener("click", closeGate);
  gate.addEventListener("click", (e) => { if (e.target === gate) closeGate(); });
</script>
</body>
</html>`;
