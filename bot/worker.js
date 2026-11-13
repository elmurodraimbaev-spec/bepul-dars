/**
 * Kanal voronkasi boti — Cloudflare Worker (Telegram webhook).
 *
 * Maqsad: @raimbaev_elmurod kanaliga obunachi olib kelish.
 * Har bir bepul material ("taklif") o'z havolasiga ega:
 *     https://t.me/<bot>?start=video            → video darslik
 *     https://t.me/<bot>?start=kitobcha         → kitobcha
 *     https://t.me/<bot>?start=video-landing    → video darslik, manba "landing"
 * Havola formati:  start=<taklif>[-<manba>]   (faqat harf, raqam, _ va -)
 *
 * Ishlash tartibi:
 *   /start  →  kanalga obunani tekshiradi
 *     obuna bo'lmagan  →  "Kanalga obuna bo'lish" + "✅ Obuna bo'ldim"
 *     obuna bo'lgan    →  taklifdagi kanal postini nusxalab yuboradi
 *
 * Admin buyruqlari (faqat ADMIN_ID):
 *   /stats                         — statistika
 *   /offers                        — takliflar ro'yxati va havolalari
 *   /setoffer nom post_raqami Sarlavha   — yangi taklif qo'shish/o'zgartirish
 *        masalan: /setoffer checklist 1960 «Qabul checklisti»
 *
 * Cloudflare sozlamalari:
 *   Secrets: BOT_TOKEN, WEBHOOK_SECRET, STATS_KEY
 *   KV binding: DB  (statistika va takliflar uchun)
 * Bot kanalda ADMIN bo'lishi shart.
 */

const CHANNEL     = "@raimbaev_elmurod";
const CHANNEL_URL = "https://t.me/raimbaev_elmurod";
const ADMIN_ID    = 669243496;
const DEFAULT_OFFER = "video";

// Koddagi takliflar (admin /setoffer bilan yangilarini qo'sha oladi)
const OFFERS = {
  video: {
    post: 1951,
    title: "«Xususiy maktabga o'quvchi yig'ish» bepul video darsligi",
    // text bo'lsa, kanal posti nusxalanmaydi — shu matn yuboriladi
    preview: "https://www.youtube.com/watch?v=RgosTPt90Mg",
    text:
      "🎬 <b>Xususiy maktabga o'quvchi yig'ish — bepul video darslik</b>\n\n" +
      "▶️ <a href=\"https://www.youtube.com/watch?v=RgosTPt90Mg\">Videoni ko'rish</a>\n\n" +
      "<b>Videoda nimalar bor:</b>\n" +
      "▫️ Bir yilda 1800 ta yangi o'quvchi qanday yig'ilgani — tizim boshidan oxirigacha\n" +
      "▫️ Raqobatchilarni tahlil qilish va ota-onalar bilan CustDev o'tkazish\n" +
      "▫️ Qabulni har kuni raqamlar bilan boshqarish: plan-fakt va sinflar bo'yicha kalendar\n" +
      "▫️ Qaysi kanallar o'quvchi olib keldi, qaysilari ishlamadi\n\n" +
      "🎁 Qo'shimcha: «Xususiy maktabga marketing strategiyasi tuzish» kitobchasi — " +
      "<a href=\"https://t.me/raimbaev_elmurod/1948\">shu yerda</a>.",
  },
  kitobcha: { post: 1948, title: "«Xususiy maktabga marketing strategiyasi tuzish» kitobchasi" },
};

const T = {
  gate: o =>
    "👋 Assalomu alaykum!\n\n" +
    "Bu bot orqali <b>xususiy maktab va o'quv markaz marketingiga oid</b> bepul materiallarni olasiz.\n\n" +
    `🎁 <b>${esc(o.title)}</b> — kanal obunachilari uchun.\n\n` +
    "1️⃣ Kanalga obuna bo'ling\n" +
    "2️⃣ «✅ Obuna bo'ldim» tugmasini bosing — material darhol keladi.",
  notYet: "Hali obuna bo'lmagansiz. Avval kanalga qo'shiling, keyin qayta bosing 🙂",
  before: "🎉 Rahmat! Mana 👇",
  after: "Kanalda xususiy maktab va o'quv markaz marketingiga oid shunday materiallar muntazam chiqadi — kanalni o'chirib qo'ymang 🔔",
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
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
    return new Response("ok");
  },
};

async function handle(upd, env) {
  if (upd.callback_query) {
    const cq = upd.callback_query, uid = cq.from.id;
    const m = /^c:([\w-]+)$/.exec(cq.data || "");
    if (!m) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    if (await isMember(env, uid)) {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "✅ Obuna tasdiqlandi" });
      await deliver(env, uid, m[1]);
    } else {
      await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: T.notYet, show_alert: true });
    }
    return;
  }

  const msg = upd.message;
  if (!msg || msg.chat.type !== "private") return;
  const uid = msg.from.id;
  const text = (msg.text || "").trim();

  if (uid === ADMIN_ID && text.startsWith("/")) {
    const done = await admin(env, uid, text);
    if (done) return;
  }

  let offerKey = null, src = "direct";
  if (text.startsWith("/start")) {
    const p = (text.split(/\s+/)[1] || "").slice(0, 60);
    const [o, ...rest] = p.split("-");
    offerKey = o || null;
    if (rest.length) src = rest.join("-");
  }
  const offers = await getOffers(env);
  if (!offerKey || !offers[offerKey]) offerKey = (await lastOffer(env, uid)) || DEFAULT_OFFER;

  const member = await isMember(env, uid);
  await remember(env, uid, offerKey, src, member);
  if (member) return deliver(env, uid, offerKey);

  return tg(env, "sendMessage", {
    chat_id: uid, parse_mode: "HTML", text: T.gate(offers[offerKey]),
    reply_markup: { inline_keyboard: [
      [{ text: "📢 Kanalga obuna bo'lish", url: CHANNEL_URL }],
      [{ text: "✅ Obuna bo'ldim", callback_data: "c:" + offerKey }],
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

async function deliver(env, uid, offerKey) {
  const offers = await getOffers(env);
  const o = offers[offerKey] || offers[DEFAULT_OFFER];
  await tg(env, "sendMessage", { chat_id: uid, text: T.before });
  let r;
  if (o.text) {
    r = await tg(env, "sendMessage", {
      chat_id: uid, parse_mode: "HTML", text: o.text,
      link_preview_options: o.preview ? { url: o.preview, prefer_large_media: true } : { is_disabled: true },
    });
  } else {
    r = await tg(env, "copyMessage", { chat_id: uid, from_chat_id: CHANNEL, message_id: o.post });
  }
  if (!r.ok) { console.log("deliver failed", JSON.stringify(r)); await tg(env, "sendMessage", { chat_id: uid, text: `${CHANNEL_URL}/${o.post}` }); }
  await tg(env, "sendMessage", { chat_id: uid, text: T.after });
  await markGot(env, uid, offerKey);
}

/* ---------- admin ---------- */
async function admin(env, uid, text) {
  const say = t => tg(env, "sendMessage", { chat_id: uid, parse_mode: "HTML", text: t, disable_web_page_preview: true });
  if (text === "/stats") { await say(fmtStats(await stats(env))); return true; }
  if (text === "/offers") {
    const me = await tg(env, "getMe", {});
    const bot = me.ok ? me.result.username : "<bot>";
    const offers = await getOffers(env);
    await say("🎁 <b>Takliflar</b>\n\n" + Object.entries(offers).map(([k, o]) =>
      `<b>${esc(k)}</b> → post ${o.post}\n${esc(o.title)}\nhttps://t.me/${bot}?start=${k}`).join("\n\n"));
    return true;
  }
  const m = /^\/setoffer\s+([A-Za-z0-9_]+)\s+(\d+)\s+(.+)$/s.exec(text);
  if (m) {
    if (!env.DB) { await say("KV (DB) ulanmagan."); return true; }
    const extra = JSON.parse(await env.DB.get("offers") || "{}");
    extra[m[1]] = { post: +m[2], title: m[3].trim() };
    await env.DB.put("offers", JSON.stringify(extra));
    await say(`✅ «${esc(m[1])}» saqlandi → post ${m[2]}`);
    return true;
  }
  if (text.startsWith("/setoffer")) { await say("Format: /setoffer nom post_raqami Sarlavha"); return true; }
  return false;
}

async function getOffers(env) {
  const extra = env.DB ? JSON.parse(await env.DB.get("offers") || "{}") : {};
  return { ...OFFERS, ...extra };
}

/* ---------- statistika ---------- */
const day = (off = 0) => new Date(Date.now() + 5 * 3600e3 - off * 864e5).toISOString().slice(0, 10); // Toshkent

async function inc(env, key) {
  await env.DB.put(key, String(parseInt(await env.DB.get(key) || "0", 10) + 1));
}

async function lastOffer(env, uid) {
  if (!env.DB) return null;
  const raw = await env.DB.get("u:" + uid);
  return raw ? JSON.parse(raw).last : null;
}

// Har bir odam faqat bir marta sanaladi. wasMember — botga kelganda allaqachon obunachi bo'lganmi.
async function remember(env, uid, offer, src, member) {
  if (!env.DB) return;
  const raw = await env.DB.get("u:" + uid);
  if (raw) {
    const u = JSON.parse(raw); u.last = offer;
    await env.DB.put("u:" + uid, JSON.stringify(u));
    return;
  }
  await env.DB.put("u:" + uid, JSON.stringify({ d: day(), offer, src, last: offer, wasMember: member, got: false }));
  await inc(env, "start:" + day());
  await inc(env, "start:total");
  await inc(env, "offer:" + offer + ":start");
  await inc(env, "src:" + offer + "-" + src);
}

async function markGot(env, uid, offer) {
  if (!env.DB) return;
  const raw = await env.DB.get("u:" + uid);
  const u = raw ? JSON.parse(raw) : { d: day(), offer, src: "unknown", wasMember: true, got: false };
  if (u.got) return;
  u.got = true;
  await env.DB.put("u:" + uid, JSON.stringify(u));
  await inc(env, "got:total"); await inc(env, "got:" + day());
  await inc(env, "offer:" + u.offer + ":got");
  if (!u.wasMember) {                                   // bot orqali kanalga YANGI obuna bo'lgan
    await inc(env, "newsub:total"); await inc(env, "newsub:" + day());
    await inc(env, "offer:" + u.offer + ":newsub");
  }
}

async function stats(env) {
  if (!env.DB) return { error: "KV (DB) ulanmagan" };
  const g = async k => parseInt(await env.DB.get(k) || "0", 10);
  const d = day(), y = day(1);
  const offers = {};
  for (const k of (await env.DB.list({ prefix: "offer:" })).keys) {
    const [, name, kind] = k.name.split(":");
    (offers[name] ||= {})[kind] = await g(k.name);
  }
  const sources = {};
  for (const k of (await env.DB.list({ prefix: "src:" })).keys) sources[k.name.slice(4)] = await g(k.name);
  const trio = async p => ({ today: await g(p + ":" + d), yesterday: await g(p + ":" + y), total: await g(p + ":total") });
  return { date: d, start: await trio("start"), got: await trio("got"), new_subscribers: await trio("newsub"), offers, sources };
}

function fmtStats(s) {
  if (s.error) return s.error;
  const line = t => `bugun ${t.today}, kecha ${t.yesterday}, jami ${t.total}`;
  const off = Object.entries(s.offers).map(([k, v]) =>
    `  • ${esc(k)}: start ${v.start || 0}, oldi ${v.got || 0}, yangi obunachi ${v.newsub || 0}`).join("\n") || "  —";
  const src = Object.entries(s.sources).map(([k, v]) => `  • ${esc(k)}: ${v}`).join("\n") || "  —";
  return `📊 <b>Bot statistikasi</b> (${s.date})\n` +
    `👥 <b>Bot orqali yangi obunachi:</b> ${line(s.new_subscribers)}\n` +
    `▶️ Start bosgan (yangi odam): ${line(s.start)}\n` +
    `🎁 Material olgan: ${line(s.got)}\n\n` +
    `<b>Takliflar:</b>\n${off}\n\n<b>Manbalar:</b>\n${src}`;
}

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
