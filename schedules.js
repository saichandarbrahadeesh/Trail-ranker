#!/usr/bin/env node
/*
 * Bus & Boots Grenoble — build step 2 of 3: SCHEDULES
 * ---------------------------------------------------
 * Produces schedules.json: for each trailhead stop, every Saturday
 * outbound (Grenoble -> stop) and every return (stop -> Grenoble).
 *
 * This is the file that replaces the hand-typed "bus_refs" times.
 *
 * PROVENANCE — important:
 *   Each stop entry carries "source":
 *     "gtfs"   = extracted from the live open-data feed, self-refreshing.
 *     "manual" = NOT in any open feed (N62 Col de Porte, N93 Chamrousse —
 *                the M reso "Destinations Nature" reservation lines).
 *                These come from manual_schedules.json which YOU maintain
 *                from the official PDF fiches a few times a year.
 *   The app shows this so nobody mistakes a hand-typed time for a live one.
 *
 * RUN:  node schedules.js
 *       (expects reachable_stops.json from step 1 in the same folder;
 *        optionally manual_schedules.json for the non-GTFS lines)
 */
'use strict';
const fs = require('fs'), zlib = require('zlib'), https = require('https');

// ------------------------- CONFIG -------------------------
const FEED = 'https://data.mobilites-m.fr/api/gtfs/C38';
const LOCAL_ZIP = null;
const REACHABLE_FILE = 'reachable_stops.json';
const MANUAL_FILE = 'manual_schedules.json';   // optional, for N62/N93
const OUT_FILE = 'schedules.json';

// Origin = Grenoble only (see reachability.js bug note)
const ORIGIN_NAME_PATTERNS = [/^grenoble.*gare/i];

// Only keep stops at least this far out — filters the in-city stops that
// are on the route but are not trailheads (Durand Savoyat, Oxford, etc.)
const MIN_MINUTES_FROM_GRENOBLE = 20;

const EARLIEST_OUTBOUND = '06:00:00';  // ignore night services
const LATEST_RETURN     = '23:59:00';
// ----------------------------------------------------------

function readZipEntries(buf){
  let eocd=-1;
  for (let i=buf.length-22;i>=0 && i>buf.length-22-65536;i--){ if(buf.readUInt32LE(i)===0x06054b50){eocd=i;break;} }
  if(eocd<0) throw new Error('not a valid zip (download may have failed)');
  const count=buf.readUInt16LE(eocd+10); let ptr=buf.readUInt32LE(eocd+16);
  const out={};
  for(let e=0;e<count;e++){
    if(buf.readUInt32LE(ptr)!==0x02014b50) break;
    const method=buf.readUInt16LE(ptr+10), compSize=buf.readUInt32LE(ptr+20);
    const nameLen=buf.readUInt16LE(ptr+28), extraLen=buf.readUInt16LE(ptr+30), commLen=buf.readUInt16LE(ptr+32);
    const localOff=buf.readUInt32LE(ptr+42);
    const name=buf.toString('utf8',ptr+46,ptr+46+nameLen);
    const lhNameLen=buf.readUInt16LE(localOff+26), lhExtraLen=buf.readUInt16LE(localOff+28);
    const dataStart=localOff+30+lhNameLen+lhExtraLen;
    const comp=buf.slice(dataStart,dataStart+compSize);
    let content = method===0?comp: method===8?zlib.inflateRawSync(comp): null;
    if(content) out[name]=content.toString('utf8');
    ptr+=46+nameLen+extraLen+commLen;
  }
  return out;
}
function parseCSV(text){
  const rows=[]; let i=0,field='',row=[],inQ=false;
  while(i<text.length){ const c=text[i];
    if(inQ){ if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else inQ=false;} else field+=c; }
    else { if(c==='"')inQ=true; else if(c===','){row.push(field);field='';}
      else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';}
      else if(c==='\r'){} else field+=c; } i++; }
  if(field.length||row.length){row.push(field);rows.push(row);}
  const header=rows.shift().map(h=>h.trim());
  return rows.filter(r=>r.length>1).map(r=>{const o={};header.forEach((h,idx)=>o[h]=(r[idx]!==undefined?r[idx].trim():''));return o;});
}
function download(url){
  return new Promise((resolve,reject)=>{
    console.log('  fetching ' + url + ' ...');
    const req=https.get(url,{headers:{'User-Agent':'busboots-build/1.0'}},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location) return download(res.headers.location).then(resolve,reject);
      if(res.statusCode!==200) return reject(new Error('HTTP '+res.statusCode));
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve(Buffer.concat(chunks)));
    });
    req.on('error',reject);
    req.setTimeout(60000,()=>{req.destroy();reject(new Error('timeout'));});
  });
}
const toSec = h => { const p=h.split(':').map(Number); return p[0]*3600+p[1]*60+(p[2]||0); };
const fmt = sec => { const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60);
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'); };

(async function main(){
  console.log('\n=== Bus & Boots · schedules build ===\n');

  if (!fs.existsSync(REACHABLE_FILE)) {
    console.error('\n✗ ' + REACHABLE_FILE + ' not found. Run  node reachability.js  first.\n');
    process.exit(1);
  }
  const reach = JSON.parse(fs.readFileSync(REACHABLE_FILE,'utf8'));
  console.log('  reachable stops from step 1: ' + reach.count);

  let buf;
  if (LOCAL_ZIP) buf = fs.readFileSync(LOCAL_ZIP);
  else { try { buf = await download(FEED); } catch(e){
    console.error('\n✗ download failed: '+e.message+'\n  Set LOCAL_ZIP to a manually downloaded C38.zip and re-run.\n');
    process.exit(1); } }
  const gtfs = readZipEntries(buf);
  console.log('  feed ' + (buf.length/1024/1024).toFixed(1) + ' MB\n');

  // validity
  const calendar = parseCSV(gtfs['calendar.txt']);
  const ends = calendar.map(c=>c.end_date).filter(Boolean).sort();
  const starts = calendar.map(c=>c.start_date).filter(Boolean).sort();
  const validity = (starts[0]||'?') + ' -> ' + (ends[ends.length-1]||'?');
  const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
  console.log('  feed calendar span: ' + validity);
  if ((ends[ends.length-1]||'0') < today) console.log('  !! WARNING: feed appears STALE');
  else console.log('  ok: feed covers today (' + today + ')');

  const satServices = new Set(calendar.filter(c=>c.saturday==='1').map(c=>c.service_id));

  const stops = {};
  parseCSV(gtfs['stops.txt']).forEach(s => stops[s.stop_id] = {
    id:s.stop_id, name:s.stop_name, lat:+s.stop_lat, lng:+s.stop_lon });

  const originIds = new Set(Object.values(stops)
    .filter(s => ORIGIN_NAME_PATTERNS.some(re=>re.test(s.name))).map(s=>s.id));
  if (!originIds.size) { console.error('\n✗ no Grenoble origin stop found\n'); process.exit(1); }
  console.log('  origin stop ids: ' + Array.from(originIds).join(', ') + '\n');

  const routes = {}; parseCSV(gtfs['routes.txt']).forEach(r =>
    routes[r.route_id] = r.route_short_name || r.route_long_name || r.route_id);
  const tripMeta = {}; parseCSV(gtfs['trips.txt']).forEach(t =>
    tripMeta[t.trip_id] = { route:t.route_id, service:t.service_id });

  // group Saturday stop_times by trip
  const byTrip = {};
  parseCSV(gtfs['stop_times.txt']).forEach(st => {
    const m = tripMeta[st.trip_id]; if (!m || !satServices.has(m.service)) return;
    const dep = st.departure_time || st.arrival_time;
    const arr = st.arrival_time || st.departure_time;
    if (!dep && !arr) return;
    (byTrip[st.trip_id] ||= []).push({ stop:st.stop_id, seq:+st.stop_sequence,
      dep: dep?toSec(dep):null, arr: arr?toSec(arr):null });
  });
  Object.values(byTrip).forEach(a=>a.sort((x,y)=>x.seq-y.seq));
  console.log('  Saturday trips parsed: ' + Object.keys(byTrip).length);

  // Candidate trailhead stops: reachable AND far enough out to not be an in-city stop
  const candidates = reach.stops.filter(s => s.minutes >= MIN_MINUTES_FROM_GRENOBLE);
  console.log('  candidate trailhead stops (>= '+MIN_MINUTES_FROM_GRENOBLE+' min out): ' + candidates.length + '\n');

  const minOut = toSec(EARLIEST_OUTBOUND), maxRet = toSec(LATEST_RETURN);
  const result = {};

  // ---------------------------------------------------------------
  // BUG FIX (2026-09-xx): a physical stop is often TWO stop_ids — one
  // pole per direction of travel (confirmed at St-Nizier: id ...92749
  // had 15 outbound / 0 return, id ...79695 had 0 outbound / 17 return).
  // Requiring both directions on a single id silently dropped every
  // two-pole stop. We now GROUP BY STOP NAME and merge all ids that
  // share it, so the logical stop has both directions.
  // (Lans OT / Villard GR are single-pole and were unaffected — which is
  //  why they cross-checked fine while St-Nizier vanished.)
  // ---------------------------------------------------------------
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();

  // name -> every stop_id in the feed carrying that name
  const idsByName = {};
  Object.values(stops).forEach(s => { (idsByName[norm(s.name)] ||= []).push(s.id); });

  // group the reachable candidates by name, keeping the best (lowest) travel time
  const groups = {};
  for (const cand of candidates) {
    const nm = norm(cand.name || (stops[cand.stop_id] ? stops[cand.stop_id].name : cand.stop_id));
    if (!groups[nm]) groups[nm] = { name: cand.name, best: cand, ids: new Set() };
    if (cand.minutes < groups[nm].best.minutes) groups[nm].best = cand;
    groups[nm].ids.add(cand.stop_id);
    // pull in sibling ids with the same name even if reachability missed them
    (idsByName[nm] || []).forEach(id => groups[nm].ids.add(id));
  }
  console.log('  logical stops after name-grouping: ' + Object.keys(groups).length);

  // ---------------------------------------------------------------
  // ONE-CHANGE JOURNEYS (added after a real bug: Meaudre showed only one
  // Saturday bus, because only DIRECT buses were recorded. The normal way
  // there is T64/T65 to Lans, then change to CPL01. Reachability already
  // allows one change, so the timetable must too.)
  // ---------------------------------------------------------------
  const MIN_CHANGE = 5*60, MAX_CHANGE = 40*60, MAX_TRIP = 120*60;
  const fromOrigin = {}; // stop -> [{dep, arr, line}] direct from Grenoble (seconds)
  const toOrigin   = {}; // stop -> [{dep, arr, line}] direct to Grenoble (seconds)
  for (const [tripId, seq] of Object.entries(byTrip)) {
    const line = routes[tripMeta[tripId].route] || '?';
    const oIdx = seq.findIndex(x => originIds.has(x.stop));
    if (oIdx < 0) continue;
    for (let j = 0; j < seq.length; j++) {
      if (j === oIdx) continue;
      const st = seq[j].stop;
      if (j > oIdx && seq[oIdx].dep!=null && seq[j].arr!=null && seq[oIdx].dep >= minOut)
        (fromOrigin[st] ||= []).push({ dep: seq[oIdx].dep, arr: seq[j].arr, line });
      if (j < oIdx && seq[j].dep!=null && seq[oIdx].arr!=null)
        (toOrigin[st] ||= []).push({ dep: seq[j].dep, arr: seq[oIdx].arr, line });
    }
  }

  function transferLegs(idSet){
    const out = [], ret = [];
    for (const [tripId, seq] of Object.entries(byTrip)) {
      const line2 = routes[tripMeta[tripId].route] || '?';
      for (let i = 0; i < seq.length; i++) {
        for (let j = i + 1; j < seq.length; j++) {
          const a = seq[i], b = seq[j];
          // OUTBOUND: Grenoble -> hub (a.stop) by bus 1, then this trip hub -> target (b.stop)
          if (idSet.has(b.stop) && !idSet.has(a.stop) && !originIds.has(a.stop) &&
              a.dep != null && b.arr != null && fromOrigin[a.stop]) {
            for (const leg of fromOrigin[a.stop]) {
              const wait = a.dep - leg.arr;
              if (wait < MIN_CHANGE || wait > MAX_CHANGE) continue;
              if (b.arr - leg.dep > MAX_TRIP) continue;
              out.push({ dep: leg.dep, arr: b.arr, line: leg.line + '+' + line2 });
            }
          }
          // RETURN: this trip target (a.stop) -> hub (b.stop), then hub -> Grenoble by bus 2
          if (idSet.has(a.stop) && !idSet.has(b.stop) && !originIds.has(b.stop) &&
              a.dep != null && b.arr != null && toOrigin[b.stop]) {
            for (const leg of toOrigin[b.stop]) {
              const wait = leg.dep - b.arr;
              if (wait < MIN_CHANGE || wait > MAX_CHANGE) continue;
              if (leg.arr - a.dep > MAX_TRIP) continue;
              ret.push({ dep: a.dep, arr: leg.arr, line: line2 + '+' + leg.line });
            }
          }
        }
      }
    }
    return { out, ret };
  }

  for (const [nm, grp] of Object.entries(groups)) {
    const idSet = grp.ids;
    const outbound = [], returns = [];
    const lineNames = new Set();

    for (const [tripId, seq] of Object.entries(byTrip)) {
      const line = routes[tripMeta[tripId].route] || '?';
      const oIdx = seq.findIndex(x => originIds.has(x.stop));
      const sIdx = seq.findIndex(x => idSet.has(x.stop));
      if (sIdx < 0) continue;
      if (oIdx >= 0 && sIdx > oIdx && seq[oIdx].dep!=null && seq[sIdx].arr!=null && seq[oIdx].dep >= minOut) {
        outbound.push({ dep: fmt(seq[oIdx].dep), arr: fmt(seq[sIdx].arr), line });
        lineNames.add(line);
      }
      if (oIdx > sIdx && seq[sIdx].dep!=null && seq[sIdx].dep <= maxRet) {
        returns.push({ dep: fmt(seq[sIdx].dep), arr: seq[oIdx].arr!=null?fmt(seq[oIdx].arr):null, line });
        lineNames.add(line);
      }
    }
    // add one-change journeys (seconds -> HH:MM)
    const tl = transferLegs(idSet);
    tl.out.forEach(o => { outbound.push({ dep: fmt(o.dep), arr: fmt(o.arr), line: o.line }); lineNames.add(o.line.split('+').pop()); });
    tl.ret.forEach(r => { returns.push({ dep: fmt(r.dep), arr: fmt(r.arr), line: r.line }); lineNames.add(r.line.split('+')[0]); });

    if (!outbound.length || !returns.length) continue;

    const bestOut = new Map();
    outbound.forEach(o => { const k=o.dep; const p=bestOut.get(k);
      if (!p || toSec(o.arr) < toSec(p.arr)) bestOut.set(k, o); });
    // Several first buses often feed the SAME connection (08:10, 08:15, 08:20
    // all arriving 09:32). A hiker only needs the latest one, so per arrival
    // time keep the latest departure.
    const byArr = new Map();
    Array.from(bestOut.values()).forEach(o => { const p=byArr.get(o.arr);
      if (!p || toSec(o.dep) > toSec(p.dep)) byArr.set(o.arr, o); });
    const uniqOut = Array.from(byArr.values())
      .sort((a,b)=>toSec(a.dep)-toSec(b.dep));
    const bestRet = new Map();
    returns.forEach(r => { const k=r.dep; const p=bestRet.get(k);
      if (!p || (r.arr && p.arr && toSec(r.arr) < toSec(p.arr))) bestRet.set(k, r); });
    const uniqRet = Array.from(bestRet.values())
      .sort((a,b)=>toSec(a.dep)-toSec(b.dep));

    const best = grp.best;
    const key = best.stop_id;
    result[key] = {
      stop_id: key,
      merged_stop_ids: Array.from(idSet),
      stop: grp.name || (stops[key] ? stops[key].name : key),
      lines: Array.from(lineNames).filter(x=>x!=='?'),
      lat: stops[key]?stops[key].lat:best.lat,
      lng: stops[key]?stops[key].lng:best.lng,
      minutes_from_grenoble: best.minutes,
      connections: best.connections,
      source: 'gtfs',
      saturday: { outbound: uniqOut, returns: uniqRet }
    };
  }

  console.log('  stops with BOTH outbound and return service: ' + Object.keys(result).length);

  // ---- merge manually-maintained lines (N62 Col de Porte, N93 Chamrousse) ----
  let manualCount = 0;
  if (fs.existsSync(MANUAL_FILE)) {
    const manual = JSON.parse(fs.readFileSync(MANUAL_FILE,'utf8'));
    for (const [key, entry] of Object.entries(manual.stops||{})) {
      result[key] = Object.assign({}, entry, { source:'manual' });
      manualCount++;
    }
    console.log('  merged manual stops (not in open data): ' + manualCount);
  } else {
    console.log('  (no ' + MANUAL_FILE + ' found — N62/N93 not included.');
    console.log('   These lines are NOT in any open feed and must be maintained by hand.)');
  }

  const out = {
    generated: new Date().toISOString(),
    feed: FEED,
    feed_calendar_span: validity,
    params: { MIN_MINUTES_FROM_GRENOBLE, EARLIEST_OUTBOUND, LATEST_RETURN },
    counts: { gtfs: Object.keys(result).length - manualCount, manual: manualCount },
    stops: result
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out,null,2));
  console.log('\n✓ wrote ' + OUT_FILE + '\n');

  // ---- sanity print: the stops we already hand-verified in July ----
  console.log('--- CROSS-CHECK vs your hand-verified July data ---');
  const checks = [
    ['Lans-en-Vercors, Office de Tourisme', 'expect first out ~07:40->08:23, last return ~19:00'],
    ['Villard-de-Lans, Gare Routiere',      'expect first out ~07:40->08:40, last return ~18:45'],
    ['Saint-Nizier-du-Moucherotte, Le Village','expect first out ~07:25->08:04, last return ~18:23'],
    ['Saint-Pierre-de-Chartreuse, Plan de Ville','T40 - expect very limited Saturday returns']
  ];
  const normCheck = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  for (const [name, note] of checks) {
    const hit = Object.values(result).find(r => normCheck(r.stop) === normCheck(name));
    console.log('\n  ' + name);
    console.log('    ' + note);
    if (!hit) { console.log('    >> NOT FOUND in output'); continue; }
    const o = hit.saturday.outbound, r = hit.saturday.returns;
    console.log('    lines: ' + hit.lines.join(', ') + '  |  ' + hit.minutes_from_grenoble + ' min from Grenoble');
    console.log('    outbound (' + o.length + '): ' + o.slice(0,4).map(x=>x.dep+'->'+x.arr).join('  ') + (o.length>4?'  ...':''));
    console.log('    returns  (' + r.length + '): ' + r.slice(0,3).map(x=>x.dep).join('  ') +
                (r.length>3?('  ...  LAST: ' + r[r.length-1].dep):''));
  }
  console.log('\nCompare these against the July numbers. If they match, the pipeline is trustworthy.');
  console.log('(Times may legitimately differ — the September schedule change is real.)\n');
})().catch(e=>{ console.error('\n✗ '+e.message+'\n'); process.exit(1); });
