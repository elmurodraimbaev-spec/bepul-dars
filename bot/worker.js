/**
 * Video darslik boti — Cloudflare Worker (Telegram webhook).
 *
 * Ishlash tartibi:
 *   /start  →  kanalga obunani tekshiradi
 *     obuna bo'lmagan  →  "Kanalga obuna bo'lish" + "✅ Obuna bo'ldim" tugmalari
 *     obuna bo'lgan    →  kanaldagi video darslik postini nusxalab yuboradi
 *
 * Cloudflare'dagi sozlamalar (Settings → Variables and Secrets):
 *   BOT_TOKEN       (Secret)  BotFather bergan token
 *   WEBHOOK_SECRET  (Secret)  ixtiyoriy uzun so'z — Telegram'dan kelgan so'rovni tekshirish uchun
 *   STATS_KEY       (Secret)  ixtiyoriy — /stats?key=... orqali hisobotni o'qish uchun
 * KV (ixtiyoriy, statistika uchun): Bindings → KV namespace, nomi  DB
 *
 * Bot kanalda ADMIN bo'lishi shart (aks holda obunani tekshira olmaydi).
 */

const CHANNEL    = "@raimbaev_elmurod";            // kanal
const CHANNEL_URL = "https://t.me/raimbaev_elmurod";
const VIDEO_POST = 1951;                           // video darslik posti raqami
const ADMIN_ID   = 669243496;                      // /stats buyrug'ini faqat shu odam ko'radi

const TXT = {
  gate:
    "👋 Assalomu alaykum!\n\n" +
    "🎬 <b>«Xususiy maktabga o'quvchi yig'ish»</b> bepul video darsligi " +
    "kanal obunachilari uchun.\n\n" +
    "1️⃣ Kanalga obuna bo'ling\n" +
    "2️⃣ «✅ Obuna bo'ldim» tugmasini bosing — video darhol keladi.",
  notYet: "Hali obuna bo'lmagansiz. Avval kanalga qo'shiling, keyin qayta bosing 🙂",
  before: "🎉 Rahmat! Mana video darslik 👇",
  after:
    "Darslik foydali bo'lsa, kanalda shunga o'xshash materiallar muntazam chiqadi — " +
    "kanalni o'chirib qo'ymang 🔔",
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Hisobot: GET /stats?key=STATS_KEY
    if (req.method === "GET" && url.pathname === "/stats") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY)
        return new Response("forbidden", { status: 403 });
      return Response.json(await stats(env));
    }
    if (req.method !== "POST") return new Response("ok");

    if (env.WEBHOOK_SECRET &&
        req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
      return new Response("forbidden", { status: 403 });

    let upd;
    try { upd = await req.json(); } catch { return new Response("ok"); }
    try { await handle(upd, env); } catch (e) { console.log("error", e && e.stack || e); }
    return new Response("ok");   // Telegram qayta yubormasligi uchun doim 200
  },
};

async function handle(upd, env) {
  // Tugma bosildi
  if (upd.callback_query) {
    const cq = upd.callback_query;
    const uid = cq.from.id;
    if (cq.data !== "check") return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    if (await isMember(env, uid)) {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "✅ Obuna tasdiqlandi" });
      await sendVideo(env, uid);
    } else {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: TXT.notYet, show_alert: true });
    }
    return;
  }

  const msg = upd.message;
  if (!msg || msg.chat.type !== "private") return;
  const uid = msg.from.id;
  const text = (msg.text || "").trim();

  if (text === "/stats" && uid === ADMIN_ID) {
    const s = await stats(env);
    return tg(env, "sendMessage", { chat_id: uid, parse_mode: "HTML", text: fmtStats(s) });
  }

  if (text.startsWith("/start")) {
    const src = (text.split(" ")[1] || "direct").slice(0, 40);
    await remember(env, uid, src);
  }

  if (await isMember(env, uid)) return sendVideo(env, uid);

  return tg(env, "sendMessage", {
    chat_id: uid, parse_mode: "HTML", text: TXT.gate,
    reply_markup: { inline_keyboard: [
      [{ text: "📢 Kanalga obuna bo'lish", url: CHANNEL_URL }],
      [{ text: "✅ Obuna bo'ldim", callback_data: "check" }],
    ] },
  });
}

async function isMember(env, uid) {
  const r = await tg(env, "getChatMember", { chat_id: CHANNEL, user_id: uid });
  if (!r.ok) { console.log("getChatMember failed", JSON.stringify(r)); return false; }
  const m = r.result;
  return ["creator", "administrator", "member"].includes(m.status) ||
         (m.status === "restricted" && m.is_member);
}

async function sendVideo(env, uid) {
  await tg(env, "sendMessage", { chat_id: uid, text: TXT.before });
  const r = await tg(env, "copyMessage", { chat_id: uid, from_chat_id: CHANNEL, message_id: VIDEO_POST });
  if (!r.ok) await tg(env, "sendMessage", { chat_id: uid, text: `${CHANNEL_URL}/${VIDEO_POST}` });
  await tg(env, "sendMessage", { chat_id: uid, text: TXT.after });
  await markGot(env, uid);
}

/* ---------- statistika (KV "DB" ulangan bo'lsa) ---------- */
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); // Toshkent sanasi

async function inc(env, key) {
  const v = parseInt(await env.DB.get(key) || "0", 10) + 1;
  await env.DB.put(key, String(v));
}

async function remember(env, uid, src) {
  if (!env.DB) return;
  if (await env.DB.get("u:" + uid)) return;               // faqat yangi odamlar
  await env.DB.put("u:" + uid, JSON.stringify({ src, d: today(), got: false }));
  await inc(env, "start:total"); await inc(env, "start:" + today());
  await inc(env, "src:" + src);
}

async function markGot(env, uid) {
  if (!env.DB) return;
  const raw = await env.DB.get("u:" + uid);
  const u = raw ? JSON.parse(raw) : { src: "unknown", d: today(), got: false };
  if (u.got) return;
  u.got = true;
  await env.DB.put("u:" + uid, JSON.stringify(u));
  await inc(env, "got:total"); await inc(env, "got:" + today());
}

async function stats(env) {
  if (!env.DB) return { error: "KV (DB) ulanmagan" };
  const g = async k => parseInt(await env.DB.get(k) || "0", 10);
  const d = today(), y = new Date(Date.now() + 5 * 3600e3 - 864e5).toISOString().slice(0, 10);
  const src = {};
  const list = await env.DB.list({ prefix: "src:" });
  for (const k of list.keys) src[k.name.slice(4)] = await g(k.name);
  return {
    date: d,
    start: { total: await g("start:total"), today: await g("start:" + d), yesterday: await g("start:" + y) },
    got_video: { total: await g("got:total"), today: await g("got:" + d), yesterday: await g("got:" + y) },
    sources: src,
  };
}

function fmtStats(s) {
  if (s.error) return s.error;
  const src = Object.entries(s.sources).map(([k, v]) => `  • ${k}: ${v}`).join("\n") || "  —";
  return `📊 <b>Bot statistikasi</b> (${s.date})\n` +
    `Start bosganlar: bugun ${s.start.today}, kecha ${s.start.yesterday}, jami ${s.start.total}\n` +
    `Obuna bo'lib video olganlar: bugun ${s.got_video.today}, kecha ${s.got_video.yesterday}, jami ${s.got_video.total}\n` +
    `Manbalar:\n${src}`;
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
