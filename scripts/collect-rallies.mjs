// 演説予定の自動収集スクリプト（GitHub Actions から30分ごとに実行）
// 出典：①有志の街宣マップ（公式発表ベース）②各陣営の発表（note RSS）③data/manual.json（手動追加）
// 出力：data/rallies.json  ※Node.js 20 以上（fetch 内蔵）
import { readFile, writeFile } from "node:fs/promises";

const CAND = [
  ["asaka", /あさか|浅賀/], ["nakatani", /中谷/], ["harasawa", /原沢/], ["fukuyama", /福山/],
  ["fujikawa", /藤川/], ["yamanaka", /山中/], ["yamamoto", /山本/],
];
const candId = (name = "") => (CAND.find(([, re]) => re.test(name)) || [])[0];
const MAP_API = "https://yokohama-rally-map.base44.app/api/apps/6ac13d5d14fa7ebbeaeb58f0/entities/Campaign/v2/list?limit=1000";
const NOTE_FEEDS = [{ cand: "fujikawa", rss: "https://note.com/tsurumi_fujikawa/rss" }];
const UA = { "user-agent": "watashi-no-shichosen/1.0 (+https://github.com/)" };

const log = (...a) => console.log("[collect]", ...a);
const strip = (h) => h.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const hhmm = (s) => (s || "").replace(/^(\d):/, "0$1:");

async function fromMap() {
  const r = await fetch(MAP_API, { headers: UA });
  if (!r.ok) throw new Error("map " + r.status);
  const { items = [] } = await r.json();
  return items
    .filter((x) => !x.is_sample && x.status !== "cancelled" && candId(x.candidate_name))
    .map((x) => ({
      id: "m-" + x.id, c: candId(x.candidate_name), d: x.date, t: hhmm(x.start_time), e: hhmm(x.end_time) === hhmm(x.start_time) ? "" : hhmm(x.end_time),
      p: [x.location_name, x.notes && x.notes.length <= 16 && !/目撃|時間/.test(x.notes) ? `（${x.notes}）` : ""].join(""),
      w: x.ward || "", lat: x.lat ?? null, lng: x.lng ?? null, s: x.status === "recorded" ? "r" : "s", via: "map",
      n: /目撃/.test(x.notes || "") ? "目撃情報" : "",
    }));
}

async function fromNote({ cand, rss }, geo) {
  const xml = await (await fetch(rss, { headers: UA })).text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    title: (m[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "",
    link: (m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "",
  }));
  const out = [];
  for (const it of items.filter((i) => /スケジュール/.test(i.title))) {
    const dm = it.title.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!dm) continue;
    const d = `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}`;
    const key = it.link.split("/n/")[1];
    let body = "";
    try { const j = await (await fetch(`https://note.com/api/v3/notes/${key}`, { headers: UA })).json(); body = strip(j?.data?.body || ""); } catch {}
    if (!body) { try { body = strip(await (await fetch(it.link, { headers: UA })).text()); } catch { continue; } }
    for (const m of body.matchAll(/(\d{1,2}[:：]\d{2})\s*[〜~～\-－]\s*(\d{1,2}[:：]\d{2})?\s*[　 ]*([^\n]{2,40})/g)) {
      const p = m[3].replace(/^[\s　:：・\-]+/, "").trim();
      const g = geo(p);
      out.push({ id: `c-${cand}-${d}-${m[1].replace(/\D/g, "")}`, c: cand, d, t: hhmm(m[1].replace("：", ":")), e: hhmm((m[2] || "").replace("：", ":")), p, w: g.w, lat: g.lat, lng: g.lng, s: "s", via: "camp", src: it.link });
    }
  }
  return out;
}

const norm = (s) => (s || "").replace(/[（(].*?[)）]|\s|駅|口|東|西|南|北/g, "");
async function main() {
  const prev = JSON.parse(await readFile("data/rallies.json", "utf8").catch(() => '{"rows":[]}'));
  const manual = JSON.parse(await readFile("data/manual.json", "utf8").catch(() => '{"rows":[]}'));
  const sources = [];
  let rows = [];
  try { const m = await fromMap(); rows.push(...m); sources.push("有志の街宣マップ（公式発表ベース）"); log("map", m.length); }
  catch (e) { log("map: keep previous", e.message); rows.push(...prev.rows.filter((r) => r.via === "map")); sources.push("有志の街宣マップ（公式発表ベース）"); }
  // 駅名などから座標を引くための辞書（街宣マップの位置を流用）
  const geo = (p) => { const k = norm(p); const hit = rows.find((r) => r.lat && norm(r.p) && (k.includes(norm(r.p)) || norm(r.p).includes(k))); return hit ? { w: hit.w, lat: hit.lat, lng: hit.lng } : { w: "", lat: null, lng: null }; };
  for (const f of NOTE_FEEDS) {
    try { const n = await fromNote(f, geo); if (!n.length) throw new Error("0件"); rows.push(...n); log("note", f.cand, n.length); }
    catch (e) { log("note: keep previous", e.message); rows.push(...prev.rows.filter((r) => r.via === "camp" && r.c === f.cand)); }
  }
  rows.push(...prev.rows.filter((r) => r.via === "camp" && !NOTE_FEEDS.some((f) => f.cand === r.c)));
  sources.push("各陣営の発表");
  rows.push(...(manual.rows || []));
  // 重複排除（同じ候補・日・時刻・場所）。陣営発表を優先
  const rank = { camp: 0, news: 1, map: 2 };
  rows.sort((a, b) => (rank[a.via] ?? 3) - (rank[b.via] ?? 3));
  const seen = new Set(); const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  rows = rows.filter((r) => { const k = [r.c, r.d, r.t, norm(r.p).slice(0, 4)].join("|"); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((r) => (r.s === "s" && r.d < today ? { ...r, s: "r" } : r))
    .sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t));
  if (manual.rows?.length) sources.push("報道・手動追加");
  const same = JSON.stringify(prev.rows) === JSON.stringify(rows);
  const out = { updatedAt: same && prev.updatedAt ? prev.updatedAt : new Date().toISOString(), checkedAt: new Date().toISOString(), sources, rows };
  await writeFile("data/rallies.json", JSON.stringify(out, null, 1) + "\n");
  log(same ? "no change" : "updated", rows.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
