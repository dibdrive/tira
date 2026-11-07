// tira-push: Cloudflare Worker for מ.כ. צעירי טירה push notifications (backup copy of the deployed code)
// Dashboard: Workers & Pages > tira-push. URL: https://tira-push.dib-arkan.workers.dev/
// - POST /  (Authorization: Bearer <GitHub token of the admin "dibdrive">) body {cat, snd?, team?, he:{title,body}, ar:{title,body}} -> instant push
//   team: id from teams.js ("kc", "nc", ...); topics are "<team>_<cat>_<lang>", ילדים ב׳ (kb / no team) keeps "<cat>_<lang>"
// - Cron "0 4,5,8,9 * * *" (UTC): 07:00 Israel = "game today" reminder, 11:00 Israel = "training today" reminder (works in summer and winter time)
// - GET /?dry=game|training  -> shows what the reminder would send today (nothing is sent)
// Secret FIREBASE_SA = full JSON of a Firebase service-account key (Settings > Variables and Secrets).
const PROJECT = "tira-kids";
const ADMIN = "dibdrive";
const CATS = ["live", "result", "remind", "ann"];
const SNDS = ["goal_us", "goal_them", "whistle"];
const SND_CH = { goal_us: "tira_us", goal_them: "tira_them", whistle: "tira_whistle" };
// how long Google keeps a notification for a phone that is offline (or behind a VPN that blocks it)
const TTL = { live: 7200, result: 7200, ann: 86400, remind: 21600 };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const okTokens = new Map();
let fcmTok = null, fcmExp = 0;
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uStr = s => b64u(new TextEncoder().encode(s));
async function sha(s) { return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }

async function isAdmin(tok) {
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(tok)) return false;
  const h = await sha(tok), now = Date.now();
  if ((okTokens.get(h) || 0) > now) return true;
  const r = await fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + tok, "User-Agent": "tira-push", Accept: "application/vnd.github+json" } });
  if (!r.ok) return false;
  const u = await r.json();
  if (String(u.login || "").toLowerCase() !== ADMIN) return false;
  okTokens.set(h, now + 15 * 60 * 1000);
  return true;
}

async function accessToken(env) {
  if (fcmTok && fcmExp > Date.now() + 60000) return fcmTok;
  let sa; try { sa = JSON.parse(env.FIREBASE_SA || "{}"); } catch { throw new Error("FIREBASE_SA is not valid JSON (len " + String(env.FIREBASE_SA || "").length + ")"); }
  if (!sa.client_email || !sa.private_key) throw new Error("FIREBASE_SA secret is missing");
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  let der; try { der = Uint8Array.from(atob(pem), c => c.charCodeAt(0)); } catch { throw new Error("private_key is not valid base64"); }
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64uStr(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64uStr(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }) });
  const j = await r.json();
  if (!j.access_token) throw new Error("google token error: " + (j.error || "") + " " + (j.error_description || ""));
  fcmTok = j.access_token; fcmExp = Date.now() + (j.expires_in || 3600) * 1000;
  return fcmTok;
}

async function sendAll(env, msgs) {
  const at = await accessToken(env);
  return Promise.all(msgs.map(async m => {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, {
      method: "POST", headers: { Authorization: "Bearer " + at, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { topic: m.topic, data: { team: (/^([a-z][a-z0-9]{0,9})_(live|result|remind|ann)_/.exec(m.topic) || [])[1] || "kb" }, // team -> the app opens that team when the notification is tapped
        notification: { title: m.title, body: m.body },
        android: { priority: "high", ttl: (m.ttl || 86400) + "s", notification: { sound: m.snd || "default", channel_id: SND_CH[m.snd] || "tira" } },
        apns: { headers: { "apns-priority": "10", "apns-expiration": String(Math.floor(Date.now() / 1000) + (m.ttl || 86400)) }, payload: { aps: { sound: m.snd ? m.snd + ".wav" : "default" } } } } }) });
    if (!r.ok) console.error("fcm " + m.topic + " " + r.status + " " + (await r.text()).slice(0, 300));
    return { topic: m.topic, status: r.status };
  }));
}

// ---------- daily reminders ----------
function fsVal(v) {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return +v.integerValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = fsVal(x); return o; }
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fsVal);
  return undefined;
}
async function loadResults() {
  const out = {}; let page = "";
  do {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/results?pageSize=300${page ? "&pageToken=" + page : ""}`);
    const j = await r.json();
    for (const d of j.documents || []) out[d.name.split("/").pop()] = fsVal({ mapValue: { fields: d.fields || {} } });
    page = j.nextPageToken || "";
  } while (page);
  return out;
}
async function loadSite() {
  const raw = f => fetch("https://raw.githubusercontent.com/dibdrive/tira/main/" + f, { cf: { cacheTtl: 300 } }).then(r => r.text());
  const [html, tjs] = await Promise.all([raw("index.html"), raw("teams.js")]);
  const nf = html.includes("const FIX = (TD?TD.fix:["), a = nf ? html.indexOf("const FIX = (TD?TD.fix:[") + 23 : html.indexOf("const FIX = [") + 12;
  const teams = { kb: { he: "ילדים ב׳", ar: "الأولاد ب׳",
    fix: JSON.parse(html.slice(a, html.indexOf(nf ? "]).map(([r,d,o,h,tm,od])" : "].map(([r,d,o,h,tm,od])") + 1)),
    oppAr: JSON.parse(html.match(/const OPP_AR=(?:TD\?TD\.oppAr:)?(\{[^\n]*?\});/)[1]),
    town: JSON.parse(html.match(/const TOWN=(?:TD\?TD\.town:)?(\{[^\n]*?\});/)[1]) } };
  try { const T = JSON.parse(tjs.slice(tjs.indexOf("window.TEAMS=") + 13, tjs.lastIndexOf(";"))); for (const id in T) if (id !== "kb") teams[id] = T[id]; } catch (e) { console.error("teams.js: " + e.message); }
  return teams;
}
const isoFromDmy = s => { const [d, m, y] = s.split("/"); return `20${y}-${m}-${d}`; };
// seconds from now until hh:mm today in Israel (at least 30 min; 6 h when there is no time)
const ttlUntil = hhmm => { const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ""); if (!m) return 21600; const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value])); return Math.max(1800, ((+m[1]) * 60 + (+m[2]) - (+p.hour * 60 + +p.minute)) * 60); };
const ilNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour }; };

async function reminderMsgs(kind, today) {
  const [teams, all] = await Promise.all([loadSite(), loadResults()]);
  const msgs = [];
  for (const id in teams) {
    const pre = id === "kb" ? "" : id + "__", res = {};
    for (const k in all) { if (id === "kb" ? !k.includes("__") : k.startsWith(pre)) res[k.slice(pre.length)] = all[k]; }
    msgs.push(...teamReminder(kind, today, id, teams[id], res));
  }
  return msgs;
}
function teamReminder(kind, today, id, team, res) {
  const { fix, oppAr = {}, town = {} } = team, tp = (id === "kb" ? "" : id + "_") + "remind_", lbl = l => " · " + (team[l] || "");
  const S = team.s || { he: { leagueFull: "ליגת ילדים ב׳", cupFull: "גביע ילדים ב׳" }, ar: { leagueFull: "دوري الأولاد ب׳", cupFull: "كأس الأولاد ب׳" } };
  const games = [];
  for (const [r, d, o, h, tm] of fix) {
    const x = res["r" + r] || {};
    games.push({ comp: "league", r, o, home: typeof x.home === "boolean" ? x.home : !!h, date: x.date || isoFromDmy(d), time: x.time || tm || "", x });
  }
  for (const x of Object.values(res)) if (x && x.comp === "cup" && x.date) games.push({ comp: "cup", o: x.opponent || "", home: !!x.home, date: x.date, time: x.time || "", stage: x.stage || "", x });
  const todays = games.filter(g => g.date === today && !(g.x.us != null && g.x.them != null));
  const msgs = [];
  if (kind === "game") {
    for (const g of todays) {
      const heWhere = g.x.venue || (g.home ? "אצטדיון טירה" : (town[g.o] || [])[0] || "");
      const arWhere = g.x.venue || (g.home ? "ملعب الطيرة" : (town[g.o] || [])[1] || "");
      const heComp = g.comp === "cup" ? `${S.he.cupFull}${g.stage ? " · " + g.stage : ""}` : `${S.he.leagueFull} · מחזור ${g.r}`;
      const arComp = g.comp === "cup" ? S.ar.cupFull : `${S.ar.leagueFull} · المرحلة ${g.r}`;
      const ttl = ttlUntil(g.time);
      msgs.push({ topic: tp + "he", ttl, title: `⚽ היום משחק!${g.time ? " " + g.time : ""}${lbl("he")}`,
        body: `צעירי טירה מול ${g.o} · ${g.home ? "בית" : "חוץ"}${heWhere ? " · " + heWhere : ""}\n${heComp} · בהצלחה! 💙` });
      msgs.push({ topic: tp + "ar", ttl, title: `⚽ مباراة اليوم!${g.time ? " " + g.time : ""}${lbl("ar")}`,
        body: `شباب الطيرة ضد ${oppAr[g.o] || g.o} · ${g.home ? "على أرضنا" : "خارج أرضنا"}${arWhere ? " · " + arWhere : ""}\n${arComp} · بالتوفيق! 💙` });
    }
  } else if (kind === "training" && !todays.length) {
    const tr = res._train || {};
    const dow = new Date(today + "T12:00:00Z").getUTCDay();
    const DAY_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
    const DAY_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
    const trs = (tr.slots || []).filter(s => +s.d === dow && !(tr.cancel || {})[today + "_" + (s.time || "")]).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    for (const s of trs) {
      const ttl = ttlUntil(s.time);
      msgs.push({ topic: tp + "he", ttl, title: `🗓️ היום אימון${s.time ? " ב-" + s.time : ""}${lbl("he")}`, body: `צעירי טירה · יום ${DAY_HE[dow]}${s.place ? " · " + s.place : ""}\nנתראה במגרש! 💙` });
      msgs.push({ topic: tp + "ar", ttl, title: `🗓️ اليوم تدريب${s.time ? " الساعة " + s.time : ""}${lbl("ar")}`, body: `شباب الطيرة · ${DAY_AR[dow]}${s.place ? " · " + s.place : ""}\nنلتقي في الملعب! 💙` });
    }
  }
  return msgs;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET") {
      const dry = new URL(req.url).searchParams.get("dry");
      if (dry === "game" || dry === "training") { const n = ilNow(); return json({ dry, today: n.date, hour: n.hour, msgs: await reminderMsgs(dry, n.date) }); }
      return json({ ok: true, service: "tira-push" });
    }
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!(await isAdmin(tok))) return json({ error: "unauthorized" }, 401);
    let p; try { p = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const cat = CATS.includes(p.cat) ? p.cat : "live";
    const snd = SNDS.includes(p.snd) ? p.snd : undefined;
    const team = /^[a-z][a-z0-9]{0,9}$/.test(p.team || "") && p.team !== "kb" ? p.team + "_" : "";
    const msgs = ["he", "ar"].filter(l => p[l] && p[l].title).map(l => ({ topic: `${team}${cat}_${l}`, title: String(p[l].title).slice(0, 120), body: String(p[l].body || "").slice(0, 300), snd, ttl: TTL[cat] }));
    if (!msgs.length) return json({ error: "empty" }, 400);
    let out; try { out = await sendAll(env, msgs); } catch (e) { console.error("send failed: " + String(e.message || e)); return json({ error: String(e.message || e) }, 500); }
    const ok = out.every(o => o.status === 200);
    return json({ ok, out }, ok ? 200 : 502);
  },
  async scheduled(event, env, ctx) {
    const n = ilNow();
    const kind = n.hour === 7 ? "game" : n.hour === 11 ? "training" : null;
    if (!kind) return;
    const msgs = await reminderMsgs(kind, n.date);
    console.log("reminder", kind, n.date, msgs.length + " msgs");
    if (msgs.length) await sendAll(env, msgs);
  },
};
