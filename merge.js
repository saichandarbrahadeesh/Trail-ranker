#!/usr/bin/env node
/*
 * Bus & Boots Grenoble — MERGE
 * -----------------------------
 * Combines:
 *   trails_vercors.json  (50 park-curated Vercors hikes)
 *   trails.json          (your hand-verified July trails: Chartreuse, Belledonne)
 *   schedules.json       (bus times per stop)
 * into ONE dataset the app reads.
 *
 * Three jobs:
 *   1. DEDUPE   — same hike from both sources kept once (hand-verified wins).
 *   2. APPROACH — measure the REAL walking distance from bus stop to trail
 *                 start using a pedestrian router, instead of guessing.
 *   3. UNIFY    — one schema, with provenance on every field that matters.
 *
 * WHY THE ROUTER MATTERS
 *   Until now approach_km was either hand-estimated (July trails) or
 *   straight-line "as the crow flies" (Vercors). Both understate a path that
 *   switchbacks up a cliff. This measures along real footpaths.
 *   Routing service: FOSSGIS public OSRM foot profile (OSM data, no API key).
 *   Be a good citizen: this runs a few times a year, ~70 requests, with pauses.
 *
 * RUN:
 *   node merge.js                 # full merge with routing
 *   node merge.js --no-routing    # skip routing, keep straight-line (fast)
 *   node merge.js --max-approach 1.5
 */
'use strict';
const fs = require('fs'), https = require('https');

// --------------------------- CONFIG ---------------------------
const VERCORS_FILE  = 'trails_vercors.json';
const HAND_FILE     = 'trails.json';         // your July hand-verified set
const SCHEDULES_FILE= 'schedules.json';
const OUT_FILE      = 'trails_merged.json';

// Public OSRM instance with a WALKING profile (OSM-based, no key required).
const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
const ROUTE_PAUSE_MS = 1000;      // be polite to a free community service
// A trail's true nearest stop on FOOT is often not the nearest in a straight line
// (a valley stop can be 2km away horizontally but 400m below a cliff). So we
// route to the N nearest candidate stops and keep the best walk.
const CANDIDATE_STOPS = 4;
const CANDIDATE_MAX_STRAIGHT_KM = 6;   // don't even consider stops beyond this
const WALK_KMH_FALLBACK = 4;      // only used if routing fails

const args = process.argv.slice(2);
const NO_ROUTING = args.includes('--no-routing');
const MAX_APPROACH_KM = args.includes('--max-approach')
  ? +args[args.indexOf('--max-approach')+1] : 2.5;
// --------------------------------------------------------------

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const deAcc = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
function get(url){
  return new Promise((resolve,reject)=>{
    const req = https.get(url,{headers:{'User-Agent':'busboots-build/1.0 (personal hiking planner)'}},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){
        let n; try{n=new URL(res.headers.location,url).toString();}catch(e){return reject(new Error('bad redirect'));}
        return get(n).then(resolve,reject);
      }
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ if(res.statusCode!==200) return reject(new Error('HTTP '+res.statusCode));
        try{resolve(JSON.parse(d));}catch(e){reject(new Error('not JSON'));} });
    });
    req.on('error',e=>reject(new Error(e.code||e.message)));
    req.setTimeout(25000,()=>{req.destroy();reject(new Error('timeout'));});
  });
}
const R=6371000;
function straightKm(aLat,aLng,bLat,bLng){
  const r=d=>d*Math.PI/180;
  const dLat=r(bLat-aLat), dLon=r(bLng-aLng);
  const s=Math.sin(dLat/2)**2+Math.cos(r(aLat))*Math.cos(r(bLat))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s))/1000;
}
/* Measure walking distance + time along real paths. Returns {km, minutes} or null. */
async function walkRoute(fromLat,fromLng,toLat,toLng){
  const url = ROUTER + fromLng + ',' + fromLat + ';' + toLng + ',' + toLat + '?overview=false';
  try {
    const j = await get(url);
    if (j.code !== 'Ok' || !j.routes || !j.routes.length) return null;
    const r = j.routes[0];
    return { km: +(r.distance/1000).toFixed(2), minutes: Math.round(r.duration/60) };
  } catch(e){ return null; }
}

/* Normalised key for duplicate detection: strip accents, articles, punctuation. */
function nameKey(name){
  return deAcc(name).toLowerCase()
    .replace(/rando\s*bus\s*:?/g,'')
    .replace(/\b(le|la|les|du|de|des|d|l|the|depuis|par|via|et|au|aux|en)\b/g,' ')
    .replace(/\([^)]*\)/g,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .trim().split(/\s+/).filter(w=>w.length>2).sort().join('-');
}
/* Two trails are the same hike if their name keys share most significant words
   AND they start from the same stop area. Deliberately conservative: a false
   merge loses a real trail, which is worse than showing two similar ones. */
function isDuplicate(a, b){
  const ka = nameKey(a.name).split('-').filter(Boolean);
  const kb = nameKey(b.name).split('-').filter(Boolean);
  if (!ka.length || !kb.length) return false;
  const shared = ka.filter(w => kb.includes(w)).length;
  const overlap = shared / Math.min(ka.length, kb.length);
  if (overlap < 0.6) return false;
  // must also start near each other (same trailhead), within 2 km
  if (a.lat!=null && b.lat!=null){
    if (straightKm(a.lat,a.lng,b.lat,b.lng) > 2) return false;
  }
  return true;
}

(async function main(){
  console.log('\n=== Bus & Boots · merge ===\n');

  // ---- load sources ----
  if (!fs.existsSync(VERCORS_FILE)){ console.error('! '+VERCORS_FILE+' missing. Run vercors.js first.\n'); process.exit(1); }
  const vercors = JSON.parse(fs.readFileSync(VERCORS_FILE,'utf8'));
  console.log('  Vercors (park data) : ' + vercors.trails.length);

  let hand = { trails: [], bus_refs: {} };
  if (fs.existsSync(HAND_FILE)){
    hand = JSON.parse(fs.readFileSync(HAND_FILE,'utf8'));
    console.log('  hand-verified       : ' + (hand.trails||[]).length);
  } else console.log('  hand-verified       : (trails.json not found — skipping)');

  let stops = {};
  if (fs.existsSync(SCHEDULES_FILE)){
    const s = JSON.parse(fs.readFileSync(SCHEDULES_FILE,'utf8'));
    stops = s.stops || {};
    console.log('  bus stops           : ' + Object.keys(stops).length);
  }

  // ---- normalise hand-verified trails into the unified shape ----
  const unified = [];
  for (const t of (hand.trails||[])){
    if (t.status === 'cut_v1') continue;   // already excluded from v1
    const ref = (hand.bus_refs||{})[t.bus_ref] || {};
    unified.push({
      id: t.id,
      name: t.name,
      massif: t.massif,
      distance_km: t.distance_km,
      d_plus_m: t.d_plus_m,
      duration_h: t.duration_h,
      difficulty: t.difficulty,
      stop: ref.stop || null,
      stop_id: t.bus_ref || null,
      // NOTE: these coords are the BUS STOP, not the trail start — the July
      // dataset never recorded a trail-start position. Routing between two bus
      // stops is meaningless, so these trails are excluded from routing and
      // keep their hand-estimated approach (honestly labelled).
      lat: ref.lat ?? null,
      lng: ref.lng ?? null,
      has_trailhead_coords: false,
      lines: ref.line ? [ref.line] : [],
      approach_km: t.approach_km,
      approach_source: 'hand_estimated',   // honest: these were never measured
      topo_url: t.topo_url || null,
      note: t.note || null,
      end_bus_ref: t.end_bus_ref || null,
      source: 'hand-verified (fiches horaires + Visorando)',
      verified: true
    });
  }

  // ---- add Vercors trails, skipping duplicates of hand-verified ones ----
  let dupes = 0;
  const dupeLog = [];
  for (const v of vercors.trails){
    const dup = unified.find(u => isDuplicate(u, v));
    if (dup){
      dupes++;
      dupeLog.push(v.name + '  ==  ' + dup.name + '  (kept hand-verified)');
      continue;
    }
    unified.push({
      id: v.id,
      name: v.name,
      massif: 'Vercors',
      distance_km: v.distance_km,
      d_plus_m: v.d_plus_m,
      d_plus_source: v.d_plus_source || 'park_data',
      duration_h: v.duration_h,
      difficulty: v.difficulty || null,
      stop: v.stop,
      stop_id: v.stop_id,
      lat: v.lat, lng: v.lng,
      has_trailhead_coords: true,
      lines: v.lines || [],
      approach_km: v.approach_km,
      approach_source: 'straight_line',
      rando_bus: !!v.rando_bus,
      geometry_parts: v.geometry_parts || 1,
      // v.topo_url is the API record (raw JSON) — useless to a hiker.
      // The park publishes a GPX track and a PDF topo per trek; use those.
      topo_url: null,
      gpx_url: v.gpx_url || null,
      pdf_url: v.pdf_url || null,
      geotrek_id: v.geotrek_id || null,
      source: 'Parc naturel régional du Vercors (Geotrek)',
      licence: 'Licence Ouverte 2.0',
      verified: false
    });
  }
  console.log('\n  duplicates removed  : ' + dupes);
  dupeLog.forEach(l => console.log('      ' + deAcc(l)));
  console.log('  unified trails      : ' + unified.length);

  // ---- measure the real walking approach ----
  if (!NO_ROUTING){
    console.log('\n  measuring walking approach (bus stop -> trail start)...');
    console.log('  router: ' + ROUTER);
    console.log('  testing up to ' + CANDIDATE_STOPS + ' nearby stops per trail, keeping the best walk\n');
    const stopList = Object.values(stops).filter(s => s.lat && s.lng);
    let done=0, ok=0, failed=0, switched=0, skippedNoCoords=0;
    for (const t of unified){
      done++;
      if (t.lat == null){ t.approach_source='unknown'; continue; }
      if (t.has_trailhead_coords === false){
        // Only the bus-stop position is known for this trail. Routing would
        // measure stop->stop and produce a bogus number (this wrongly dropped
        // Le Moucherotte at "4.86 km" on the previous run). Keep the July
        // estimate and say plainly that it is an estimate.
        t.approach_source = 'hand_estimated';
        t.approach_min = t.approach_km!=null ? Math.round(t.approach_km/WALK_KMH_FALLBACK*60) : null;
        skippedNoCoords++;
        continue;
      }
      process.stdout.write('    [' + done + '/' + unified.length + '] ' +
        deAcc(t.name).slice(0,32).padEnd(34));

      // candidate stops: nearest by straight line, as a shortlist only
      const cands = stopList
        .map(s => ({ s, straight: straightKm(t.lat, t.lng, s.lat, s.lng) }))
        .filter(c => c.straight <= CANDIDATE_MAX_STRAIGHT_KM)
        .sort((a,b)=>a.straight-b.straight)
        .slice(0, CANDIDATE_STOPS);

      if (!cands.length){ t.approach_source='unknown'; console.log('no stop within '+CANDIDATE_MAX_STRAIGHT_KM+'km'); continue; }

      let best = null;
      for (const c of cands){
        const r = await walkRoute(c.s.lat, c.s.lng, t.lat, t.lng);
        await sleep(ROUTE_PAUSE_MS);
        if (!r) continue;
        if (!best || r.km < best.km) best = { km:r.km, minutes:r.minutes, stop:c.s };
      }

      if (best){
        const prevStop = t.stop;
        const prevKm = t.approach_km;
        if (best.stop.stop_id !== t.stop_id) switched++;
        t.stop     = best.stop.stop;
        t.stop_id  = best.stop.stop_id;
        t.lines    = best.stop.lines || t.lines;
        t.approach_km  = best.km;
        t.approach_min = best.minutes;
        t.approach_source = 'routed_footpath';
        ok++;
        const note = (best.stop.stop !== prevStop)
          ? '  [switched stop: ' + deAcc(prevStop||'?').slice(0,22) + ' -> ' + deAcc(best.stop.stop).slice(0,22) + ']'
          : '';
        console.log(best.km + ' km / ' + best.minutes + ' min' +
          (prevKm!=null ? '  (straight-line said ' + prevKm + 'km)' : '') + note);
      } else {
        failed++;
        t.approach_min = t.approach_km!=null ? Math.round(t.approach_km/WALK_KMH_FALLBACK*60) : null;
        console.log('routing failed — keeping ' + (t.approach_km ?? '?') + ' km');
      }
    }
    console.log('\n  routed OK: ' + ok + '   failed: ' + failed +
      '   re-assigned to a closer stop: ' + switched);
    if (skippedNoCoords) console.log('  not routed (no trail-start coords, kept July estimate): ' + skippedNoCoords);
  } else {
    console.log('\n  --no-routing: keeping existing approach values');
    unified.forEach(t => { if (t.approach_min==null && t.approach_km!=null)
      t.approach_min = Math.round(t.approach_km/WALK_KMH_FALLBACK*60); });
  }

  // ---- apply the approach ceiling AFTER measuring (a routed 2.8km may now fail) ----
  // Apply the ceiling ONLY to measured approaches. A hand-estimated value is
  // not solid enough to delete a trail over.
  const overCeiling = t => t.approach_source === 'routed_footpath'
    && t.approach_km != null && t.approach_km > MAX_APPROACH_KM;
  const kept = unified.filter(t => !overCeiling(t));
  const cut  = unified.filter(overCeiling);
  if (cut.length){
    console.log('\n  dropped for approach > ' + MAX_APPROACH_KM + ' km: ' + cut.length);
    cut.forEach(t => console.log('      ' + String(t.approach_km).padStart(5) + 'km  ' + deAcc(t.name).slice(0,44)));
  }

  kept.sort((a,b)=>{
    const am = (stops[a.stop_id]?.minutes_from_grenoble) ?? 999;
    const bm = (stops[b.stop_id]?.minutes_from_grenoble) ?? 999;
    return am-bm;
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    meta: {
      generated: new Date().toISOString(),
      sources: [
        'Parc naturel régional du Vercors (Geotrek) — Licence Ouverte 2.0',
        'Hand-verified from official fiches horaires + Visorando',
        'Bus times: Cars Région Isère GTFS + manual M réso lines'
      ],
      attribution: '© Parc naturel régional du Vercors; © OpenStreetMap contributors (routing)',
      approach_note: 'approach_source tells you how the walk from the bus stop was obtained: ' +
        'routed_footpath = measured along real paths (reliable); straight_line = as the crow flies ' +
        '(optimistic); hand_estimated = guessed during the July build (least reliable).',
      max_approach_km: MAX_APPROACH_KM,
      counts: {
        total: kept.length,
        verified: kept.filter(t=>t.verified).length,
        park_data: kept.filter(t=>!t.verified).length,
        routed_approach: kept.filter(t=>t.approach_source==='routed_footpath').length,
        rando_bus: kept.filter(t=>t.rando_bus).length
      }
    },
    trails: kept
  }, null, 2));

  console.log('\n✓ wrote ' + OUT_FILE);
  console.log('  total trails          : ' + kept.length);
  console.log('  hand-verified         : ' + kept.filter(t=>t.verified).length);
  console.log('  park data (Vercors)   : ' + kept.filter(t=>!t.verified).length);
  console.log('  approach MEASURED     : ' + kept.filter(t=>t.approach_source==='routed_footpath').length);
  console.log('  approach still guessed: ' + kept.filter(t=>t.approach_source!=='routed_footpath').length);

  console.log('\n--- biggest approach corrections (straight-line was wrong) ---');
  kept.filter(t=>t.approach_source==='routed_footpath' && t.approach_min!=null)
      .sort((a,b)=>b.approach_km-a.approach_km).slice(0,10)
      .forEach(t => console.log('  ' + String(t.approach_km).padStart(5)+'km ' +
        String(t.approach_min).padStart(3)+'min  ' + deAcc(t.name).slice(0,40)));
  console.log('');
})().catch(e=>{ console.error('\n! '+e.message+'\n'); process.exit(1); });
