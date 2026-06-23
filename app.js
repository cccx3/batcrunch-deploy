const DATA_URL = 'data/data.json';
const DATA_2025_URL = 'data/data_2025.json';
const ROLLING_URL = 'data/rolling.json';
let DATA = [];
let ROLLING = {};
let ROLLING_ROWS = null;
let QUALPA = 502;

function platoonTier(p, shL, shR) {
  if (p.switch) return '\u2014';
  const tot = (p.pa_L || 0) + (p.pa_R || 0);
  if (!tot) return null;
  const tough = p.hand === 'R' ? (p.pa_R || 0) : (p.pa_L || 0);
  const base  = p.hand === 'R' ? shR : shL;
  if (!base) return null;
  const ratio = (tough / tot) / base;
  return ratio >= 0.85 ? 'Everyday' : ratio >= 0.60 ? 'Sheltered' : 'Strict';
}

function transform(id, p, prevWoba, shL, shR) {
  const frac = v => v == null ? null : +(v / 100).toFixed(4);
  const bbk = (p.bb == null || p.k == null) ? null : +((p.bb - p.k) / 100).toFixed(4);
  const wd  = (prevWoba == null || p.woba == null) ? null : +(p.woba - prevWoba).toFixed(3);
  const nm = p.name || '';
  return {
    id: +id, raw_name: nm, side: p.hand,
    bat_speed: p.bat_speed, swing_length: p.swing_length, attack_angle: p.attack_angle, attack_direction: p.attack_direction,
    tilt: p.tilt, iaa: p.iaa, whiff: p.whiff, pa: p.pa,
    barrel_pct: p.barrel, sweet_pct: p.sweet,
    platoon_tier: platoonTier(p, shL, shR), pa_L: p.pa_L, pa_R: p.pa_R,
    woba: p.woba, xwoba: p.xwoba, woba_diff: wd, bb_minus_k: bbk,
    k_pct: frac(p.k), bb_pct: frac(p.bb),
    position: p.position, team: p.team, ev90: p.ev90, sprint: p.sprint,
    woba_recent: null, pa_recent: null, heat: null,
    z_swing: frac(p.z_swing), o_swing: frac(p.o_swing),
    z_contact: frac(p.z_contact), o_contact: frac(p.o_contact),
    woba_L: p.woba_L, xwoba_L: null, woba_R: p.woba_R, xwoba_R: null,
    ev50: null, disc_score: null, int_batter: null, sq_up: null,
    last: nm.split(',')[0].trim(),
    first: (nm.split(',')[1] || '').trim()
  };
}

/* ================= GRADES ================= */
const GRADES = [
  ['A+', 95, 'var(--g-aplus)'], ['A', 85, 'var(--g-a)'], ['A-', 75, 'var(--g-aminus)'],
  ['B+', 65, 'var(--g-bplus)'], ['B', 55, 'var(--g-b)'], ['B-', 45, 'var(--g-bminus)'],
  ['C+', 35, 'var(--g-cplus)'], ['C', 25, 'var(--g-c)'], ['C-', 15, 'var(--g-cminus)'],
  ['D', 5, 'var(--g-d)'], ['F', 0, 'var(--g-f)']
];
function gradeFromPct(p) {
  for (const [g, t, c] of GRADES) if (p >= t) return { letter: g, color: c, pct: p };
  return { letter: 'F', color: 'var(--g-f)', pct: p };
}
function percentile(sortedAsc, v) {
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) { const m = (lo+hi) >> 1; if (sortedAsc[m] <= v) lo = m+1; else hi = m; }
  return Math.round((lo / sortedAsc.length) * 100);
}

/* Timing: proximity to the 29" hard-contact optimum on intercept vs batter.
   Per MLB.com, league avg intercept ~30" and 82% of HRs are 25–45" out front,
   peaking 36–38". But "optimum for Contact Quality" is tighter — the FanGraphs
   analysis puts the sweet band around 26–32" (the middle third). We anchor at 29",
   score falls off 100 -> 0 over 12 inches. */
const TIMING_OPTIMUM = 29;
function timingScore(int_batter) {
  return Math.max(0, 100 - (Math.abs(int_batter - TIMING_OPTIMUM) / 12) * 100);
}

/* Contact grade: combine whiff and squared-up into one percentile.
   Equal weight on (1) contact rate (100 - whiff) and (2) squared-up per swing.
   We convert each to percentile first, then average. */

/* Pre-sort everything for percentile lookups */
let S, ranked;
function recompute() {
  const POOL = DATA.filter(d => d.pa >= QUALPA);
  const src = POOL.length ? POOL : DATA;
  S = {
  ev50: [...src].map(d=>d.ev50).sort((a,b)=>a-b),
  bat_speed: [...src].map(d=>d.bat_speed).sort((a,b)=>a-b),
  iaa: [...src].map(d=>d.iaa).sort((a,b)=>a-b),
  timing: [...src].map(d=>timingScore(d.int_batter)).sort((a,b)=>a-b),
  disc_score: [...src].map(d=>d.disc_score).sort((a,b)=>a-b),
  bb_minus_k: [...src].map(d=>d.bb_minus_k).filter(x=>x!=null).sort((a,b)=>a-b),
  whiff_inv: [...src].map(d=>-d.whiff).sort((a,b)=>a-b),
  sq_up: [...src].map(d=>d.sq_up).sort((a,b)=>a-b),
  barrel_pct: [...src].map(d=>d.barrel_pct).filter(x=>x!=null).sort((a,b)=>a-b),
  sweet_pct: [...src].map(d=>d.sweet_pct).filter(x=>x!=null).sort((a,b)=>a-b),
  woba: [...src].map(d=>d.woba).filter(x=>x!=null).sort((a,b)=>a-b),
  luck_diff: [...src].map(d=>(d.xwoba!=null && d.woba!=null) ? (d.xwoba-d.woba) : null).filter(x=>x!=null).sort((a,b)=>a-b),
  ev90: [...src].map(d=>d.ev90).filter(x=>x!=null).sort((a,b)=>a-b),
  bat_speed_s: [...src].map(d=>d.bat_speed).filter(x=>x!=null).sort((a,b)=>a-b),
  sprint: [...src].map(d=>d.sprint).filter(x=>x!=null).sort((a,b)=>a-b),
  z_swing: [...src].map(d=>d.z_swing).filter(x=>x!=null).sort((a,b)=>a-b),
  z_contact_s: [...src].map(d=>d.z_contact).filter(x=>x!=null).sort((a,b)=>a-b),
  o_swing: [...src].map(d=>d.o_swing).filter(x=>x!=null).sort((a,b)=>a-b),
  o_contact: [...src].map(d=>d.o_contact).filter(x=>x!=null).sort((a,b)=>a-b),
  bb_pct: [...src].map(d=>d.bb_pct).filter(x=>x!=null).sort((a,b)=>a-b),
  k_pct: [...src].map(d=>d.k_pct).filter(x=>x!=null).sort((a,b)=>a-b),
  attack_angle: [...src].map(d=>d.attack_angle).filter(x=>x!=null).sort((a,b)=>a-b),
  tilt: [...src].map(d=>d.tilt).filter(x=>x!=null).sort((a,b)=>a-b),
  int_batter: [...src].map(d=>d.int_batter).filter(x=>x!=null).sort((a,b)=>a-b),
  attack_direction: [...src].map(d=>d.attack_direction).filter(x=>x!=null).sort((a,b)=>a-b),
  whiff_s: [...src].map(d=>d.whiff).filter(x=>x!=null).sort((a,b)=>a-b),
  swing_decision_combo: [...src].map(d => {
    if (d.z_swing == null || d.z_contact == null) return null;
    return d.z_swing * d.z_contact * 100;
  }).filter(x=>x!=null).sort((a,b)=>a-b),
};

DATA.forEach(d => {
  // Power: barrel% (game power, r²~0.33 with wOBA)
  d.power_pct = d.barrel_pct != null ? percentile(S.barrel_pct, d.barrel_pct) : percentile(S.ev50, d.ev50);
  // Contact: Z-Contact% percentile (purest contact-skill stat, best single predictor)
  d.contact_pct = d.z_contact != null ? percentile(S.z_contact_s, d.z_contact) : 50;
  // Discipline: BB% - K%
  d.disc_pct = d.bb_minus_k != null ? percentile(S.bb_minus_k, d.bb_minus_k) : percentile(S.disc_score, d.disc_score);

  d.power = gradeFromPct(d.power_pct);
  d.contact = gradeFromPct(d.contact_pct);
  d.discipline = gradeFromPct(d.disc_pct);
  d.luck_pct = (d.xwoba != null && d.woba != null) ? percentile(S.luck_diff, d.xwoba - d.woba) : 50;

  // Overall: wOBA percentile (production-anchored; component grades explain HOW)
  d.overall_pct = d.woba != null ? percentile(S.woba, d.woba) : 50;
  d.overall = gradeFromPct(d.overall_pct);
});

ranked = [...POOL].sort((a,b) => b.overall_pct - a.overall_pct);
ranked.forEach((d,i) => d._rank = i + 1);
DATA.forEach(d => { if (d.pa < QUALPA) d._rank = null; });
}

/* ================= STATE ================= */
let state = { query: '', side: 'all', position: 'all', min: 502, sortKey: 'overall', sortDir: 'desc', selectedId: null, expandedId: 592450 };

function filtered() {
  const q = state.query.toLowerCase();
  return DATA.filter(d =>
    (state.side === 'all' || d.side === state.side) &&
    (state.position === 'all' || d.position === state.position || (state.position === 'INF' && ['1B','2B','3B','SS','INF'].includes(d.position))) &&
    (d.pa >= state.min) &&
    (!q || d.raw_name.toLowerCase().includes(q))
  );
}
function sorted(arr) {
  const k = state.sortKey, dir = state.sortDir === 'asc' ? 1 : -1;
  return [...arr].sort((a,b) => {
    if (k === 'overall') return dir * (a.overall_pct - b.overall_pct);
    if (k === 'power') return dir * (a.power_pct - b.power_pct);
    if (k === 'contact') return dir * (a.contact_pct - b.contact_pct);
    if (k === 'discipline') return dir * (a.disc_pct - b.disc_pct);
    if (k === 'rank') return dir * ((a._rank ?? Infinity) - (b._rank ?? Infinity));
    if (k === 'luck') return dir * (((a.xwoba||0)-(a.woba||0)) - ((b.xwoba||0)-(b.woba||0)));
    if (k === 'heat') return dir * ((a.heat||0) - (b.heat||0));
    if (k === 'platoon') {
      const order = {'Strict': 3, 'Sheltered': 2, 'Everyday': 1, '—': 0};
      return dir * ((order[a.platoon_tier]||0) - (order[b.platoon_tier]||0));
    }
    const av = a[k], bv = b[k];
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
}

function gradeBadge(g, size='') {
  return `<span class="grade ${size}" style="background:${g.color}">${g.letter}</span>`;
}






function swingTiltLabel(v) {
  if (v == null) return '—';
  if (v < 27) return 'Flat';
  if (v < 30) return 'Level';
  if (v < 35) return 'Standard';
  if (v < 38) return 'Uppercut';
  return 'Steep Uppercut';
}

function attackDirLabel(v) {
  if (v == null) return '—';
  if (v < -7) return 'Heavy Pull';
  if (v < -3) return 'Pull';
  if (v < 1)  return 'Neutral';
  if (v < 5)  return 'Oppo';
  return 'Heavy Oppo';
}

function heatCell(d) {
  if (d.heat == null) return '<span class="dim">—</span>';
  const h = d.heat;
  let label, cls;
  if (h > 0.080) { label = 'Hot'; cls = 'heat-hot'; }
  else if (h > 0.030) { label = 'Warm'; cls = 'heat-warm'; }
  else if (h < -0.080) { label = 'Cold'; cls = 'heat-cold'; }
  else if (h < -0.030) { label = 'Cool'; cls = 'heat-cool'; }
  else { label = 'Steady'; cls = 'heat-steady'; }
  const sign = h >= 0 ? '+' : '';
  return `<span class="luck-pill ${cls}" title="L14: ${d.pa_recent || 0} PA, ${(d.woba_recent || 0).toFixed(3)} wOBA (${sign}${h.toFixed(3)} vs season)">${label}</span>`;
}

function luckCell(d) {
  if (d.woba == null || d.xwoba == null) return '<span class="dim">—</span>';
  const diff = d.xwoba - d.woba;
  // Tiers based on conventional thresholds
  // diff > +0.020 = very unlucky
  // diff +0.010 to +0.020 = unlucky
  // diff -0.010 to +0.010 = neutral
  // diff -0.020 to -0.010 = lucky
  // diff < -0.020 = very lucky
  let label, cls;
  if (diff > 0.020) { label = 'Cold'; cls = 'luck-vunlucky'; }
  else if (diff > 0.010) { label = 'Cool'; cls = 'luck-unlucky'; }
  else if (diff < -0.020) { label = 'Hot'; cls = 'luck-vlucky'; }
  else if (diff < -0.010) { label = 'Warm'; cls = 'luck-lucky'; }
  else { label = 'Even'; cls = 'luck-neutral'; }
  const sign = diff >= 0 ? '+' : '';
  return `<span class="luck-pill ${cls}" title="xwOBA − wOBA = ${sign}${diff.toFixed(3)}">${label}</span>`;
}

function wobaCell(d) {
  if (d.woba == null || d.xwoba == null) return '<span class="dim">—</span>';
  const LG = 0.320; // 2025 league avg wOBA
  const wCls = d.woba >= LG ? 'woba-pos' : 'woba-neg';
  const xCls = d.xwoba >= LG ? 'woba-pos' : 'woba-neg';
  const diff = d.xwoba - d.woba;
  let diffCls = 'diff-neu';
  if (diff > 0.015) diffCls = 'diff-pos';
  else if (diff < -0.015) diffCls = 'diff-neg';
  const sign = diff >= 0 ? '+' : '';
  return `<span class="woba-stack">
    <span class="woba-v ${wCls}">${d.woba.toFixed(3).replace(/^0/,'')}</span>
    <span class="woba-x ${xCls}">${d.xwoba.toFixed(3).replace(/^0/,'')}</span>
    <span class="woba-d ${diffCls}">${sign}${diff.toFixed(3).replace(/^(-?)0/,'$1')}</span>
  </span>`;
}



function rankOf(pct, total) {
  const v = Math.max(1, Math.min(total, Math.round(1 + (100 - pct) * (total - 1) / 100)));
  const s = ['th','st','nd','rd'], m = v % 100;
  return v + (s[(m-20)%10] || s[m] || s[0]);
}


function expandedPanel(d) {
  const L = 'v2'; // Tiles (locked)
  const dash = '\u2014', deg = '\u00b0';
  const bbk = d.bb_minus_k != null ? (d.bb_minus_k*100).toFixed(1)+'%' : (d.bb!=null&&d.k!=null ? ((d.bb-d.k)*100).toFixed(1)+'%' : dash);
  const woba = d.woba!=null ? d.woba.toFixed(3).replace(/^0\./,'.') : dash;
  const xwoba = d.xwoba!=null ? d.xwoba.toFixed(3).replace(/^0\./,'.') : dash;
  const aa = d.attack_angle!=null ? d.attack_angle.toFixed(1)+deg : dash;
  const bat = d.bat_speed!=null ? d.bat_speed.toFixed(1) : dash;
  const la = d.launch_angle!=null ? d.launch_angle.toFixed(1)+deg : '16.2'+deg; // FAKE until build.py emits launch_angle

  if (L === 'v2') return `
    <div class="mc-expand"><div class="bx2">
      <div class="bx2-row">
        <div class="bx2-tile val"><div class="l">BB\u2212K</div><div class="v" style="color:var(--ink)">${bbk}</div></div>
        <div class="bx2-tile val"><div class="l">wOBA</div><div class="v">${woba}</div></div>
        <div class="bx2-tile val"><div class="l">xwOBA</div><div class="v">${xwoba}</div></div>
      </div>
      <div class="bx2-row">
        <div class="bx2-tile"><div class="l">Attack Angle</div><div class="v">${aa}</div></div>
        <div class="bx2-tile"><div class="l">Bat Speed</div><div class="v">${bat}</div></div>
        <div class="bx2-tile"><div class="l">Launch Angle</div><div class="v">${la}</div></div>
      </div>
    </div></div>`;

  if (L === 'v3') return `
    <div class="mc-expand"><div class="bx3">
      <span class="bx3-chip"><span class="l">BB\u2212K</span><span class="v">${bbk}</span></span>
      <span class="bx3-chip val"><span class="l">wOBA</span><span class="v">${woba}</span></span>
      <span class="bx3-chip val"><span class="l">xwOBA</span><span class="v">${xwoba}</span></span>
      <span class="bx3-chip"><span class="l">Attack Angle</span><span class="v">${aa}</span></span>
      <span class="bx3-chip"><span class="l">Bat Speed</span><span class="v">${bat}</span></span>
      <span class="bx3-chip"><span class="l">Launch Angle</span><span class="v">${la}</span></span>
    </div></div>`;

  return `
    <div class="mc-expand"><div class="bx1">
      <div class="bx1-col"><div class="bx1-h">Stats</div>
        <div class="bx1-r"><span>BB\u2212K</span><b>${bbk}</b></div>
        <div class="bx1-r"><span>wOBA</span><b class="acc">${woba}</b></div>
        <div class="bx1-r"><span>xwOBA</span><b class="acc">${xwoba}</b></div></div>
      <div class="bx1-sep"></div>
      <div class="bx1-col"><div class="bx1-h">Swing</div>
        <div class="bx1-r"><span>Attack ang</span><b>${aa}</b></div>
        <div class="bx1-r"><span>Bat speed</span><b>${bat}</b></div>
        <div class="bx1-r"><span>Launch ang</span><b>${la}</b></div></div>
    </div></div>`;
}
function renderTable() {
  const data = sorted(filtered());
  document.getElementById('count').innerHTML = `<b>${data.length}</b> of ${DATA.length} shown`;
  const tbody = document.getElementById('tbody');
  if (!tbody) return;
  tbody.innerHTML = data.map(d => `
    <tr data-id="${d.id}" class="${state.selectedId === d.id ? 'selected' : ''}">
      <td class="rank">${d._rank ?? '—'}</td>
      <td class="name-cell"><a href="javascript:void(0)" class="mc-name-link" onclick="window.location.hash='player/${d.id}';return false;"><span class="last">${d.last}</span>, <span class="first">${d.first}</span></a></td>
      <td class="ctr"><span class="side-pill ${d.side}">${d.side}</span></td>
      <td class="ctr"><span class="platoon-pill p-${d.platoon_tier}">${d.platoon_tier}</span></td>
      <td class="ctr">${gradeBadge(d.overall)}</td>
      <td class="ctr">${gradeBadge(d.power)}</td>
      <td class="ctr">${gradeBadge(d.contact)}</td>
      <td class="ctr">${gradeBadge(d.discipline)}</td>
      <td class="ctr">${luckCell(d)}</td>
      <td class="ctr">${heatCell(d)}</td>
    </tr>
    ${state.selectedId === d.id ? `` : ''}
  `).join('');
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      const id = parseInt(tr.dataset.id);
      state.selectedId = state.selectedId === id ? null : id;
      renderTable(); renderPanel();
    });
  });
}

function _yoyData(d){
  var prevY = String(+curYear - 1);
  var cy = YEARS[curYear] && YEARS[curYear].players[d.id];
  var py = YEARS[prevY] && YEARS[prevY].players[d.id];
  if(!cy||!py) return null;
  var kbb=function(p){ return (p.k!=null&&p.bb!=null)?(p.k-p.bb):null; };
  return [
    ['Bat speed', py.bat_speed, cy.bat_speed, ''],
    ['Barrel%',   py.barrel,    cy.barrel,    '%'],
    ['Z-Contact%',py.z_contact, cy.z_contact, '%'],
    ['K-BB%',     kbb(py),      kbb(cy),      '%'],
  ];
}
function _f1(v,s){ return v==null?'—':v.toFixed(1)+(s||''); }
function _dl(pv,cv){ return (pv!=null&&cv!=null)?cv-pv:null; }
function _ds(dl){ return dl==null?'—':(dl>=0?'+':'−')+Math.abs(dl).toFixed(1); }
function panelYoYGrid(d){
  var rows=_yoyData(d);
  if(!rows) return '<div class="panel-yoy-empty">No prior-year data.</div>';
  return rows.map(function(r){
    var dl=_dl(r[1],r[2]);
    var dir=(dl==null||Math.abs(dl)<1e-9)?'yflat':(dl>0?'yup':'ydn');
    var prev=_f1(r[1],r[3]), curr=_f1(r[2],r[3]);
    var head='<div class="yoy2-head"><span class="yoy2-lbl">'+r[0]+'</span><span class="yoy-delta">'+_ds(dl)+'</span></div>';
    var cells='<div class="yoy2-pair yoy-view-cells"><div class="mc p"><div class="yr">2025</div><div class="vl">'+prev+'</div></div><div class="mc c"><div class="yr">2026</div><div class="vl '+dir+'">'+curr+'</div></div></div>';
    var split='<div class="yoy2-bar yoy-view-split"><span class="seg p">'+prev+'</span><span class="seg c"><span class="num '+dir+'">'+curr+'</span></span></div>';
    return '<div class="yoy2-cell">'+head+cells+split+'</div>';
  }).join('');
}

function renderPanel() {
  const panel = document.getElementById('panel');
  if (!panel) return;
  const d = DATA.find(x => x.id === state.selectedId);
  if (!d) {
    panel.innerHTML = '<div class="panel-empty"><div class="big">Select a hitter<br/>to see the radar</div><div class="hint">click any row</div></div>';
    return;
  }
  panel.innerHTML = `<div class="card panel-card"><div class="panel-yr-legend">${yoyLegendHTML()}</div><a class="panel-fp-corner" href="javascript:void(0)" onclick="window.location.hash='player/'+${d.id};return false;">Full page ↗</a><div class="panel-radar">${renderRadar(d)}</div><div class="panel-yoy panel-yoy-grid">${panelYoYGrid(d)}</div></div>`;
}

function renderMobileCards() {
  const data = sorted(filtered());
  const mc = document.getElementById('mcards');
  if (!mc) return;
  mc.innerHTML = data.map(d => {
    const isExpanded = state.expandedId === d.id;
    return `
    <div class="mc-wrap ${isExpanded ? 'expanded' : ''}">
      <div class="mc" data-id="${d.id}">
        <span class="mc-name"><a href="javascript:void(0)" class="mc-name-link" data-full="${d.first} ${d.last}" data-abbr="${d.first[0]}. ${d.last}" onclick="window.location.hash='player/${d.id}';return false;">${d.first} ${d.last}</a></span>
        <span class="mc-team">${d.team ? `<span class="team-pill team-${d.team}">${d.team}</span>` : ''}</span>
        <span class="mc-pos">${d.position ? `<span class="pos-pill">${d.position}</span>` : ''}</span>
        <span class="mc-stat">${gradeBadge(d.overall)}</span>
        <span class="mc-stat">${heatCell(d)}</span>
      </div>
      ${isExpanded ? expandedPanel(d) : ''}
    </div>`;
  }).join('');
  mc.querySelectorAll('.mc').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const id = parseInt(card.dataset.id);
      state.expandedId = state.expandedId === id ? null : id;
      renderMobileCards();
    });
  });
  // name: full -> "F. Last" if it doesn't fit; CSS ellipsis handles the rest
  mc.querySelectorAll('.mc-name').forEach(el => {
    const a = el.querySelector('a');
    if (a && el.scrollWidth > el.clientWidth + 1) a.textContent = a.dataset.abbr;
  });
}


function renderRadar(d) {
  // 6 axes: Raw Power, Game Power, Swing Decision, Discipline, Speed, Bat-to-Ball
  const swing_decision = (d.z_swing != null && d.z_contact != null) ? d.z_swing * d.z_contact * 100 : null;
  const axes = [
    { label: 'Raw Power',     value: d.bat_speed != null ? percentile(S.bat_speed_s, d.bat_speed) : 50 },
    { label: 'Game Power',    value: d.barrel_pct != null ? percentile(S.barrel_pct, d.barrel_pct) : 50 },
    { label: 'Swing Decision',value: swing_decision != null ? percentile(S.swing_decision_combo, swing_decision) : 50 },
    { label: 'Discipline',    value: d.o_swing != null ? (100 - percentile(S.o_swing, d.o_swing)) : 50 },
    { label: 'Speed',         value: d.sprint != null ? percentile(S.sprint, d.sprint) : 50 },
    { label: 'Bat-to|Ball',   value: d.whiff != null ? (100 - percentile(S.whiff_s, d.whiff)) : 50 },
  ];
  const cx = 230, cy = 190, R = 130;
  const N = axes.length;
  
  // Polar to cartesian
  function pt(i, r) {
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / N;
    return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
  }

  // Prior-year (faded) overlay from real data, rescaled to current pools
  const prevYear = String(+curYear - 1);
  const py = (typeof YEARS !== 'undefined' && YEARS[prevYear]) ? YEARS[prevYear].players[d.id] : null;
  let prevPoints = null;
  if (py) {
    const sdP = (py.z_swing != null && py.z_contact != null) ? (py.z_swing / 100) * (py.z_contact / 100) * 100 : null;
    const pv = [
      py.bat_speed != null ? percentile(S.bat_speed_s, py.bat_speed) : 50,
      py.barrel    != null ? percentile(S.barrel_pct, py.barrel) : 50,
      sdP          != null ? percentile(S.swing_decision_combo, sdP) : 50,
      py.o_swing   != null ? (100 - percentile(S.o_swing, py.o_swing / 100)) : 50,
      py.sprint    != null ? percentile(S.sprint, py.sprint) : 50,
      py.whiff     != null ? (100 - percentile(S.whiff_s, py.whiff)) : 50,
    ];
    prevPoints = pv.map((v, i) => pt(i, R * (v || 0) / 100).join(',')).join(' ');
  }
  
  // Grid rings at 25/50/75/100
  let grid = '';
  for (const ratio of [0.25, 0.5, 0.75, 1.0]) {
    const points = axes.map((_, i) => pt(i, R * ratio).join(',')).join(' ');
    grid += `<polygon points="${points}" fill="none" stroke="#3a3a35" stroke-width="1" />`;
  }
  
  // Axis lines
  let spokes = '';
  for (let i = 0; i < N; i++) {
    const [x, y] = pt(i, R);
    spokes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#3a3a35" stroke-width="1" />`;
  }
  
  // Data polygon
  const dataPoints = axes.map((a, i) => pt(i, R * (a.value || 0) / 100).join(',')).join(' ');
  const dataDots = axes.map((a, i) => {
    const [x, y] = pt(i, R * (a.value || 0) / 100);
    return `<circle cx="${x}" cy="${y}" r="5" fill="#ffd54a" />`;
  }).join('');
  
  // Labels
  let labels = '';
  for (let i = 0; i < N; i++) {
    const [lx, ly] = pt(i, R + 24);
    let anchor = 'middle';
    if (lx > cx + 5) anchor = 'start';
    else if (lx < cx - 5) anchor = 'end';
    const words = axes[i].label.toUpperCase().split(/[ |]/);
    if (words.length > 1) {
      const lh = 15;
      const yStart = ly - (lh * (words.length - 1)) / 2;
      const tspans = words.map((w, j) => `<tspan x="${lx}" dy="${j === 0 ? 0 : lh}">${w}</tspan>`).join('');
      labels += `<text x="${lx}" y="${yStart}" text-anchor="${anchor}" dominant-baseline="middle" fill="#f5f5f0" font-family="Inter, sans-serif" font-weight="700" font-size="15" letter-spacing="0.02em">${tspans}</text>`;
      const valY = ly + (lh * (words.length - 1)) / 2 + 16;
      labels += `<text x="${lx}" y="${valY}" text-anchor="${anchor}" dominant-baseline="middle" fill="#ffd54a" font-family="Inter, sans-serif" font-weight="700" font-size="14">${axes[i].value != null ? Math.round(axes[i].value) : '—'}</text>`;
    } else {
      labels += `<text x="${lx}" y="${ly}" text-anchor="${anchor}" dominant-baseline="middle" fill="#f5f5f0" font-family="Inter, sans-serif" font-weight="700" font-size="15" letter-spacing="0.02em">${axes[i].label.toUpperCase()}</text>`;
      const valY = ly + 16;
      labels += `<text x="${lx}" y="${valY}" text-anchor="${anchor}" dominant-baseline="middle" fill="#ffd54a" font-family="Inter, sans-serif" font-weight="700" font-size="14">${axes[i].value != null ? Math.round(axes[i].value) : '—'}</text>`;
    }
  }
  
  return `
    <svg viewBox="20 0 450 375" width="100%" style="max-width:510px;display:block;margin:0 auto">
      ${grid}
      ${spokes}
      ${prevPoints ? `<polygon points="${prevPoints}" fill="#888" fill-opacity="0.14" stroke="#888" stroke-width="1.5" stroke-dasharray="4 3" />` : ''}
      <polygon points="${dataPoints}" fill="rgba(255,213,74,0.28)" stroke="#ffd54a" stroke-width="2.5" />
      ${dataDots}
      ${labels}
    </svg>
  `;
}




function _radarAxes(d){
  const sd = (d.z_swing != null && d.z_contact != null) ? d.z_swing * d.z_contact * 100 : null;
  return [
    d.bat_speed  != null ? percentile(S.bat_speed_s, d.bat_speed) : 50,
    d.barrel_pct != null ? percentile(S.barrel_pct, d.barrel_pct) : 50,
    sd           != null ? percentile(S.swing_decision_combo, sd) : 50,
    d.o_swing    != null ? (100 - percentile(S.o_swing, d.o_swing)) : 50,
    d.sprint     != null ? percentile(S.sprint, d.sprint) : 50,
    d.whiff      != null ? (100 - percentile(S.whiff_s, d.whiff)) : 50,
  ];
}

function compareRadar(a, b){
  const labels = ['Raw Power','Game Power','Swing Decision','Discipline','Speed','Bat-to|Ball'];
  const cx = 230, cy = 195, R = 130, N = 6;
  const pt = (i, r) => { const ang = -Math.PI/2 + (2*Math.PI*i)/N; return [cx + r*Math.cos(ang), cy + r*Math.sin(ang)]; };
  const av = _radarAxes(a), bv = _radarAxes(b);
  let grid = '';
  for (const ratio of [0.25, 0.5, 0.75, 1.0]) {
    const p = labels.map((_, i) => pt(i, R*ratio).join(',')).join(' ');
    grid += `<polygon points="${p}" fill="none" stroke="#3a3a35" stroke-width="1" />`;
  }
  let spokes = '';
  for (let i = 0; i < N; i++) { const [x, y] = pt(i, R); spokes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#3a3a35" stroke-width="1" />`; }
  const poly = (vals, color, fill) => {
    const pts = vals.map((v, i) => pt(i, R*(v||0)/100).join(',')).join(' ');
    const dots = vals.map((v, i) => { const [x, y] = pt(i, R*(v||0)/100); return `<circle cx="${x}" cy="${y}" r="4" fill="${color}" />`; }).join('');
    return `<polygon points="${pts}" fill="${fill}" stroke="${color}" stroke-width="2.5" />${dots}`;
  };
  let lbls = '';
  for (let i = 0; i < N; i++) {
    const [lx, ly] = pt(i, R + 22);
    let anchor = 'middle';
    if (lx > cx + 5) anchor = 'start'; else if (lx < cx - 5) anchor = 'end';
    const words = labels[i].toUpperCase().split(/[ |]/);
    if (words.length > 1) {
      const lh = 15, yStart = ly - (lh*(words.length-1))/2;
      const tspans = words.map((w, j) => `<tspan x="${lx}" dy="${j===0?0:lh}">${w}</tspan>`).join('');
      lbls += `<text x="${lx}" y="${yStart}" text-anchor="${anchor}" dominant-baseline="middle" fill="#f5f5f0" font-family="Inter, sans-serif" font-weight="700" font-size="14" letter-spacing="0.02em">${tspans}</text>`;
    } else {
      lbls += `<text x="${lx}" y="${ly}" text-anchor="${anchor}" dominant-baseline="middle" fill="#f5f5f0" font-family="Inter, sans-serif" font-weight="700" font-size="14" letter-spacing="0.02em">${labels[i].toUpperCase()}</text>`;
    }
  }
  return `
    <svg viewBox="20 18 450 356" width="100%" style="max-width:340px;display:block;margin:0 auto">
      ${grid}${spokes}
      ${poly(bv, '#7fb3dd', 'rgba(127,179,221,0.18)')}
      ${poly(av, '#ffd54a', 'rgba(255,213,74,0.22)')}
      ${lbls}
    </svg>`;
}

const CMP_METRICS = { woba: 'wOBA', xwoba: 'xwOBA', barrel: 'Barrel%', k: 'K%' };
let cmpRollMetric = 'woba', cmpRollW = 100;

function compareRollingChart(a, b, metric, W){
  metric = metric || 'woba'; W = W || 100;
  const ra = (typeof ROLLING !== 'undefined' && ROLLING[a.id]) || null;
  const rb = (typeof ROLLING !== 'undefined' && ROLLING[b.id]) || null;
  if (!ra || !rb || ra.length < W || rb.length < W){
    return '<div class="cp-roll-empty">Not enough PA for a ' + W + '-PA window on both hitters.</div>';
  }
  const isPct = (metric === 'barrel' || metric === 'k' || metric === 'bb' || metric === 'zone');
  const wa = rollingSeries(ra, W)[metric];
  const wb = rollingSeries(rb, W)[metric];
  const Wd = 460, Hd = (typeof window !== "undefined" && window.innerWidth <= 900) ? 250 : 184, pad = { t: 12, r: 14, b: 24, l: 40 };
  const iW = Wd - pad.l - pad.r, iH = Hd - pad.t - pad.b;
  const xMin = W, xMax = Math.max(W + wa.length - 1, W + wb.length - 1);
  const allv = wa.concat(wb);
  let yMin = Math.min(...allv), yMax = Math.max(...allv);
  const padY = (yMax - yMin) * 0.10 + (isPct ? 0.4 : 0.004); yMin -= padY; yMax += padY;
  const sx = pa => pad.l + ((pa - xMin) / (xMax - xMin || 1)) * iW;
  const sy = v => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * iH;
  const fmtY = isPct ? (v => v.toFixed(0) + '%') : (v => v.toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.'));
  const niceStep = r => { const m = Math.pow(10, Math.floor(Math.log10(r))); const n = r / m; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * m; };
  const step = niceStep((yMax - yMin) / 4);
  const yt = []; for (let v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) yt.push(+v.toFixed(6));
  const grid = yt.map(t => `<line x1="${pad.l}" y1="${sy(t).toFixed(1)}" x2="${Wd-pad.r}" y2="${sy(t).toFixed(1)}" stroke="#2a2a2a" stroke-width="1" />`).join('');
  const yLab = yt.map(t => `<text x="${pad.l-7}" y="${(sy(t)+3.5).toFixed(1)}" text-anchor="end" fill="#888" font-family="Inter,sans-serif" font-size="10">${fmtY(t)}</text>`).join('');
  let xt = []; for (let pa = Math.ceil(xMin/100)*100; pa <= xMax - 20; pa += 100) xt.push(pa);
  const xLab = xt.map(pa => `<text x="${sx(pa).toFixed(1)}" y="${Hd-pad.b+16}" text-anchor="middle" fill="#888" font-family="Inter,sans-serif" font-size="10">${pa}</text>`).join('');
  const line = (vals, color, w) => {
    const pts = vals.map((v, i) => `${sx(W+i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" />`;
  };
  return `
    <svg viewBox="0 0 ${Wd} ${Hd}" width="100%" style="display:block">
      ${grid}${yLab}${xLab}
      ${line(wb, '#7fb3dd', 2)}
      ${line(wa, '#ffd54a', 2.5)}
    </svg>`;
}

function cmpRollPanel(a, b){
  const mBtns = Object.keys(CMP_METRICS).map(k =>
    `<button class="cp-rtog${cmpRollMetric===k?' on':''}" onclick="cmpRoll('m','${k}')">${CMP_METRICS[k]}</button>`).join('');
  const wBtns = [50,100,250].map(w =>
    `<button class="cp-rtog${cmpRollW===w?' on':''}" onclick="cmpRoll('w',${w})">${w}</button>`).join('');
  return `<div class="cp-roll-head">
      <div class="cp-rtog-group">${mBtns}</div>
      <div class="cp-rtog-group">${wBtns}<span class="cp-rtog-unit">PA</span></div>
    </div>${compareRollingChart(a, b, cmpRollMetric, cmpRollW)}`;
}

function cmpRoll(kind, val){
  if (kind === 'm') cmpRollMetric = val; else cmpRollW = +val;
  const a = DATA.find(x => x.id === state.cmpA), b = DATA.find(x => x.id === state.cmpB);
  const wrap = document.querySelector('.cp-roll-wrap');
  if (a && b && wrap) wrap.innerHTML = cmpRollPanel(a, b);
}

function computeRollingMean(arr, window) {
  const out = [];
  for (let i = window - 1; i < arr.length; i++) {
    let s = 0;
    for (let j = i - window + 1; j <= i; j++) s += arr[j];
    out.push(s / window);
  }
  return out;
}

function rollingSeries(rows, W) {
  const n = rows.length, woba=[], xwoba=[], zone=[], barrel=[], k=[], bb=[];
  for (let i = W - 1; i < n; i++) {
    let wv=0,wd=0,xv=0,br=0,be=0,kf=0,bf=0,zi=0,pi=0;
    for (let j = i-W+1; j <= i; j++){ const r=rows[j]; wv+=r[0];wd+=r[1];xv+=r[2];br+=r[3];be+=r[4];kf+=r[5];bf+=r[6];zi+=r[7];pi+=r[8]; }
    woba.push(wd?wv/wd:0); xwoba.push(wd?xv/wd:0);
    barrel.push(be?br/be*100:0); k.push(kf/W*100); bb.push(bf/W*100); zone.push(pi?zi/pi*100:0);
  }
  return { woba, xwoba, zone, barrel, k, bb };
}

function renderRollingChart(metric, windowSize) {
  const W = 720, H = 280, pad = { t: 16, r: 16, b: 32, l: 44 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  
  let series, colors, ySuffix, yTicks, isPct;
  if (!ROLLING_ROWS || ROLLING_ROWS.length < windowSize) {
    return '<div style="padding:24px;color:var(--ink-3);font-family:Inter,sans-serif;font-size:12px;">Not enough PA for a ' + windowSize + '-PA window.</div>';
  }
  const RS = rollingSeries(ROLLING_ROWS, windowSize);
  if (metric === 'woba') {
    series = [
      { name: 'wOBA',  vals: RS.woba,  color: '#f5f5f0', width: 2, opacity: 0.9, dash: '' },
      { name: 'xwOBA', vals: RS.xwoba, color: '#ffd54a', width: 2.5, opacity: 1, dash: '' },
    ];
    isPct = false;
  } else {
    series = [
      { name: 'Zone%',   vals: RS.zone,   color: '#f5f5f0', width: 2, opacity: 0.9, dash: '' },
      { name: 'Barrel%', vals: RS.barrel, color: '#ffd54a', width: 2.5, opacity: 1, dash: '' },
      { name: 'K%',      vals: RS.k,      color: '#e57373', width: 2, opacity: 0.95, dash: '4 3' },
      { name: 'BB%',     vals: RS.bb,     color: '#7fb3dd', width: 2, opacity: 0.95, dash: '4 3' },
    ];
    isPct = true;
  }
  
  const startPA = windowSize;
  const allVals = series.flatMap(s => s.vals);
  const yMin = Math.min(...allVals) * (isPct ? 0.95 : 0.97) - (isPct ? 1 : 0.005);
  const yMax = Math.max(...allVals) * (isPct ? 1.05 : 1.03) + (isPct ? 1 : 0.005);
  const xMin = startPA, xMax = startPA + series[0].vals.length - 1;
  
  const sx = pa => pad.l + ((pa - xMin) / (xMax - xMin)) * innerW;
  const sy = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;
  
  const path = (vals) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${sx(startPA + i).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ');
  
  // Y ticks
  let ticks;
  if (isPct) {
    const step = 5;
    ticks = [];
    for (let t = Math.ceil(yMin/step)*step; t <= yMax; t += step) ticks.push(t);
  } else {
    ticks = [0.30, 0.35, 0.40, 0.45, 0.50].filter(t => t >= yMin && t <= yMax);
  }
  const yGrid = ticks.map(t => `<line x1="${pad.l}" y1="${sy(t)}" x2="${W-pad.r}" y2="${sy(t)}" stroke="#252525" stroke-width="1" />`).join('');
  const yLabels = ticks.map(t => `<text x="${pad.l - 8}" y="${sy(t) + 4}" text-anchor="end" fill="#888" font-family="Inter, sans-serif" font-size="10">${isPct ? t.toFixed(0)+'%' : '.'+(t*1000).toFixed(0)}</text>`).join('');
  
  // X ticks every 100 PA
  const xTicks = [];
  for (let t = Math.ceil(xMin/100)*100; t <= xMax; t += 100) xTicks.push(t);
  const xLabels = xTicks.map(t => `<text x="${sx(t)}" y="${H - pad.b + 14}" text-anchor="middle" fill="#888" font-family="Inter, sans-serif" font-size="10">${t}</text>`).join('');
  const xUnit = `<text x="${W - pad.r}" y="${H - pad.b + 14}" text-anchor="end" fill="#666" font-family="Inter, sans-serif" font-size="9">PA</text>`;
  
  _rollingPlot = { series, startPA, xMin, xMax, yMin, yMax, pad, innerW, innerH, W, H, isPct };
  const paths = series.map(s => `<path d="${path(s.vals)}" fill="none" stroke="${s.color}" stroke-width="${s.width}" opacity="${s.opacity}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} />`).join('');
  
  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;margin:0 auto">
      ${yGrid}
      ${paths}
      ${yLabels}
      ${xLabels}
      ${xUnit}
      <line id="rollCursorLine" x1="0" y1="${pad.t}" x2="0" y2="${H - pad.b}" stroke="#ffd54a" stroke-width="1" stroke-dasharray="3 3" opacity="0" />
      <g id="rollCursorDots"></g>
      <g id="rollTip" opacity="0"></g>
      <rect id="rollHit" x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}" fill="transparent" style="cursor:crosshair" />
    </svg>
  `;
}

function renderRollingLegend(metric) {
  const items = metric === 'woba'
    ? [['wOBA','#f5f5f0',''], ['xwOBA','#ffd54a','']]
    : [['Zone%','#f5f5f0',''], ['Barrel%','#ffd54a',''], ['K%','#e57373','dashed'], ['BB%','#7fb3dd','dashed']];
  return items.map(([name, color, dash]) =>
    `<span class="rl-item"><span class="rl-sw" style="background:${color};${dash === 'dashed' ? 'border-top: 2px dashed '+color+';background:transparent;height:0;' : ''}"></span>${name}</span>`
  ).join('');
}

let _rollingPlot = null;
let _rollingMetric = 'woba';
let _rollingWindow = 100;
function wireRollingHover() {
  const svg = document.querySelector('#rollingChartHost svg');
  const hit = document.getElementById('rollHit');
  const P = _rollingPlot;
  if (!svg || !hit || !P) return;
  const line = document.getElementById('rollCursorLine');
  const dots = document.getElementById('rollCursorDots');
  const tip = document.getElementById('rollTip');
  const sx = pa => P.pad.l + ((pa - P.xMin) / (P.xMax - P.xMin)) * P.innerW;
  const sy = v => P.pad.t + (1 - (v - P.yMin) / (P.yMax - P.yMin)) * P.innerH;
  const fmtV = v => P.isPct ? v.toFixed(1) + '%' : v.toFixed(3).replace(/^0/, '');
  hit.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width * P.W;
    let pa = Math.round(P.xMin + (mx - P.pad.l) / P.innerW * (P.xMax - P.xMin));
    pa = Math.max(P.xMin, Math.min(P.xMax, pa));
    const idx = pa - P.startPA, x = sx(pa);
    line.setAttribute('x1', x); line.setAttribute('x2', x); line.setAttribute('opacity', 1);
    let d = '', rows = '';
    const vis = P.series.filter(s => s.vals[idx] != null);
    vis.forEach((s, i) => {
      const v = s.vals[idx], y = sy(v);
      d += '<circle cx="' + x + '" cy="' + y + '" r="3" fill="' + s.color + '" />';
    });
    dots.innerHTML = d;
    const tw = 104, th = 20 + vis.length * 14;
    let tx = x + 12; if (tx + tw > P.W) tx = x - 12 - tw;
    const ty = P.pad.t + 4;
    rows = vis.map((s, i) => '<text x="' + (tx + 9) + '" y="' + (ty + 31 + i * 14) + '" font-family="Inter,sans-serif" font-size="10" fill="' + s.color + '">' + s.name + '  ' + fmtV(s.vals[idx]) + '</text>').join('');
    tip.innerHTML = '<rect x="' + tx + '" y="' + ty + '" width="' + tw + '" height="' + th + '" rx="4" fill="#16160f" stroke="#3a3a30" opacity="0.96" />' +
      '<text x="' + (tx + 9) + '" y="' + (ty + 15) + '" font-family="Inter,sans-serif" font-size="10" fill="#888">PA ' + pa + '</text>' + rows;
    tip.setAttribute('opacity', 1);
  });
  hit.addEventListener('mouseleave', () => { line.setAttribute('opacity', 0); dots.innerHTML = ''; tip.setAttribute('opacity', 0); });
}

function refreshRolling() {
  const host = document.getElementById('rollingChartHost');
  const leg = document.getElementById('rollingLegend');
  if (!host || !leg) return;
  host.innerHTML = renderRollingChart(_rollingMetric, _rollingWindow);
  leg.innerHTML = renderRollingLegend(_rollingMetric);
  wireRollingHover();
}

function wireRollingControls() {
  const tabs = document.getElementById('rollingMetricTabs');
  if (!tabs) return;
  tabs.querySelectorAll('.rt-tab').forEach(b => {
    b.onclick = () => {
      tabs.querySelectorAll('.rt-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _rollingMetric = b.dataset.metric;
      refreshRolling();
    };
  });
  document.querySelectorAll('.rw-btn').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.rw-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _rollingWindow = parseInt(b.dataset.window, 10);
      refreshRolling();
    };
  });
  refreshRolling();
}

function renderRadarOverlay(d) {
  // Two-shape radar: dim grey (2024) + lime (2025) overlaid
  const swing_decision = (d.z_swing != null && d.z_contact != null) ? d.z_swing * d.z_contact * 100 : null;
  const cur = [
    { label: 'Raw Power',     value: d.bat_speed != null ? percentile(S.bat_speed_s, d.bat_speed) : 50 },
    { label: 'Game Power',    value: d.barrel_pct != null ? percentile(S.barrel_pct, d.barrel_pct) : 50 },
    { label: 'Swing Decision',value: swing_decision != null ? percentile(S.swing_decision_combo, swing_decision) : 50 },
    { label: 'Discipline',    value: d.o_swing != null ? (100 - percentile(S.o_swing, d.o_swing)) : 50 },
    { label: 'Speed',         value: d.sprint != null ? percentile(S.sprint, d.sprint) : 50 },
    { label: 'Bat-to|Ball',   value: d.whiff != null ? (100 - percentile(S.whiff_s, d.whiff)) : 50 },
  ];
  // Mock 2024 values - hardcoded for Judge demo
  const prev = [
    { value: 91 },  // Power 2024
    { value: 56 },  // Disc 2024
    { value: 68 },  // Contact 2024
    { value: 87 },  // Bat speed 2024
    { value: 45 },  // Sprint 2024
    { value: 79 },  // Z-Con 2024
  ];
  
  const cx = 230, cy = 190, R = 130;
  const N = 6;
  
  function pt(i, r) {
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / N;
    return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
  }
  
  let grid = '';
  for (const ratio of [0.25, 0.5, 0.75, 1.0]) {
    const points = cur.map((_, i) => pt(i, R * ratio).join(',')).join(' ');
    grid += `<polygon points="${points}" fill="none" stroke="#3a3a35" stroke-width="1" />`;
  }
  let spokes = '';
  for (let i = 0; i < N; i++) {
    const [x, y] = pt(i, R);
    spokes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#3a3a35" stroke-width="1" />`;
  }
  
  const prevPoints = prev.map((a, i) => pt(i, R * (a.value || 0) / 100).join(',')).join(' ');
  const curPoints = cur.map((a, i) => pt(i, R * (a.value || 0) / 100).join(',')).join(' ');
  
  const curDots = cur.map((a, i) => {
    const [x, y] = pt(i, R * (a.value || 0) / 100);
    return `<circle cx="${x}" cy="${y}" r="5" fill="#ffd54a" />`;
  }).join('');
  
  let labels = '';
  for (let i = 0; i < N; i++) {
    const [lx, ly] = pt(i, R + 24);
    let anchor = 'middle';
    if (lx > cx + 5) anchor = 'start';
    else if (lx < cx - 5) anchor = 'end';
    const words = cur[i].label.toUpperCase().split(/[ |]/);
    if (words.length > 1) {
      const lh = 15;
      const yStart = ly - (lh * (words.length - 1)) / 2;
      const tspans = words.map((w, j) => `<tspan x="${lx}" dy="${j === 0 ? 0 : lh}">${w}</tspan>`).join('');
      labels += `<text x="${lx}" y="${yStart}" text-anchor="${anchor}" dominant-baseline="middle" fill="#f5f5f0" font-family="Inter, sans-serif" font-weight="700" font-size="14" letter-spacing="0.02em">${tspans}</text>`;
    } else {
      labels += `<text x="${lx}" y="${ly}" text-anchor="${anchor}" dominant-baseline="middle" fill="#f5f5f0" font-family="Inter, sans-serif" font-weight="700" font-size="15" letter-spacing="0.02em">${cur[i].label.toUpperCase()}</text>`;
    }
  }
  
  const legend = "";
  
  return `
    <svg viewBox="-30 0 520 400" width="100%" style="max-width:600px;display:block;margin:0 auto">
      ${grid}
      ${spokes}
      <polygon points="${prevPoints}" fill="#888" fill-opacity="0.18" stroke="#888" stroke-width="1.5" stroke-dasharray="4 3" />
      <polygon points="${curPoints}" fill="rgba(255,213,74,0.15)" stroke="#ffd54a" stroke-width="2" />
      ${curDots}
      ${labels}
      ${legend}
    </svg>
  `;
}


function renderJunkRadar() {
  // Mock data: two arbitrary shapes (blue + maroon) on 6-axis radar
  const labels = ['Raw Power', 'Game Power', 'Swing Decision', 'Discipline', 'Speed', 'Bat-to|Ball'];
  const blueShape = [82, 64, 71, 88, 52, 76];
  const maroonShape = [68, 79, 84, 71, 60, 88];
  
  const cx = 230, cy = 190, R = 130;
  const N = 6;
  
  function pt(i, r) {
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / N;
    return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
  }
  
  let grid = '';
  for (const ratio of [0.25, 0.5, 0.75, 1.0]) {
    const points = labels.map((_, i) => pt(i, R * ratio).join(',')).join(' ');
    grid += `<polygon points="${points}" fill="none" stroke="#3a3a35" stroke-width="1" />`;
  }
  let spokes = '';
  for (let i = 0; i < N; i++) {
    const [x, y] = pt(i, R);
    spokes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#3a3a35" stroke-width="1" />`;
  }
  
  const bluePoints = blueShape.map((v, i) => pt(i, R * v / 100).join(',')).join(' ');
  const maroonPoints = maroonShape.map((v, i) => pt(i, R * v / 100).join(',')).join(' ');
  
  const blueDots = blueShape.map((v, i) => {
    const [x, y] = pt(i, R * v / 100);
    return `<circle cx="${x}" cy="${y}" r="3" fill="#5b8def" />`;
  }).join('');
  const maroonDots = maroonShape.map((v, i) => {
    const [x, y] = pt(i, R * v / 100);
    return `<circle cx="${x}" cy="${y}" r="3" fill="#8b2c3f" />`;
  }).join('');
  
  let labelsSvg = '';
  for (let i = 0; i < N; i++) {
    const [lx, ly] = pt(i, R + 24);
    let anchor = 'middle';
    if (lx > cx + 5) anchor = 'start';
    else if (lx < cx - 5) anchor = 'end';
    const words = labels[i].toUpperCase().split(/[ |]/);
    if (words.length > 1) {
      const lh = 15;
      const yStart = ly - (lh * (words.length - 1)) / 2;
      const tspans = words.map((w, j) => `<tspan x="${lx}" dy="${j === 0 ? 0 : lh}">${w}</tspan>`).join('');
      labelsSvg += `<text x="${lx}" y="${yStart}" text-anchor="${anchor}" dominant-baseline="middle" fill="#f5f5f0" font-family="Inter, sans-serif" font-weight="700" font-size="14" letter-spacing="0.02em">${tspans}</text>`;
    } else {
      labelsSvg += `<text x="${lx}" y="${ly}" text-anchor="${anchor}" dominant-baseline="middle" fill="#f5f5f0" font-family="Inter, sans-serif" font-weight="700" font-size="15" letter-spacing="0.02em">${labels[i].toUpperCase()}</text>`;
    }
  }
  
  const legend = `
    <g transform="translate(${cx - 80}, 360)">
      <rect x="0" y="0" width="10" height="10" fill="#5b8def" opacity="0.25" stroke="#5b8def" stroke-width="1.5" />
      <text x="16" y="9" fill="#5b8def" font-family="Inter, sans-serif" font-size="10">2024</text>
      <rect x="70" y="0" width="10" height="10" fill="#8b2c3f" opacity="0.25" stroke="#8b2c3f" stroke-width="1.5" />
      <text x="86" y="9" fill="#8b2c3f" font-family="Inter, sans-serif" font-size="10">2025</text>
    </g>
  `;
  
  return `
    <svg viewBox="-30 0 520 400" width="100%" style="max-width:600px;display:block;margin:0 auto">
      ${grid}
      ${spokes}
      <polygon points="${bluePoints}" fill="#5b8def" fill-opacity="0.18" stroke="#5b8def" stroke-width="1.5" />
      <polygon points="${maroonPoints}" fill="#8b2c3f" fill-opacity="0.22" stroke="#8b2c3f" stroke-width="1.5" />
      ${blueDots}
      ${maroonDots}
      ${labelsSvg}
      ${legend}
    </svg>
  `;
}

function renderYoY(d) {
  const prevYear = String(+curYear - 1);
  const cy = YEARS[curYear] && YEARS[curYear].players[d.id];
  const py = YEARS[prevYear] && YEARS[prevYear].players[d.id];
  if (!cy || !py) return '<div style="padding:24px 0;color:var(--ink-3);font-family:\'Inter\',sans-serif;font-size:12px;">No ' + prevYear + ' data for this hitter.</div>';
  const f1 = (v,s='') => v==null ? '—' : v.toFixed(1)+s;
  const rows = [
    ['Bat speed',  py.bat_speed, cy.bat_speed, '',  true],
    ['Barrel%',    py.barrel,    cy.barrel,    '%', true],
    ['Z-Contact%', py.z_contact, cy.z_contact, '%', true],
    ['BB%',        py.bb,        cy.bb,        '%', true],
    ['K%',         py.k,         cy.k,         '%', false],
  ].map(([label, pv, cv, suf, hi]) => {
    const dl = (pv!=null && cv!=null) ? cv-pv : null;
    const good = dl==null ? true : (hi ? dl>=0 : dl<=0);
    const ds = dl==null ? '—' : (dl>=0?'+':'−') + Math.abs(dl).toFixed(1);
    return '<div class="yoy-row"><span class="yoy-label">'+label+'</span><div class="yoy-bars"><div class="yoy-bar-prev"><span class="yoy-bar-prev-val">'+f1(pv,suf)+'</span></div><div class="yoy-bar-curr"><span class="yoy-bar-curr-val">'+f1(cv,suf)+'</span></div></div><span class="yoy-delta '+(good?'good':'bad')+'">'+ds+'</span></div>';
  }).join('');
  const wob = v => v==null ? '—' : v.toFixed(3).replace(/^0/,'');
  return '<div class="yoy-grid"><div class="yoy-stats-col"><div class="yoy-bar-legend">'
    + '<span class="yoy-bar-legend-item"><span class="yoy-bar-legend-sw prev"></span>'+prevYear+'</span>'
    + '<span class="yoy-bar-legend-item"><span class="yoy-bar-legend-sw curr"></span>'+curYear+'</span></div>'
    + '<div style="display:grid;grid-template-columns:1fr;gap:8px;">'+rows+'</div></div>'
    + '<div class="yoy-radar-col">'+renderRadarOverlay(d)
    + '<div class="yoy-xwoba-row"><div class="yoy-xwoba-item"><div class="yoy-xwoba-lbl">'+prevYear+' xwOBA</div><div class="yoy-xwoba-val">'+wob(py.xwoba)+'</div></div>'
    + '<div class="yoy-xwoba-item"><div class="yoy-xwoba-lbl">'+curYear+' xwOBA</div><div class="yoy-xwoba-val">'+wob(cy.xwoba)+'</div></div></div></div></div>';
}

function renderYoYRows(d) {
  const prevYear = String(+curYear - 1);
  const cy = YEARS[curYear] && YEARS[curYear].players[d.id];
  const py = YEARS[prevYear] && YEARS[prevYear].players[d.id];
  if (!cy || !py) return '<div class="pp-yoy-empty">No ' + prevYear + ' data for this hitter.</div>';
  const f1 = (v,s='') => v==null ? '—' : v.toFixed(1)+s;
  return [
    ['Bat speed',  py.bat_speed, cy.bat_speed, '',  true],
    ['Barrel%',    py.barrel,    cy.barrel,    '%', true],
    ['Z-Contact%', py.z_contact, cy.z_contact, '%', true],
    ['BB%',        py.bb,        cy.bb,        '%', true],
    ['K%',         py.k,         cy.k,         '%', false],
  ].map(([label, pv, cv, suf, hi]) => {
    const dl = (pv!=null && cv!=null) ? cv-pv : null;
    const good = dl==null ? true : (hi ? dl>=0 : dl<=0);
    const ds = dl==null ? '—' : (dl>=0?'+':'−') + Math.abs(dl).toFixed(1);
    return '<div class="yoy-row"><span class="yoy-label">'+label+'</span><div class="yoy-bars"><div class="yoy-bar-prev"><span class="yoy-bar-prev-val">'+f1(pv,suf)+'</span></div><div class="yoy-bar-curr"><span class="yoy-bar-curr-val">'+f1(cv,suf)+'</span></div></div><span class="yoy-delta '+(good?'good':'bad')+'">'+ds+'</span></div>';
  }).join('');
}
function yoyLegendHTML() {
  const prevYear = String(+curYear - 1);
  return '<div class="yoy-bar-legend"><span class="yoy-bar-legend-item"><span class="yoy-bar-legend-sw prev"></span>'+prevYear+'</span>'
    + '<span class="yoy-bar-legend-item"><span class="yoy-bar-legend-sw curr"></span>'+curYear+'</span></div>';
}

function renderPlayerPage(id) {
  const d = DATA.find(x => x.id === id);
  ROLLING_ROWS = (d && ROLLING[d.id]) || null;
  const pp = document.getElementById('playerPage');
  if (!d || !pp) {
    if (pp) pp.style.display = 'none';
    return;
  }
  document.body.style.overflow = 'hidden';
  pp.style.display = 'block';
  
  function bar(value, label, sortedArr, invert) {
    if (value == null) return `<b style="color:#8a8a85">—</b>`;
    return `<b style="color: #f5f5f0;font-weight:600">${label}</b>`;
  }
  
  const fmt = (v, suf='') => v == null ? '—' : (typeof v === 'number' ? v.toFixed(1) + suf : v);
  const fmtRate = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';
  const fmtWoba = (v) => v == null ? '—' : v.toFixed(3).replace(/^0/, '');
  const fmtSigned = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(3).replace(/^(-?)0/, '$1');

  const luck = (d.woba != null && d.xwoba != null) ? d.woba - d.xwoba : null;
  const luckGap = luck == null ? '—' : fmtSigned(luck);
  const luckColor = luck == null ? 'var(--ink-2)' : (Math.abs(luck) < 0.005 ? 'var(--ink-2)' : (luck > 0 ? '#d99a6c' : '#7fb3dd'));
  const yoyLegend = yoyLegendHTML();
  const yoyBars = renderYoYRows(d);

  
  pp.querySelector('.pp-inner').innerHTML = `
    <button class="pp-back" onclick="history.back()">← Back to all hitters</button>
    <div class="pp-header">
      <div>
        <div class="pp-name">${d.first} ${d.last}</div>
        <div class="pp-meta">
          <span class="side-pill ${d.side}">${d.side}</span>
          ${d.team ? `<span class="team-pill team-${d.team}">${d.team}</span>` : ''}
          <span>${d.position || ''}</span>
          <span>·</span>
          <span class="platoon-pill p-${d.platoon_tier}">${d.platoon_tier}</span>
          <span>${d.pa} PA</span>
          <span>·</span>
          <span>${fmtWoba(d.woba)} wOBA</span>
          <span>${fmtWoba(d.xwoba)} xwOBA</span>
        </div>
      </div>
      <div class="pp-grades-row">
        <div class="pp-grade pp-grade-overall"><div class="pp-grade-label">Overall</div>${gradeBadge(d.overall)}</div>
      </div>
    </div>
    <div class="pp-tabs" id="ppTabs">
      <button data-tab="stats" class="active">Stats + YoY</button>
      <button data-tab="rolling">Rolling</button>
    </div>
    
    <div class="pp-tab-panel active" data-panel="stats">
      <div class="pp-overview">
        <div class="pp-overview-stats">
          <div class="pp-panel">
            <div class="pp-bnr">Plate skills</div>
            <div class="pp-rows">
              <div class="pp-stat-row"><span>Z-Swing%</span>${bar(d.z_swing, fmtRate(d.z_swing), S.z_swing)}</div>
              <div class="pp-stat-row"><span>Z-Contact%</span>${bar(d.z_contact, fmtRate(d.z_contact), S.z_contact_s)}</div>
              <div class="pp-stat-row"><span>O-Contact%</span>${bar(d.o_contact, fmtRate(d.o_contact), S.o_contact)}</div>
            </div>
          </div>
          <div class="pp-panel">
            <div class="pp-bnr">Swing path</div>
            <div class="pp-rows">
              <div class="pp-stat-row"><span>Attack angle</span>${bar(d.attack_angle, fmt(d.attack_angle, '°'), S.attack_angle)}</div>
              <div class="pp-stat-row"><span>Ideal AA%</span>${bar(d.iaa, d.iaa != null ? d.iaa.toFixed(1) + '%' : '—', S.iaa)}</div>
              <div class="pp-stat-row"><span>Attack direction</span>${bar(d.attack_direction, attackDirLabel(d.attack_direction), S.attack_direction)}</div>
              <div class="pp-stat-row"><span>Swing tilt</span>${bar(d.tilt, swingTiltLabel(d.tilt), S.tilt)}</div>
            </div>
          </div>
          <div class="pp-panel">
            <div class="pp-bnr">Value</div>
            <div class="pp-rows">
              <div class="pp-stat-row"><span>wOBA</span><b style="color:#f5f5f0;font-weight:600">${fmtWoba(d.woba)}</b></div>
              <div class="pp-stat-row"><span>xwOBA</span><b style="color:var(--accent);font-weight:600">${fmtWoba(d.xwoba)}</b></div>
              <div class="pp-stat-row"><span>Luck gap</span><b style="color:${luckColor};font-weight:600">${luckGap}</b></div>
            </div>
          </div>
        </div>
        <div class="pp-panel pp-overview-radar">
          <div class="pp-bnr">Year over year</div>
          ${yoyLegend}
          <div class="pp-radar-row">
            <div class="pp-radar-wrap">${renderRadar(d)}</div>
            <div class="pp-yoy-bars">${yoyBars}</div>
          </div>
        </div>
      </div>
    </div>
    
    <div class="pp-tab-panel" data-panel="rolling">
      <div class="rolling-tab-body">
        ${ROLLING[d.id] ? `
          <div class="rolling-controls">
            <div class="rolling-tabs" id="rollingMetricTabs">
              <button class="rt-tab active" data-metric="woba">wOBA suite</button>
              <button class="rt-tab" data-metric="zone">Outcomes</button>
            </div>
            <div class="rolling-window">
              <span class="rw-lbl">Window:</span>
              <button class="rw-btn" data-window="50">50</button>
              <button class="rw-btn active" data-window="100">100</button>
              <button class="rw-btn" data-window="250">250</button>
            </div>
          </div>
          
          <div id="rollingLegend" class="rolling-legend"></div>
          
          <div id="rollingChartHost"></div>
        ` : '<div style="padding: 24px 0; color: var(--ink-3); font-family: \'Inter\', sans-serif; font-size: 12px;">Rolling data not available for this hitter.</div>'}
      </div>
    </div>
    


  `;
  
  // Wire up tab switching
  pp.querySelectorAll('.pp-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      pp.querySelectorAll('.pp-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === target));
      pp.querySelectorAll('.pp-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === target));
        if (target === 'rolling') { setTimeout(wireRollingControls, 0); }
    });
  });
}
document.getElementById('q')?.addEventListener('input', e => { state.query = e.target.value; renderTable(); renderMobileCards(); });
document.querySelectorAll('#sideSeg button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#sideSeg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); state.side = b.dataset.v; renderTable(); renderMobileCards();
  });
});
document.getElementById('posFilter')?.addEventListener('change', e => {
  state.position = e.target.value; renderTable(); renderMobileCards();
});
document.getElementById('min')?.addEventListener('input', e => {
  state.min = parseInt(e.target.value);
  document.getElementById('minVal').textContent = e.target.value;
  renderTable(); renderMobileCards();
});
document.querySelectorAll('#headerRow th').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = k; state.sortDir = (k === 'name' || k === 'side') ? 'asc' : 'desc'; }
    renderTable(); renderMobileCards();
  });
});
document.querySelectorAll('#mcHeader > div').forEach(h => {
  h.addEventListener('click', () => {
    const k = h.dataset.k;
    if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = k; state.sortDir = (k === 'name' || k === 'rank') ? 'asc' : 'desc'; }
    document.querySelectorAll('#mcHeader > div').forEach(x => x.classList.toggle('active', x.dataset.k === state.sortKey));
    renderTable(); renderMobileCards();
  });
});



function renderCompare() {
  const cp = document.getElementById('comparePage');
  if (!cp) return;
  document.body.style.overflow = 'hidden';
  cp.style.display = 'block';
  
  // Default: Judge (id 592450) vs Ohtani (id 660271)
  if (!state.cmpA) state.cmpA = 592450;
  if (!state.cmpB) state.cmpB = 660271;
  
  const a = DATA.find(x => x.id === state.cmpA);
  const b = DATA.find(x => x.id === state.cmpB);
  
  // Set search inputs to selected names
  const inA = document.getElementById('cmpSearchA');
  const inB = document.getElementById('cmpSearchB');
  if (a && document.activeElement !== inA) inA.value = `${a.first} ${a.last}`;
  if (b && document.activeElement !== inB) inB.value = `${b.first} ${b.last}`;
  
  if (!a || !b) {
    document.getElementById('cpContent').innerHTML = '';
    return;
  }
  
  // Stats config: [label, accessor, formatter, higherIsBetter]
  const fmtPct = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
  const fmtPctSign = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  const fmtPctDirect = v => v == null ? '—' : v.toFixed(1) + '%';
  const fmtMph = v => v == null ? '—' : v.toFixed(1) + ' mph';
  const fmtDeg = v => v == null ? '—' : v.toFixed(1) + '°';
  const fmtWoba = v => v == null ? '—' : v.toFixed(3).replace(/^0/, '');
  
  const stats = [
    ['__section', 'Rate'],
    ['wOBA',            d => d.woba,       fmtWoba,    true],
    ['BB − K%',         d => d.bb_minus_k, fmtPctSign, true],
    ['Whiff %',         d => d.whiff,      v => v == null ? '—' : v.toFixed(1) + '%', false],
    ['__section', 'Plate skills'],
    ['Z-Contact %',     d => d.z_contact,  fmtPct,     true],
    ['O-Swing %',       d => d.o_swing,    fmtPct,     false],
    ['__section', 'Swing path'],
    ['Sweet Spot %',    d => d.sweet_pct,  fmtPctDirect, true],
    ['Bat speed',       d => d.bat_speed,  v => v == null ? '—' : v.toFixed(1), true],
  ];
  
  const headers = '';
  
  const rows = stats.map(row => {
    if (row[0] === '__section') {
      return `<div class="cp-section-h"><span>${row[1]}</span></div>`;
    }
    const [label, accessor, fmt, higherBetter] = row;
    const va = accessor(a);
    const vb = accessor(b);
    let aWin = false, bWin = false;
    if (higherBetter !== null && va != null && vb != null && va !== vb) {
      if (higherBetter) { aWin = va > vb; bWin = vb > va; }
      else { aWin = va < vb; bWin = vb < va; }
    }
    return `
      <div class="cp-row">
        <div class="cp-label">${label}</div>
        <div class="cp-val ${aWin ? 'winner' : ''}">${fmt(va)}</div>
        <div class="cp-val ${bWin ? 'winner' : ''}">${fmt(vb)}</div>
      </div>
    `;
  }).join('');
  
  const tableHeaders = `
    <div class="cp-table-headers">
      <div class="cp-table-h-spacer"></div>
      <div class="cp-table-h-name"><span class="cp-hdr-sw" style="background:#ffd54a"></span>${a.last}</div>
      <div class="cp-table-h-name"><span class="cp-hdr-sw" style="background:#7fb3dd"></span>${b.last}</div>
    </div>
  `;
  const right = `
    <div class="cp-right">
      <div class="cp-matchup">
        <span class="cp-mu-name a"><span class="cp-mu-sw" style="background:#ffd54a"></span>${a.first} ${a.last}</span>
        <span class="cp-mu-vs">vs</span>
        <span class="cp-mu-name b">${b.first} ${b.last}<span class="cp-mu-sw" style="background:#7fb3dd"></span></span>
      </div>
      <div class="cp-radar-wrap">${compareRadar(a, b)}</div>
      <div class="cp-roll-wrap">${cmpRollPanel(a, b)}</div>
    </div>`;
  const cptab = state.cmpTab || 'radar';
  document.getElementById('cpContent').innerHTML =
    '<div class="cp-tabs">' +
      '<button class="cp-tab' + (cptab==='radar'?' on':'') + '" data-cptab="radar" onclick="cpSetTab(\'radar\')">Radar</button>' +
      '<button class="cp-tab' + (cptab==='roll'?' on':'') + '" data-cptab="roll" onclick="cpSetTab(\'roll\')">Rolling</button>' +
      '<button class="cp-tab' + (cptab==='table'?' on':'') + '" data-cptab="table" onclick="cpSetTab(\'table\')">Table</button>' +
    '</div>' +
    '<div class="cp-layout cp-tab-' + cptab + '">' +
      '<div class="cp-card">' + tableHeaders + rows + '</div>' +
      right +
    '</div>';
}

function cpSetTab(t) {
  state.cmpTab = t;
  const lay = document.querySelector('.cp-layout');
  if (lay) lay.className = 'cp-layout cp-tab-' + t;
  document.querySelectorAll('.cp-tab').forEach(b => b.classList.toggle('on', b.dataset.cptab === t));
}

function setupCompareSearch() {
  function makeSearch(inputId, resultsId, slot) {
    const input = document.getElementById(inputId);
    const results = document.getElementById(resultsId);
    if (!input) return;
    
    function showResults(query) {
      const q = query.toLowerCase().trim();
      if (!q) {
        results.classList.remove('open');
        return;
      }
      const matches = DATA.filter(d => d.raw_name.toLowerCase().includes(q)).slice(0, 8);
      results.innerHTML = matches.map(d => `
        <div class="cp-result-row" data-id="${d.id}">
          <span>${d.first} ${d.last}</span>
          <span class="meta">${d.team || ''} · ${d.position || ''}</span>
        </div>
      `).join('');
      results.classList.add('open');
      results.querySelectorAll('.cp-result-row').forEach(row => {
        row.addEventListener('click', () => {
          const id = parseInt(row.dataset.id);
          if (slot === 'A') state.cmpA = id;
          else state.cmpB = id;
          results.classList.remove('open');
          renderCompare();
        });
      });
    }
    
    input.addEventListener('input', e => showResults(e.target.value));
    input.addEventListener('focus', e => { if (e.target.value) showResults(e.target.value); });
    document.addEventListener('click', e => {
      if (!input.contains(e.target) && !results.contains(e.target)) {
        results.classList.remove('open');
      }
    });
  }
  makeSearch('cmpSearchA', 'cmpResultsA', 'A');
  makeSearch('cmpSearchB', 'cmpResultsB', 'B');
}

setupCompareSearch();

function handleRoute() {
  const hash = window.location.hash;
  const m = hash.match(/^#player\/(\d+)$/);
  if (m) {
    document.getElementById('comparePage').style.display = 'none';
    renderPlayerPage(parseInt(m[1]));
  } else if (hash === '#compare') {
    document.getElementById('playerPage').style.display = 'none';
    renderCompare();
  } else {
    document.getElementById('playerPage').style.display = 'none';
    document.getElementById('comparePage').style.display = 'none';
    document.body.style.overflow = '';
  }
}
window.addEventListener('hashchange', handleRoute);

let YEARS = {};
let curYear = '2026';

function buildYear(year) {
  const c = YEARS[year];
  const prev = YEARS[String(+year - 1)];
  const prevW = {};
  if (prev) for (const [id, p] of Object.entries(prev.players || {})) prevW[id] = p.woba;
  let tL = 0, tR = 0;
  for (const p of Object.values(c.players)) { tL += p.pa_L || 0; tR += p.pa_R || 0; }
  const total = tL + tR || 1, shL = tL / total, shR = tR / total;
  DATA = Object.entries(c.players).map(([id, p]) => transform(id, p, prevW[id], shL, shR));
  QUALPA = c.qualPA || QUALPA;
  if (year === '2026') {
    for (const d of DATA) {
      const rows = ROLLING[d.id];
      if (rows && rows.length) {
        const N = Math.min(100, rows.length), tail = rows.slice(-N);
        let wv=0, wd=0; for (const r of tail){ wv+=r[0]; wd+=r[1]; }
        const rec = wd ? wv/wd : null;
        d.woba_recent = rec!=null ? +rec.toFixed(3) : null;
        d.pa_recent = N;
        d.heat = (rec!=null && d.woba!=null) ? +(rec - d.woba).toFixed(3) : null;
      }
    }
  }
  recompute();
}

function applyYearChrome() {
  const floor = DATA.length ? Math.max(1, Math.floor(Math.min(...DATA.map(d => d.pa)) / 10) * 10) : QUALPA;
  state.min = QUALPA;
  const mn = document.getElementById('min');
  if (mn) {
    mn.min = floor;
    if (QUALPA > +mn.max) mn.max = QUALPA;
    mn.value = QUALPA;
    const mv = document.getElementById('minVal');
    if (mv) mv.textContent = QUALPA;
  }
  document.querySelectorAll('#yearSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === curYear));
}

function switchYear(year) {
  if (!YEARS[year] || year === curYear) return;
  curYear = year;
  state.selectedId = null;
  buildYear(year);
  applyYearChrome();
  renderTable(); renderPanel(); renderMobileCards();
}

async function load() {
  const tbody = document.getElementById('tbody');
  try {
    const [cur, prev, roll] = await Promise.all([
      fetch(DATA_URL).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }),
      fetch(DATA_2025_URL).then(r => r.ok ? r.json() : { players: {} }).catch(() => ({ players: {} })),
      fetch(ROLLING_URL).then(r => r.ok ? r.json() : {}).catch(() => ({}))
    ]);
    ROLLING = roll || {};
    YEARS['2026'] = { players: cur.players, qualPA: cur.qualPA };
    YEARS['2025'] = { players: prev.players || {}, qualPA: prev.qualPA || 502 };
    curYear = '2026';
    buildYear('2026');
    applyYearChrome();
    document.querySelectorAll('#yearSeg button').forEach(b =>
      b.addEventListener('click', () => switchYear(b.dataset.v)));
    const top = sorted(filtered())[0]; if (top) state.selectedId = top.id;
    renderTable(); renderPanel(); renderMobileCards(); handleRoute();
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="padding:28px;text-align:center;color:var(--ink-3)">Couldn\u2019t load ' + DATA_URL + ' \u2014 serve over http (python3 -m http.server), not file://</td></tr>';
    console.error(e);
  }
}
load();


