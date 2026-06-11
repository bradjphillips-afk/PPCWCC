// score.mjs — fetches finished 2026 World Cup matches from API-FOOTBALL,
// applies The Sweep scoring (incl. yellow/red cards), writes data/standings.json.
// Cards are fetched ONCE per match and cached in data/cards.json to stay within
// the free tier's 100 requests/day. Runs in GitHub Actions. Node 18+ (global fetch).
//
// Requires env API_FOOTBALL_KEY (GitHub Actions secret).
// Reads draw.json (locked draw) and manual.json (awards / transfer window / adjustments).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) { console.error("Missing API_FOOTBALL_KEY env var"); process.exit(1); }
const API = "https://v3.football.api-sports.io";
const LEAGUE = 1, SEASON = 2026;
const MAX_EVENT_FETCHES = 25;   // safety cap on card lookups per run (catch-up days)

/* ---------- team tiers (for giant-killing) + name aliasing ---------- */
const TIER = {
  "Spain":1,"Argentina":1,"France":1,"England":1,"Brazil":1,"Portugal":1,"Netherlands":1,"Germany":1,"Belgium":1,"Croatia":1,"Morocco":1,"USA":1,
  "Uruguay":2,"Colombia":2,"Japan":2,"Mexico":2,"Switzerland":2,"Senegal":2,"Ecuador":2,"South Korea":2,"Norway":2,"Austria":2,"Canada":2,"Iran":2,"Australia":2,"Egypt":2,
  "Scotland":3,"Paraguay":3,"Côte d'Ivoire":3,"Sweden":3,"Türkiye":3,"Czechia":3,"Algeria":3,"Tunisia":3,"Panama":3,"Qatar":3,"Uzbekistan":3,"Saudi Arabia":3,
  "South Africa":4,"Bosnia & Herzegovina":4,"Iraq":4,"DR Congo":4,"Ghana":4,"Cape Verde":4,"Haiti":4,"Curaçao":4,"Jordan":4,"New Zealand":4,
};
const CANON = Object.keys(TIER);
const norm = s => (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
const ALIAS = {};
CANON.forEach(n => ALIAS[norm(n)] = n);
[["united states","USA"],["usa","USA"],["korea republic","South Korea"],["south korea","South Korea"],["korea south","South Korea"],
 ["turkey","Türkiye"],["turkiye","Türkiye"],["ivory coast","Côte d'Ivoire"],["cote d ivoire","Côte d'Ivoire"],
 ["czech republic","Czechia"],["cape verde islands","Cape Verde"],["cabo verde","Cape Verde"],
 ["bosnia and herzegovina","Bosnia & Herzegovina"],["bosnia herzegovina","Bosnia & Herzegovina"],
 ["dr congo","DR Congo"],["congo dr","DR Congo"],["democratic republic of congo","DR Congo"],
 ["new zealand","New Zealand"],["nz","New Zealand"]
].forEach(([a,c]) => ALIAS[norm(a)] = c);
const canon = name => ALIAS[norm(name)] || null;

/* ---------- scoring constants (identical to the Claude artifact) ---------- */
const ROUND_REACH = { r16:6, qf:12, sf:20, final:30 };
const FINISH_PTS  = { "1":12, "2":8, "3a":5, "3o":2, "4":0 };

async function api(path) {
  const res = await fetch(`${API}${path}`, { headers: { "x-apisports-key": KEY } });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) console.error("API errors:", JSON.stringify(json.errors));
  return json.response || [];
}

function mapRound(r) {
  r = (r||"").toLowerCase();
  if (r.includes("group")) return "group";
  if (r.includes("round of 32") || r.includes("1/16")) return "r32";
  if (r.includes("round of 16") || r.includes("1/8")) return "r16";
  if (r.includes("quarter")) return "qf";
  if (r.includes("semi")) return "sf";
  if (r.includes("3rd place") || r.includes("third place")) return "3p";
  if (r.includes("final")) return "final";
  return "group";
}

async function getFixtures() {
  const raw = await api(`/fixtures?league=${LEAGUE}&season=${SEASON}`);
  return raw.map(x => {
    const st = x.fixture.status.short;          // NS, FT, AET, PEN, ...
    const finished = ["FT","AET","PEN"].includes(st);
    const home = canon(x.teams.home.name), away = canon(x.teams.away.name);
    return {
      id: x.fixture.id,
      finished,
      date: (x.fixture.date||"").slice(0,10),
      round: mapRound(x.league.round),
      home, away,
      hs: x.goals.home, as: x.goals.away,
      homeWin: x.teams.home.winner === true,
      awayWin: x.teams.away.winner === true,
      pens: st === "PEN" ? (x.teams.home.winner ? home : away) : null,
    };
  });
}

/* ---------- cards: one fetch per finished match, then cached ---------- */
function countCards(events, home, away) {
  const c = { hy:0, hr:0, ay:0, ar:0 };
  for (const ev of (events||[])) {
    if ((ev.type||"").toLowerCase() !== "card") continue;
    const d = (ev.detail||"").toLowerCase();
    const isRed = d.includes("red");                          // "Red Card" or "Yellow-Red Card"
    const isYellow = d.includes("yellow") && !d.includes("yellow-red"); // plain "Yellow Card"
    const t = canon(ev.team?.name);
    const side = t === home ? "h" : (t === away ? "a" : null);
    if (!side) continue;
    if (isRed) c[side + "r"]++;
    else if (isYellow) c[side + "y"]++;
  }
  return c;
}

async function ensureCards(fixtures, cache) {
  let fetched = 0;
  for (const m of fixtures) {
    if (!m.finished || !m.home || !m.away) continue;
    if (cache[m.id]) continue;                 // already have its cards
    if (fetched >= MAX_EVENT_FETCHES) break;   // pick up the rest next run
    try {
      const ev = await api(`/fixtures/events?fixture=${m.id}&type=card`);
      cache[m.id] = countCards(ev, m.home, m.away);
      fetched++;
    } catch (e) { console.error(`events ${m.id} failed:`, e.message); }
  }
  if (fetched) console.log(`Fetched cards for ${fetched} new match(es).`);
  return cache;
}

async function getGroupFinish(advancedSet) {
  const out = {};
  try {
    const resp = await api(`/standings?league=${LEAGUE}&season=${SEASON}`);
    const groups = resp?.[0]?.league?.standings || [];
    groups.forEach(group => {
      const done = group.every(row => (row.all?.played||0) >= 3);
      if (!done) return;
      group.forEach(row => {
        const t = canon(row.team.name); if (!t) return;
        const pos = row.rank;
        if (pos === 1) out[t] = "1";
        else if (pos === 2) out[t] = "2";
        else if (pos === 3) out[t] = advancedSet.has(t) ? "3a" : "3o";
        else out[t] = "4";
      });
    });
  } catch (e) { console.error("standings failed:", e.message); }
  return out;
}

/* ---------- per-team scoring ---------- */
function teamPoints(fixtures, finishMap, awards) {
  const P = {};
  CANON.forEach(n => P[n] = { pts:0, log:[], groupWins:0, groupGames:0, rounds:new Set(), champ:false });

  fixtures.forEach(m => {
    [m.home, m.away].forEach(t => {
      if (t && P[t] && ["r16","qf","sf","final"].includes(m.round)) P[t].rounds.add(m.round);
    });
  });

  fixtures.filter(m => m.finished && m.home && m.away && m.hs!=null && m.as!=null).forEach(m => {
    const cd = m.cards || { hy:0, hr:0, ay:0, ar:0 };
    const sides = [
      [m.home, m.away, m.hs, m.as, m.homeWin, cd.hy, cd.hr],
      [m.away, m.home, m.as, m.hs, m.awayWin, cd.ay, cd.ar],
    ];
    sides.forEach(([me, opp, gf, ga, won, yel, red]) => {
      const e = P[me]; if (!e) return;
      if (won) e.pts += 10;
      else if (gf === ga && m.round === "group") e.pts += 4;
      e.pts += 2 * gf;
      if (ga === 0) e.pts += 3;
      if (yel) { e.pts -= yel; }
      if (red) { e.pts -= 4 * red; }
      if (won && m.pens === me) { e.pts += 4; e.log.push("+4 spot-kick steel"); }
      if (won && TIER[opp] === 1 && TIER[me] > 1) { e.pts += 8; e.log.push("+8 giant-killing"); }
      if (m.round === "group") { e.groupGames++; if (won) e.groupWins++; }
      if (m.round === "final" && won) e.champ = true;
    });
  });

  Object.entries(finishMap).forEach(([t, fin]) => {
    if (P[t] && fin in FINISH_PTS) { P[t].pts += FINISH_PTS[fin]; P[t].log.push(`group finish (${fin}): +${FINISH_PTS[fin]}`); }
  });

  CANON.forEach(t => {
    const e = P[t];
    e.rounds.forEach(r => { if (ROUND_REACH[r]) { e.pts += ROUND_REACH[r]; e.log.push(`reached ${r.toUpperCase()}: +${ROUND_REACH[r]}`); } });
    if (e.champ) { e.pts += 50; e.log.push("CHAMPIONS: +50"); }
    if (e.groupGames >= 3 && e.groupWins >= 3) { e.pts += 8; e.log.push("perfect group: +8"); }
  });

  [["boot",25,"Golden Boot"],["glove",20,"Golden Glove"],["ball",20,"Golden Ball"]].forEach(([k,v,lbl]) => {
    const c = canon((awards||{})[k] || ""); if (c && P[c]) { P[c].pts += v; P[c].log.push(`${lbl}: +${v}`); }
  });

  return P;
}

function playerTotals(draw, TP, manual) {
  const windows = manual.windows || {}, adjust = manual.adjust || {};
  return draw.players.map(p => {
    const w = windows[p.name] || {};
    let teams = [p.anchor, p.wildcard];
    if (w.lifeboatDrop && w.lifeboatAdopt && canon(w.lifeboatAdopt)) {
      teams = teams.filter(t => canon(t) !== canon(w.lifeboatDrop));
      teams.push(canon(w.lifeboatAdopt));
    }
    let pts = 0; const brk = [];
    teams.forEach(t => {
      const c = canon(t); const tp = c ? TP[c] : null; const v = tp ? tp.pts : 0;
      let vv = v;
      if (w.captain && canon(w.captain) === c) { vv = v * 2; brk.push(`${t} ×2 = ${vv}`); }
      else brk.push(`${t} = ${v}`);
      pts += vv;
    });
    if (w.lifeboatAdopt) { const c = canon(w.lifeboatAdopt); const tp = c ? TP[c] : null; if (tp && tp.rounds.has("sf")) { pts += 15; brk.push("phoenix +15"); } }
    const adj = Number(adjust[p.name] || 0); if (adj) { pts += adj; brk.push(`${adj>0?"+":""}${adj} adj`); }
    return { name: p.name, syndicate: p.syndicate, anchor: p.anchor, wildcard: p.wildcard, points: pts, breakdown: brk };
  }).sort((a,b) => b.points - a.points);
}

/* ---------- main ---------- */
(async function main() {
  const draw = JSON.parse(readFileSync("draw.json","utf8"));
  let manual = { awards:{}, windows:{}, adjust:{} };
  try { manual = Object.assign(manual, JSON.parse(readFileSync("manual.json","utf8"))); } catch {}
  let cardCache = {};
  try { cardCache = JSON.parse(readFileSync("data/cards.json","utf8")); } catch {}

  const fixtures = await getFixtures();

  // fetch + cache cards for newly finished matches, then attach
  await ensureCards(fixtures, cardCache);
  mkdirSync("data", { recursive: true });
  writeFileSync("data/cards.json", JSON.stringify(cardCache, null, 0));
  fixtures.forEach(m => { m.cards = cardCache[m.id] || { hy:0, hr:0, ay:0, ar:0 }; });

  const advancedSet = new Set();
  fixtures.forEach(m => { if (m.round !== "group" && m.round !== "3p") { [m.home,m.away].forEach(t => t && advancedSet.add(t)); } });
  const finishMap = await getGroupFinish(advancedSet);

  const TP = teamPoints(fixtures, finishMap, manual.awards);
  const players = playerTotals(draw, TP, manual);

  const agg = {};
  players.forEach(p => { (agg[p.syndicate] = agg[p.syndicate] || { sum:0, n:0 }); agg[p.syndicate].sum += p.points; agg[p.syndicate].n++; });
  const syndicates = Object.keys(agg).map(s => ({ name:s, avg: +(agg[s].sum/agg[s].n).toFixed(1), n: agg[s].n }))
                           .sort((a,b) => b.avg - a.avg);

  const finished = fixtures.filter(m => m.finished && m.home && m.away)
    .map(m => ({ date:m.date, home:m.home, away:m.away, hs:m.hs, as:m.as, round:m.round }))
    .sort((a,b) => a.date < b.date ? 1 : -1);

  const out = {
    gameName: draw.gameName || "The Sweep",
    lastChecked: new Date().toISOString(),
    players, syndicates, matches: finished, matchCount: finished.length,
  };
  writeFileSync("data/standings.json", JSON.stringify(out, null, 2));
  console.log(`Wrote standings: ${players.length} players, ${finished.length} matches scored.`);
})().catch(e => { console.error(e); process.exit(1); });
