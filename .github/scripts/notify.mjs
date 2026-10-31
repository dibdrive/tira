// Sends push notifications for מ.כ. צעירי טירה via Firebase Cloud Messaging (HTTP v1).
// Modes:
//   node notify.mjs event     -> reads env PAYLOAD = JSON {cat, he:{title,body}, ar:{title,body}} (workflow_dispatch input)
//   node notify.mjs reminder  -> morning reminder if there is a game today (Asia/Jerusalem)
// Secret FIREBASE_SA = full JSON of a Firebase service-account key. DRY_RUN=1 prints instead of sending.
import crypto from "node:crypto";
import fs from "node:fs";

const PROJECT = "tira-kids";
// topics: <category>_<lang>, category = live | result | remind | ann
const topic = (cat, l) => `${cat}_${l}`;
const DRY = process.env.DRY_RUN === "1";

async function accessToken() {
  const sa = JSON.parse(process.env.FIREBASE_SA || "{}");
  if (!sa.client_email || !sa.private_key) throw new Error("FIREBASE_SA secret is missing or invalid");
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("token error: " + JSON.stringify(j));
  return j.access_token;
}

// custom sounds bundled in the app (v1.0.2+); older app versions fall back to the default channel/sound
const SND_CH = { goal_us: "tira_us", goal_them: "tira_them", whistle: "tira_whistle" };
async function send(msgs) {
  const clean = msgs.filter(m => m && m.title);
  if (!clean.length) { console.log("nothing to send"); return; }
  if (DRY) { for (const m of clean) console.log("[dry-run]", m.topic, "|", m.title, "|", m.body); return; }
  const tok = await accessToken();
  for (const m of clean) {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, {
      method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({ message: {
        topic: m.topic,
        notification: { title: m.title.slice(0, 120), body: (m.body || "").slice(0, 300) },
        android: { priority: "high", notification: { sound: m.snd || "default", channel_id: SND_CH[m.snd] || "tira" } },
        apns: { payload: { aps: { sound: m.snd ? m.snd + ".wav" : "default" } } },
      } }),
    });
    console.log(m.topic, r.status, (await r.text()).slice(0, 200));
    if (!r.ok) process.exitCode = 1;
  }
}

// ---------- event mode ----------
async function eventMode() {
  const p = JSON.parse(process.env.PAYLOAD || "{}");
  const cat = ["live", "result", "remind", "ann"].includes(p.cat) ? p.cat : "live";
  const snd = ["goal_us", "goal_them", "whistle"].includes(p.snd) ? p.snd : undefined;
  await send(["he", "ar"].map(l => p[l] && { topic: topic(cat, l), title: String(p[l].title || ""), body: String(p[l].body || ""), snd }));
}

// ---------- reminder mode ----------
function parseSite() {
  const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const fix = JSON.parse(html.slice(html.indexOf("const FIX = [") + 12, html.indexOf("].map(([r,d,o,h,tm,od])") + 1));
  const oppAr = JSON.parse(html.match(/const OPP_AR=(\{[^\n]*?\});/)[1]);
  const town = JSON.parse(html.match(/const TOWN=(\{[^\n]*?\});/)[1]);
  return { fix, oppAr, town };
}
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
  if (process.env.RESULTS_JSON) return JSON.parse(fs.readFileSync(process.env.RESULTS_JSON, "utf8")); // local testing
  const out = {}; let page = "";
  do {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/results?pageSize=300${page ? "&pageToken=" + page : ""}`);
    const j = await r.json();
    for (const d of j.documents || []) out[d.name.split("/").pop()] = fsVal({ mapValue: { fields: d.fields || {} } });
    page = j.nextPageToken || "";
  } while (page);
  return out;
}
const isoFromDmy = s => { const [d, m, y] = s.split("/"); return `20${y}-${m}-${d}`; };
async function reminderMode() {
  const today = process.env.TODAY || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date()); // YYYY-MM-DD
  const { fix, oppAr, town } = parseSite();
  const res = await loadResults();
  const games = [];
  for (const [r, d, o, h, tm] of fix) {
    const x = res["r" + r] || {};
    games.push({ comp: "league", r, o, home: typeof x.home === "boolean" ? x.home : !!h, date: x.date || isoFromDmy(d), time: x.time || tm || "", x });
  }
  for (const [k, x] of Object.entries(res)) if (x && x.comp === "cup" && x.date) games.push({ comp: "cup", o: x.opponent || "", home: !!x.home, date: x.date, time: x.time || "", stage: x.stage || "", x });
  const todays = games.filter(g => g.date === today && !(g.x.us != null && g.x.them != null));
  const msgs = [];
  // training reminder (only when there is no game today; cancelled trainings are skipped)
  const tr = res._train || {};
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  const DAY_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const DAY_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  const trs = todays.length ? [] : (tr.slots || []).filter(s => +s.d === dow && !(tr.cancel || {})[today + "_" + (s.time || "")])
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  for (const s of trs) {
    msgs.push({ topic: topic("remind", "he"), title: `🗓️ היום אימון${s.time ? " ב-" + s.time : ""}`,
      body: `צעירי טירה · יום ${DAY_HE[dow]}${s.place ? " · " + s.place : ""}\nנתראה במגרש! 💙` });
    msgs.push({ topic: topic("remind", "ar"), title: `🗓️ اليوم تدريب${s.time ? " الساعة " + s.time : ""}`,
      body: `شباب الطيرة · ${DAY_AR[dow]}${s.place ? " · " + s.place : ""}\nنلتقي في الملعب! 💙` });
  }
  if (!todays.length && !msgs.length) { console.log("no game or training today", today); return; }
  for (const g of todays) {
    const heWhere = g.x.venue || (g.home ? "אצטדיון טירה" : (town[g.o] || [])[0] || "");
    const arWhere = g.x.venue || (g.home ? "ملعب الطيرة" : (town[g.o] || [])[1] || "");
    const heComp = g.comp === "cup" ? `גביע ילדים ב׳${g.stage ? " · " + g.stage : ""}` : `ליגת ילדים ב׳ · מחזור ${g.r}`;
    const arComp = g.comp === "cup" ? "كأس الأولاد ب׳" : `دوري الأولاد ب׳ · المرحلة ${g.r}`;
    msgs.push({ topic: topic("remind", "he"), title: `⚽ היום משחק!${g.time ? " " + g.time : ""}`,
      body: `צעירי טירה מול ${g.o} · ${g.home ? "בית" : "חוץ"}${heWhere ? " · " + heWhere : ""}\n${heComp} · בהצלחה! 💙` });
    msgs.push({ topic: topic("remind", "ar"), title: `⚽ مباراة اليوم!${g.time ? " " + g.time : ""}`,
      body: `شباب الطيرة ضد ${oppAr[g.o] || g.o} · ${g.home ? "على أرضنا" : "خارج أرضنا"}${arWhere ? " · " + arWhere : ""}\n${arComp} · بالتوفيق! 💙` });
  }
  await send(msgs);
}

const mode = process.argv[2];
(mode === "reminder" ? reminderMode() : eventMode()).catch(e => { console.error(e); process.exit(1); });
