// CONFIG 
const hostname = location.hostname || '192.168.100.65';
const API_URL  = (hostname === 'localhost' || hostname === '127.0.0.1')
  ? 'http://127.0.0.1:8000'
  : `http://${hostname}:8000`;

const MAX_DIM    = 640;
const TIMEOUT_MS = 180_000;

// ── STATE
let vehicleInfo      = null;
let estimateSettings = { listType: 'client', vehicleSize: 'medium', labourTier: 'standard' };
let manualAdditions  = [];
let manualRemovals   = new Set();
let severityOverrides = new Map();  // partKey__damageType → 'minor'|'moderate'|'severe'
let partDecisions    = new Map();   // itemKey → 'repair'|'replace'|'none'
let sparePartsMap    = {};          // partKey → price (MUR excl. VAT), populated per vehicle model
let _lastAllItems    = [];          // snapshot of last rendered estimate items for recalc
let photoQueue       = [];
let nextPhotoId      = 1;
let _lastMergedPipeline = null;

// SEVERITY RANK 
const SEV_RANK = { minor: 0, moderate: 1, severe: 2 };

//  INIT
document.addEventListener('DOMContentLoaded', () => {
  $('vig-input')?.addEventListener('change', e => e.target.files[0] && scanVignette(e.target.files[0]));
  $('vig-btn')?.addEventListener('click',  () => $('vig-input')?.click());
  $('vig-skip')?.addEventListener('click', skipVignette);
  $('file-in').addEventListener('change',  e => { if (e.target.files.length) addFiles(e.target.files); });
  $('cam-in').addEventListener('change',   e => { if (e.target.files[0]) addFiles(e.target.files); });
  $('upload-btn').addEventListener('click', () => $('file-in').click());
  $('cam-btn').addEventListener('click',    () => $('cam-in').click());
  $('add-more-btn')?.addEventListener('click', () => $('file-in').click());
  const dz = $('drop-zone');
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  $('reset-btn').addEventListener('click', reset);
  $('btn-client')?.addEventListener('click',  () => switchList('client'));
  $('btn-interne')?.addEventListener('click', () => switchList('interne'));
  $('vehicle-model')?.addEventListener('input', e => onVehicleInput(e.target.value));
  $('history-tab')?.addEventListener('click', () => { show('history-panel'); hide('main-panel'); loadHistory(); });
  $('main-tab')?.addEventListener('click',    () => { show('main-panel'); hide('history-panel'); });
  if (typeof window.Pricing !== 'undefined') {
    populateVehicleAutocomplete();
  } else {
    window.addEventListener('pricing-ready', populateVehicleAutocomplete, { once: true });
  }
});

// VIGNETTE

async function scanVignette(file) {
  setVigLoading(true); hideError();
  try {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`${API_URL}/scan-vignette`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    vehicleInfo = data;
    if (data.make || data.model || data.policy_no || data.registration) {
      applyVehicleInfo(data); renderVignetteCard(data);
    } else {
      showVignetteFallback('Could not read vehicle details from the vignette.');
    }
  } catch (err) {
    showVignetteFallback('Vignette scan failed. Please enter vehicle details manually.');
  } finally { setVigLoading(false); }
}

function skipVignette() { vehicleInfo = null; showVignetteFallback(null); }

function showVignetteFallback(errorMsg) {
  const errEl = $('vf-error-msg');
  if (errEl) { errEl.textContent = errorMsg ?? ''; errEl.style.display = errorMsg ? 'block' : 'none'; }
  const populateMakes = () => {
    const makeEl = $('vf-make');
    if (!makeEl || makeEl.options.length > 1) return;
    const models = window.Pricing?.listAllModels?.() ?? [];
    const makes  = [...new Set(models.map(m => m.brand))];
    makes.forEach(b => { const opt = document.createElement('option'); opt.value = b; opt.textContent = b; makeEl.appendChild(opt); });
  };
  if (typeof window.Pricing !== 'undefined') { populateMakes(); }
  else { window.addEventListener('pricing-ready', populateMakes, { once: true }); }
  switchVigTab('vin');
  const vinInput = $('vf-vin-input'); if (vinInput) vinInput.value = '';
  hide('vf-vin-result'); show('vig-fallback'); hide('vig-step'); show('damage-step');
}

function switchVigTab(tab) {
  ['vin','manual'].forEach(t => {
    $('vf-tab-'+t)?.classList.toggle('active', t === tab);
    const p = $('vf-'+t+'-panel'); if (p) p.style.display = t === tab ? 'block' : 'none';
  });
}

function onMakeChange(make) {
  const modelSel = $('vf-model'); if (!modelSel) return;
  const models = window.Pricing?.listAllModels?.() ?? [];
  const list   = models.filter(m => m.brand === make);
  modelSel.innerHTML = '<option value="">Select model\u2026</option>' +
    list.map(m => `<option value="${m.name}">${m.name.charAt(0).toUpperCase()+m.name.slice(1)}</option>`).join('');
  modelSel.disabled = list.length === 0;
}

async function decodeVIN() {
  const input = $('vf-vin-input');
  const vin   = input?.value?.trim().toUpperCase();
  const res   = $('vf-vin-result');
  const stripped = vin?.replace(/[^A-Z0-9]/g,'') ?? '';
  if (stripped.length < 6) {
    if (res) { res.textContent = 'Enter at least 6 characters of the VIN.'; res.style.display='block'; res.className='vig-fallback-decoded error'; }
    return;
  }
  if (res) { res.textContent = 'Decoding…'; res.style.display='block'; res.className='vig-fallback-decoded'; }
  try {
    const resp = await fetch(`${API_URL}/decode-vin?vin=${encodeURIComponent(vin)}`);
    const data = await resp.json();
    if (data.success && (data.make || data.model)) {
      const label = [data.make,data.model,data.year].filter(Boolean).join(' ');
      if (res) {
        res.innerHTML = `<span class="vig-decoded-vehicle">${label}</span><button class="vig-decoded-confirm" id="vin-use-btn">Use this vehicle</button>`;
        res.className = 'vig-fallback-decoded success';
        const btn = document.getElementById('vin-use-btn');
        if (btn) btn.addEventListener('click', () => completeVigFallback({ make:data.make, model:data.model, year:data.year??null, vin:data.vin }));
      }
    } else {
      if (res) { res.textContent = data.error ?? 'Could not decode this VIN. Try the manual entry tab.'; res.className='vig-fallback-decoded error'; }
    }
  } catch (err) {
    if (res) { res.textContent = `Decode failed: ${err.message}`; res.className='vig-fallback-decoded error'; }
  }
}

function applyManualEntry() {
  const make  = $('vf-make')?.value?.trim();
  const model = $('vf-model')?.value?.trim();
  const year  = parseInt($('vf-year')?.value) || null;
  if (!make || !model) { alert('Please select a make and model.'); return; }
  completeVigFallback({ make, model, year, vin: null });
}

function completeVigFallback(data) {
  hide('vig-fallback');
  if (data) {
    applyVehicleInfo({ make:data.make, model:data.model, year:data.year, vin:data.vin,
      vehicle_size: window.Pricing?.resolveVehicle((data.make+' '+data.model))?.size ?? 'medium' });
    const size = window.Pricing?.resolveVehicle((data.make+' '+data.model))?.size ?? 'medium';
    setText('vc-vehicle', (data.make??'')+' '+(data.model??'')+(data.year?' '+data.year:''));
    const sizeTag = $('vc-size-tag');
    if (sizeTag) { sizeTag.textContent=size.toUpperCase(); sizeTag.className='vig-size-tag '+size; }
    setText('vc-vin', data.vin??'');
    $('vc-vin-wrap') && ($('vc-vin-wrap').style.display = data.vin?'block':'none');
    show('vig-confirm');
  }
  show('damage-step');
}

function applyVehicleInfo(data) {
  if (data.vehicle_size) { estimateSettings.vehicleSize=data.vehicle_size; updateSizeBadge(data.vehicle_size); }
  if (data.year) { const y=$('vehicle-year-input'); if (y&&!y.value) y.value=data.year; }
  const mi = $('vehicle-model');
  if (mi && data.make && data.model) {
    const ms = `${data.make} ${data.model}`; mi.value=ms;
    setText('vehicle-brand-detected', `✓ ${data.make}`);
    const r = window.Pricing?.resolveVehicle(ms); if (r?.labourTier) estimateSettings.labourTier=r.labourTier;
    fetchSparePartsForModel(data.model);
  }
}


// SPARE PARTS — fetch prices from CSV via backend


async function fetchSparePartsForModel(model) {
  if (!model) { sparePartsMap = {}; return; }
  // Normalise: "Kia Sportage" → "sportage", "Sportage" → "sportage"
  const slug = model.trim().split(/\s+/).pop().toLowerCase();
  try {
    const res = await fetch(`${API_URL}/spare-parts?model=${encodeURIComponent(slug)}`);
    if (!res.ok) { sparePartsMap = {}; return; }
    const data = await res.json();
    sparePartsMap = {};
    for (const [key, val] of Object.entries(data)) {
      sparePartsMap[key] = val.price;
    }
    // If estimate is already on screen, re-render so Replace buttons and
    // spare-price hints update with the freshly loaded prices
    if (_lastAllItems.length) refreshEstimate();
  } catch {
    sparePartsMap = {};
  }
}

function renderVignetteCard(data) {
  const card = $('vig-result'); if (!card) return;
  const year = data.year?` ${data.year}`:'';
  const vin  = data.vin?`<div class="vig-vin">VIN: ${data.vin}</div>`:'';
  const exp  = data.expiry_date?`<div class="vig-exp">Expiry: ${data.expiry_date}</div>`:'';
  card.innerHTML = `
    <div class="vig-card">
      <div class="vig-vehicle">${data.make??'?'} ${data.model??'?'}${year}</div>
      <div class="vig-meta">
        <span class="vig-size-tag ${data.vehicle_size??'medium'}">${(data.vehicle_size??'medium').toUpperCase()}</span>
        ${data.insurer?`<span class="vig-tag">${data.insurer}</span>`:''}
        ${data.registration?`<span class="vig-tag">${data.registration}</span>`:''}
      </div>${vin}${exp}
    </div>`;
  show('vig-result'); hide('vig-step'); show('damage-step');
}

function setVigLoading(on) { const b=$('vig-btn'); if(b) b.disabled=on; }


// PHOTO QUEUE


function addFiles(fileList) {
  Array.from(fileList).forEach(file => {
    photoQueue.push({ id:nextPhotoId++, file, previewUrl:URL.createObjectURL(file), status:'pending', result:null, error:null });
  });
  $('file-in').value=''; $('cam-in').value='';
  hide('drop-zone'); hide('upload-btn'); hide('cam-btn');
  show('photo-queue'); show('add-more-btn'); show('reset-btn');
  renderQueue(); processQueue();
}

function renderQueue() {
  const c = $('queue-grid'); if (!c) return;
  c.innerHTML = photoQueue.map(e => `
    <div class="q-thumb" id="qt-${e.id}">
      <div class="q-img-wrap">
        <img src="${e.previewUrl}" alt="photo ${e.id}" />
        <div class="q-overlay status-${e.status}">
          ${e.status==='analysing'?'<div class="q-spinner"></div>':''}
          ${e.status==='done'?'<div class="q-check"></div>':''}
          ${e.status==='error'?'<div class="q-err-icon"></div>':''}
        </div>
      </div>
      <div class="q-label">
        ${e.status==='pending'?'Pending':e.status==='analysing'?'Analysing':
          e.status==='done'?(e.result?.stage1?.severity?.class?.toUpperCase()??'Done'):'Error'}
      </div>
      <button class="q-remove" onclick="removePhoto(${e.id})" title="Remove">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
        </svg>
      </button>
    </div>`).join('');
}

function updateThumb(id) {
  const entry = photoQueue.find(e => e.id===id); if (!entry) return;
  const el = $(`qt-${id}`); if (!el) return;
  const ov = el.querySelector('.q-overlay');
  const lb = el.querySelector('.q-label');
  if (ov) {
    ov.className = `q-overlay status-${entry.status}`;
    ov.innerHTML = entry.status==='analysing'?'<div class="q-spinner"></div>':
                   entry.status==='done'?'<div class="q-check"></div>':
                   entry.status==='error'?'<div class="q-err-icon"></div>':'';
  }
  if (lb) lb.textContent = entry.status==='pending'?'Pending':entry.status==='analysing'?'Analysing':
    entry.status==='done'?(entry.result?.stage1?.severity?.class?.toUpperCase()??'Done'):'Error';
}

async function processQueue() {
  const pending = photoQueue.filter(e => e.status==='pending');
  const chunks  = [];
  for (let i=0; i<pending.length; i+=2) chunks.push(pending.slice(i,i+2));
  for (const chunk of chunks) await Promise.all(chunk.map(e => analysePhoto(e)));
  rebuildCombinedResults();
}

async function analysePhoto(entry) {
  entry.status='analysing'; updateThumb(entry.id);
  try {
    const resized = await resizeImage(entry.file, MAX_DIM);
    const fd = new FormData(); fd.append('file', resized);
    const params = new URLSearchParams();
    if (vehicleInfo?.success) params.set('vehicle_data', JSON.stringify(vehicleInfo));
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${API_URL}/predict?${params}`, { method:'POST', body:fd, signal:controller.signal });
    clearTimeout(timeout);
    if (!res.ok) { const d=await res.json().catch(()=>null); throw new Error(d?.detail??`Server error ${res.status}`); }
    const data = await res.json();
    if (!data?.stage1?.severity) throw new Error('Unexpected response from server');
    entry.result=data; entry.status='done';
  } catch (err) {
    entry.error=err.name==='AbortError'?'Timed out':err.message; entry.status='error';
  }
  updateThumb(entry.id);
}

function removePhoto(id) {
  photoQueue = photoQueue.filter(e => e.id!==id);
  if (!photoQueue.length) { reset(); return; }
  renderQueue(); rebuildCombinedResults();
}


// COMBINED RESULTS


function rebuildCombinedResults() {
  const done = photoQueue.filter(e => e.status==='done' && e.result);
  if (!done.length) { hide('combined-results'); return; }

  const allParts = new Set();
  for (const entry of done) {
    for (const region of (entry.result.stage2??[])) {
      for (const part of (region.parts??[])) allParts.add(part.name);
      for (const dmg  of (region.damages??[])) { if (dmg.on_part && dmg.on_part!=='unknown') allParts.add(dmg.on_part); }
    }
  }

  const merged = buildMergedPipeline(done);

  //  FIX 1: Overall severity — stage1 AND all stage2 regions 
  let worstSev    = 'minor';
  let worstConf   = 0;
  let worstProbs  = { minor:0, moderate:0, severe:0 };
  const sevCounts = { minor:0, moderate:0, severe:0 };

  for (const entry of done) {
    const s1 = entry.result.stage1.severity;
    if (SEV_RANK[s1.class] > SEV_RANK[worstSev] ||
        (SEV_RANK[s1.class]===SEV_RANK[worstSev] && s1.confidence > worstConf)) {
      worstSev=s1.class; worstConf=s1.confidence;
      worstProbs=s1.probabilities??{minor:0,moderate:0,severe:0};
    }
    for (const region of (entry.result.stage2??[])) {
      const sev = region.severity; if (!sev) continue;
      const cls = sev.class??'minor';
      if (cls in sevCounts) sevCounts[cls]++;
      if (SEV_RANK[cls] > SEV_RANK[worstSev] ||
          (SEV_RANK[cls]===SEV_RANK[worstSev] && (sev.confidence??0) > worstConf)) {
        worstSev=cls; worstConf=sev.confidence??0;
        worstProbs=sev.probabilities??{minor:0,moderate:0,severe:0};
      }
    }
  }

  // Majority vote — if most regions are higher severity, upgrade overall
  const totalRegions = sevCounts.minor + sevCounts.moderate + sevCounts.severe;
  if (totalRegions > 1) {
    const majorityClass = Object.entries(sevCounts).sort((a,b) => b[1]-a[1])[0][0];
    if (SEV_RANK[majorityClass] > SEV_RANK[worstSev]) worstSev = majorityClass;
  }

  show('combined-results');
  renderSeverityBadge({ class:worstSev, confidence:worstConf, probabilities:worstProbs });
  renderAllParts(allParts, merged);
  renderCombinedDetections(done);
  renderEstimate(merged);
}

function buildMergedPipeline(doneEntries) {
  const partBuckets = new Map();
  for (const entry of doneEntries) {
    for (const region of (entry.result.stage2??[])) {
      const regionSev = region.severity?.class??'minor';
      for (const dmg of (region.damages??[])) {
        const partKey = dmg.on_part||'unknown'; if (partKey==='unknown') continue;
        if (!partBuckets.has(partKey)) {
          partBuckets.set(partKey, { triggered_by:region.triggered_by, severity:region.severity, damages:[dmg], parts:region.parts??[] });
        } else {
          const bucket = partBuckets.get(partKey);
          if (SEV_RANK[regionSev] > SEV_RANK[bucket.severity?.class??'minor']) { bucket.severity=region.severity; bucket.triggered_by=region.triggered_by; }
          if (!bucket.damages.some(d => d.type===dmg.type)) bucket.damages.push(dmg);
          for (const p of (region.parts??[])) { if (!bucket.parts.some(bp => bp.name===p.name)) bucket.parts.push(p); }
        }
      }
    }
  }

  const allRegions = [...partBuckets.values()];

  //  FIX 3: worst severity includes stage2 regions 
  let worstSev   = 'minor';
  let worstConf  = 0;
  let worstProbs = { minor:0, moderate:0, severe:0 };
  for (const e of doneEntries) {
    const s1 = e.result.stage1.severity;
    if (SEV_RANK[s1.class] > SEV_RANK[worstSev] ||
        (SEV_RANK[s1.class]===SEV_RANK[worstSev] && s1.confidence > worstConf)) {
      worstSev=s1.class; worstConf=s1.confidence; worstProbs=s1.probabilities??{minor:0,moderate:0,severe:0};
    }
    for (const region of (e.result.stage2??[])) {
      const sev=region.severity; if (!sev) continue;
      const cls=sev.class??'minor';
      if (SEV_RANK[cls] > SEV_RANK[worstSev] ||
          (SEV_RANK[cls]===SEV_RANK[worstSev] && (sev.confidence??0) > worstConf)) {
        worstSev=cls; worstConf=sev.confidence??0; worstProbs=sev.probabilities??{minor:0,moderate:0,severe:0};
      }
    }
  }

  return {
    image_size: doneEntries[0].result.image_size,
    stage1: {
      severity: { class:worstSev, confidence:worstConf, probabilities:worstProbs },
      detections: [],
    },
    stage2: allRegions,
  };
}


// RENDER


function renderSeverityBadge(sev) {
  const badge = $('severity-badge'); if (!badge) return;
  badge.className = `sev-${sev.class}`;
  setText('sev-val',  sev.class.toUpperCase());
  setText('sev-conf', `${Math.round(sev.confidence*100)}% confidence`);
  show('severity-badge'); show('prob-bars');

  //  FIX 2: fallback when probabilities all zero 
  ['minor','moderate','severe'].forEach(c => {
    const probs = sev.probabilities??{};
    const total = Object.values(probs).reduce((s,v) => s+v, 0);
    const pct   = total > 0
      ? Math.round((probs[c]??0)*100)
      : (c===sev.class ? 100 : 0);   // ← fallback: 100% for winner
    const bar = $(`b-${c}`); if (bar) bar.style.width = pct+'%';
    setText(`p-${c}`, pct+'%');
  });
}

function renderAllParts(partNames, mergedPipeline) {
  const pl = $('parts-list'); if (!pl) return;
  let damagedKeys = new Set();
  if (typeof window.Pricing !== 'undefined') {
    const est = window.Pricing.buildEstimate(mergedPipeline, estimateSettings);
    damagedKeys = new Set(est.lineItems.map(i => i.partKey));
  }
  pl.innerHTML = [...partNames].map(name => {
    const key = window.Pricing?.resolvePartRegion?.(name)??name;
    return `<span class="part-chip ${damagedKeys.has(key)?'damaged':''}" data-part="${name}">${fmt(name)}</span>`;
  }).join('');
  show('parts-section');
}

function renderCombinedDetections(doneEntries) {
  const list = $('damage-list'); if (!list) return;
  list.innerHTML = '';
  doneEntries.forEach((entry, idx) => {
    list.insertAdjacentHTML('beforeend', `
      <div class="photo-header">
        <img src="${entry.previewUrl}" class="photo-thumb-sm" />
        <span>Photo ${idx+1}</span>
        <span class="region-sev">${entry.result.stage1.severity.class.toUpperCase()}</span>
      </div>`);
    for (const region of (entry.result.stage2??[])) {
      const sev = region.severity;
      list.insertAdjacentHTML('beforeend', `
        <div class="region-header sev-${sev.class}">
          <span class="region-title">${fmt(region.triggered_by?.type??'')}</span>
          <span class="region-sev">${sev.class.toUpperCase()}${sev.confidence>=0.5?' · '+Math.round(sev.confidence*100)+'%':''}</span>
        </div>`);
      if (region.damages?.length) region.damages.forEach(d => list.insertAdjacentHTML('beforeend', detectionCard(d, true)));
    }
  });
  show('damage-section');
}

function detectionCard(d, detailed=false) {
  // Only show overlap_pct if >= 50 — below that should not appear (pipeline filters, but guard here too)
  const overlapStr = (d.overlap_pct >= 50) ? ` · ${d.overlap_pct}%` : '';
  const part       = d.on_part ? `<div class="dmg-part">${fmt(d.on_part)}${overlapStr}</div>` : '';
  const sev        = d.severity;
  const sevBadge   = sev ? `<span class="dmg-sev-badge sev-bg-${sev.class}">${sev.class.toUpperCase()}${sev.confidence>=0.5?' '+Math.round(sev.confidence*100)+'%':''}</span>` : '';
  return `
    <div class="dmg-card ${detailed?'dmg-detailed':''}">
      <div class="dmg-left">
        <div class="dmg-type">${fmt(d.type)} ${sevBadge}</div>
        ${detailed?part:''}
      </div>
      <div class="dmg-conf-badge">${Math.round(d.conf*100)}%</div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ESTIMATE
// ─────────────────────────────────────────────────────────────────────────────

function renderEstimate(mergedPipeline) {
  if (typeof window.Pricing==='undefined') return;
  show('estimate-settings'); show('estimate-section');
  show('manual-damage-section'); show('save-section');
  setText('save-status','');
  const btn = $('save-btn'); if (btn) { btn.disabled=false; btn.classList.remove('saved'); }
  refreshEstimate(mergedPipeline);
}

// MANUAL DAMAGE EDITOR


const PART_LABELS_MAP = {
  front_bumper:'Front Bumper', rear_bumper:'Rear Bumper', bonnet:'Bonnet / Hood',
  front_fender:'Front Fender', rear_fender:'Rear Fender', front_door:'Front Door',
  rear_door:'Rear Door', trunk:'Trunk / Boot', roof:'Roof', sill:'Sill / Rocker',
  mirror:'Mirror', wheel_rim:'Wheel Rim', spot_repair:'Spot Repair', paint_touchup:'Paint Touch-up',
};

function renderManualDamageList(aiLineItems) {
  const list = $('manual-damage-list'); if (!list) return;
  const allItems = [
    ...(aiLineItems??[]).map(item => ({
      id:`ai__${item.partKey}__${item.damageType??''}`, partKey:item.partKey,
      partLabel:item.part, damageType:item.damageType??'', severity:item.severity, manual:false,
    })),
    ...manualAdditions,
  ].filter(item => !manualRemovals.has(`${item.partKey}__${item.damageType}`));

  if (!allItems.length) { list.innerHTML='<p class="manual-empty">No damage items yet. Add one below.</p>'; return; }
  list.innerHTML = allItems.map(item => {
    const overrideKey = `${item.partKey}__${item.damageType}`;
    const activeSev   = severityOverrides.get(overrideKey) ?? item.severity;
    return `
    <div class="manual-item ${item.manual?'manual-item-added':''}">
      <div class="manual-item-left">
        <span class="manual-item-part">${item.partLabel}</span>
        <span class="manual-item-meta">
          ${fmt(item.damageType)}
          ${item.manual?'<span class="manual-tag">Manual</span>':''}
        </span>
      </div>
      <div class="manual-item-right">
        <select class="sev-override-select sev-override-${activeSev}"
                onchange="overrideSeverity('${overrideKey}', this.value)">
          <option value="minor"    ${activeSev==='minor'   ?'selected':''}>Minor</option>
          <option value="moderate" ${activeSev==='moderate'?'selected':''}>Moderate</option>
          <option value="severe"   ${activeSev==='severe'  ?'selected':''}>Severe</option>
        </select>
        <button class="manual-remove-btn" onclick="removeDamageItem('${item.partKey}','${item.damageType}',${item.manual},'${item.id}')" title="Remove">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
          </svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

function overrideSeverity(key, newSev) {
  severityOverrides.set(key, newSev);
  // Update the select colour immediately
  const selects = document.querySelectorAll('.sev-override-select');
  selects.forEach(sel => {
    if (sel.getAttribute('onchange')?.includes(key)) {
      sel.className = `sev-override-select sev-override-${newSev}`;
    }
  });
  refreshEstimate();
}

function removeDamageItem(partKey, damageType, isManual, id) {
  if (isManual) { manualAdditions = manualAdditions.filter(a => a.id!==id); }
  else { manualRemovals.add(`${partKey}__${damageType}`); }
  refreshEstimate();
}

function openAddDamage()   { show('add-damage-form'); }
function cancelAddDamage() {
  hide('add-damage-form');
  if($('add-part'))     $('add-part').value='';
  if($('add-type'))     $('add-type').value='dent';
  if($('add-severity')) $('add-severity').value='moderate';
}

function confirmAddDamage() {
  const partKey    = $('add-part')?.value;
  const damageType = $('add-type')?.value??'dent';
  const severity   = $('add-severity')?.value??'moderate';
  if (!partKey) { alert('Please select a part.'); return; }
  manualRemovals.delete(`${partKey}__${damageType}`);
  const id = `manual__${partKey}__${damageType}__${Date.now()}`;
  manualAdditions.push({ id, partKey, partLabel:PART_LABELS_MAP[partKey]??partKey, damageType, severity, manual:true });
  cancelAddDamage(); refreshEstimate();
}

function refreshEstimate(mergedPipeline) {
  const pipeline = mergedPipeline??_lastMergedPipeline;
  if (!pipeline || typeof window.Pricing==='undefined') return;
  _lastMergedPipeline = pipeline;

  const estimate = window.Pricing.buildEstimate(pipeline, estimateSettings);
  const fmt2     = window.Pricing.formatMUR;

  const filteredItems = estimate.lineItems
    .filter(item => !manualRemovals.has(`${item.partKey}__${item.damageType??''}`))
    .map(item => {
      const key = `${item.partKey}__${item.damageType??''}`;
      const ov  = severityOverrides.get(key);
      if (!ov) return item;

      // Re-lookup FRU prices at the overridden severity level
      const newDL    = ov === 'minor' ? 'leger' : 'moyen';
      const repriced = window.Pricing.lookupPrices?.(
        item.partKey, newDL,
        estimateSettings.vehicleSize,
        estimateSettings.listType,
        estimateSettings.labourTier
      );
      return repriced
        ? { ...item, severity: ov, damageLevel: newDL, fru: repriced.fru, forfait: repriced.forfait, price: repriced.fru?.total ?? repriced.forfait ?? 0 }
        : { ...item, severity: ov, damageLevel: newDL };
    });
  const manualPriced  = manualAdditions.map(a => {
    const dl = a.severity==='minor'?'leger':'moyen';
    const priced = window.Pricing.lookupPrices?.(a.partKey,dl,estimateSettings.vehicleSize,estimateSettings.listType,estimateSettings.labourTier);
    if (!priced) return null;
    return { part:priced.partLabel, partKey:a.partKey, damageType:a.damageType, severity:a.severity, damageLevel:dl, fru:priced.fru, forfait:priced.forfait, price:priced.fru?.total??priced.forfait??0, manual:true };
  }).filter(Boolean);

  const seenManual = new Set(manualPriced.map(m => m.partKey));
  const allItems   = [...filteredItems.filter(i => !seenManual.has(i.partKey)), ...manualPriced];

  renderManualDamageList(estimate.lineItems);

  const tierLabel = estimateSettings.labourTier==='ev'?' · EV/Hybrid':'';
  setText('estimate-list-label', (window.Pricing.LIST_LABELS?.[estimateSettings.listType]??estimateSettings.listType)+tierLabel);

  const container = $('estimate-items'); if (!container) return;

  // Snapshot for live recalc on decision toggles
  _lastAllItems = allItems;

  if (!allItems.length) {
    container.innerHTML = `<div class="no-items">No parts matched in price list.${estimate.unknownParts.length?`<br><small>${estimate.unknownParts.join(', ')}</small>`:''}</div>`;
  } else {
    container.innerHTML = allItems.map(item => {
      const fru        = item.fru;
      const itemKey    = `${item.partKey}__${item.damageType??''}`;
      const dec        = partDecisions.get(itemKey) ?? 'repair';
      const sparePrice = sparePartsMap[item.partKey] ?? null;
      const canReplace = sparePrice !== null;
      const repairAmt  = item.fru?.total ?? item.price ?? 0;

      const activeAmt = dec === 'none'
        ? '<span style="color:#94a3b8">—</span>'
        : dec === 'replace' && canReplace
          ? fmt2(repairAmt + sparePrice)
          : fmt2(repairAmt);

      const activeBreakdown = dec === 'replace' && canReplace
        ? `<div class="item-price-breakdown">Labour ${fmt2(repairAmt)} + Part ${fmt2(sparePrice)}</div>`
        : '';

      const fruBreakdown = fru ? `
        <div class="fru-row">
          <span class="fru-cell"><span class="fru-label">D/P</span> ${fru.dp}×${fru.lev1} = ${fmt2(fru.dp_cost)}</span>
          <span class="fru-cell"><span class="fru-label">R</span> ${fru.r}×${fru.lev2} = ${fmt2(fru.r_cost)}</span>
          <span class="fru-cell"><span class="fru-label">P</span> ${fru.p}×${fru.lev1} = ${fmt2(fru.p_cost)}</span>
        </div>` : '';

      const modelLoaded = Object.keys(sparePartsMap).length > 0;
      const spareHint = canReplace
        ? `<div class="item-spare-hint ${dec==='replace'?'item-spare-active':''}">🔩 Spare part: ${fmt2(sparePrice)}</div>`
        : modelLoaded
          ? `<div class="item-spare-hint item-spare-na">Not in spare parts list</div>`
          : `<div class="item-spare-hint item-spare-na">Enter vehicle model to see spare part price</div>`;

      return `
        <div class="estimate-item sev-${item.severity} item-dec-${dec}" data-item-key="${itemKey}">
          <div class="item-left">
            <div class="item-part">${item.part}</div>
            <div class="item-meta">
              <span class="sev-tag">${item.severity}</span>
              ${window.Pricing.DAMAGE_LABELS?.[item.damageLevel]??item.damageLevel} ·
              ${window.Pricing.SIZE_LABELS?.[estimateSettings.vehicleSize]??estimateSettings.vehicleSize}
            </div>
            ${fruBreakdown}
            ${spareHint}
          </div>
          <div class="item-decision-col">
            <div class="item-action-group" role="group">
              <button class="action-btn action-repair${dec==='repair'?' action-active':''}"
                      onclick="setPartDecision('${itemKey}','repair')" data-action="repair">
                🔨 Repair
              </button>
              <button class="action-btn action-replace${dec==='replace'?' action-active':''}${!canReplace?' action-disabled':''}"
                      onclick="setPartDecision('${itemKey}','replace')" data-action="replace"
                      ${!canReplace?'disabled':''} title="${canReplace?'Replace with spare part':modelLoaded?'Not in spare parts list':'Enter vehicle model first'}">
                🔄 Replace
              </button>
              <button class="action-btn action-none${dec==='none'?' action-active':''}"
                      onclick="setPartDecision('${itemKey}','none')" data-action="none">
                ✕ None
              </button>
            </div>
            <div class="item-price-active" id="iprice-${itemKey.replace(/[^a-z0-9]/gi,'_')}">${activeAmt}</div>
            ${activeBreakdown}
            ${dec==='repair'&&item.forfait?`<div class="item-price-forfait">Forfait ${fmt2(item.forfait)}</div>`:''}
          </div>
        </div>`;
    }).join('');
  }

  // Initial totals (decision-aware)
  recalcEstimateTotals();

  const compRow = $('est-forfait-compare');
  if (compRow) {
    const manualForfaitSub = allItems.reduce((s,i) => s+(i.forfait??0), 0);
    const manualForfaitVat = Math.round(manualForfaitSub*0.15);
    const manualForfaitTot = manualForfaitSub+manualForfaitVat;
    if (manualForfaitTot) {
      compRow.innerHTML = `
        <div class="forfait-compare-row"><span>Forfait subtotal excl. VAT</span><span>${fmt2(manualForfaitSub)}</span></div>
        <div class="forfait-compare-row"><span>Forfait VAT 15%</span><span>${fmt2(manualForfaitVat)}</span></div>
        <div class="forfait-compare-row forfait-compare-total"><span>Total (Forfait)</span><span>${fmt2(manualForfaitTot)}</span></div>`;
      show('est-forfait-compare');
    } else { hide('est-forfait-compare'); }
  }

  const warn = $('unknown-parts-warn');
  if (warn) {
    warn.textContent = estimate.unknownParts.length?`No price found for: ${estimate.unknownParts.join(', ')}`:'';
    estimate.unknownParts.length?show('unknown-parts-warn'):hide('unknown-parts-warn');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART DECISIONS — repair / replace / none toggles
// ─────────────────────────────────────────────────────────────────────────────

function setPartDecision(itemKey, action) {
  partDecisions.set(itemKey, action);

  // Update button active classes for this row only (no full re-render)
  const itemEl = document.querySelector(`.estimate-item[data-item-key="${itemKey}"]`);
  if (itemEl) {
    itemEl.className = itemEl.className.replace(/item-dec-\w+/, `item-dec-${action}`);
    itemEl.querySelectorAll('.action-btn').forEach(btn => {
      btn.classList.toggle('action-active', btn.dataset.action === action);
    });

    // Update displayed price for this row
    const item      = _lastAllItems.find(i => `${i.partKey}__${i.damageType??''}` === itemKey);
    const priceEl   = itemEl.querySelector('.item-price-active');
    const hintEl    = itemEl.querySelector('.item-spare-hint');
    const fmt2      = window.Pricing?.formatMUR ?? (n => `Rs ${Number(n).toLocaleString('en-MU')}`);
    const sparePrice = item ? (sparePartsMap[item.partKey] ?? null) : null;

    if (priceEl && item) {
      const fruAmt = item.fru?.total ?? item.price ?? 0;
      if (action === 'none') {
        priceEl.innerHTML = '<span style="color:#94a3b8">—</span>';
      } else if (action === 'replace' && sparePrice !== null) {
        priceEl.innerHTML = fmt2(fruAmt + sparePrice);
      } else {
        priceEl.innerHTML = fmt2(fruAmt);
      }
      // Update or remove the breakdown line
      let breakdownEl = itemEl.querySelector('.item-price-breakdown');
      if (action === 'replace' && sparePrice !== null) {
        if (!breakdownEl) {
          breakdownEl = document.createElement('div');
          breakdownEl.className = 'item-price-breakdown';
          priceEl.insertAdjacentElement('afterend', breakdownEl);
        }
        breakdownEl.textContent = `Labour ${fmt2(fruAmt)} + Part ${fmt2(sparePrice)}`;
      } else if (breakdownEl) {
        breakdownEl.remove();
      }
    }
    if (hintEl) hintEl.classList.toggle('item-spare-active', action === 'replace');
  }

  recalcEstimateTotals();
}

function recalcEstimateTotals() {
  const fmt2 = window.Pricing?.formatMUR ?? (n => `Rs ${Number(n).toLocaleString('en-MU')}`);
  const VAT  = 0.15;

  let repairSubtotal  = 0;
  let replaceSubtotal = 0;

  _lastAllItems.forEach(item => {
    const itemKey    = `${item.partKey}__${item.damageType??''}`;
    const dec        = partDecisions.get(itemKey) ?? 'repair';
    const sparePrice = sparePartsMap[item.partKey] ?? null;
    const fruCost    = item.fru?.total ?? item.price ?? 0;
    if (dec === 'repair' || dec === 'replace') repairSubtotal  += fruCost;
    if (dec === 'replace' && sparePrice !== null) replaceSubtotal += sparePrice;
  });

  const subtotal = repairSubtotal + replaceSubtotal;
  const vat      = Math.round(subtotal * VAT);
  const total    = subtotal + vat;

  setText('est-subtotal', fmt2(subtotal));
  setText('est-vat',      fmt2(vat));
  setText('est-total',    fmt2(total));

  // Update breakdown labels if elements exist
  const repEl = $('est-repair-sub');  if (repEl)  repEl.textContent = fmt2(repairSubtotal);
  const parEl = $('est-replace-sub'); if (parEl)  parEl.textContent = fmt2(replaceSubtotal);

  checkTotalLoss(subtotal);  // re-evaluate total loss with current grand total
}

async function checkTotalLoss(repairSubtotal) {
  const panel = $('total-loss-panel'); if (!panel) return;
  const modelInput = $('vehicle-model')?.value?.trim()||'';
  const yearInput  = parseInt($('vehicle-year-input')?.value);
  const yearVig    = vehicleInfo?.year?parseInt(vehicleInfo.year):NaN;
  const yearMan    = parseInt($('vf-year')?.value);
  const year = (!isNaN(yearInput)&&yearInput>2000)?yearInput:(!isNaN(yearVig)&&yearVig>2000)?yearVig:(!isNaN(yearMan)&&yearMan>2000)?yearMan:null;
  if (!modelInput||!year||!repairSubtotal) { hide('total-loss-panel'); return; }
  const tokens = modelInput.trim().split(' ').filter(Boolean);
  const model  = tokens[0].toLowerCase()==='kia'?(tokens[1]??tokens[0]):tokens[0];
  try {
    const params = new URLSearchParams({ model, vehicle_year:year, repair_estimate:repairSubtotal });
    const res  = await fetch(`${API_URL}/total-loss?${params}`);
    const data = await res.json();
    if (!res.ok||data.decision==='UNKNOWN'||data.success===false) { hide('total-loss-panel'); return; }
    renderTotalLoss(data); show('total-loss-panel');
  } catch (e) { hide('total-loss-panel'); }
}

function onYearInput(val) { if (_lastMergedPipeline) refreshEstimate(); }

const REPLACEMENT_DAMAGE_TYPES = new Set(['broken_light','broken_glass','hole','tear']);

function buildSparePartsList(lineItems) {
  if (!lineItems?.length) return [];
  return lineItems.filter(item => item.severity==='severe'||REPLACEMENT_DAMAGE_TYPES.has((item.damageType??'').toLowerCase()))
    .map(item => ({ part:item.part, partKey:item.partKey, severity:item.severity??'minor',
      reason:item.severity==='severe'?'Severe damage — replacement required':`${item.damageType} — replacement required` }));
}

function renderTotalLoss(d) {
  const fmt2 = n => `Rs ${Number(n).toLocaleString('en-MU')}`;
  const isTL = d.is_total_loss;
  const panel = $('total-loss-panel');
  if (panel) panel.className = 'tl-card '+(isTL?'tl-card-loss':'tl-card-repair');
  $('tl-decision').textContent     = isTL?'Total Loss':'Repairable';
  $('tl-note').textContent         = d.decision_note;
  $('tl-showroom').textContent     = fmt2(d.showroom_price);
  $('tl-depreciation').textContent = `${d.age_years} yr${d.age_years!==1?'s':''} × 15% reducing balance`;
  $('tl-pav').textContent          = fmt2(d.pre_accident_value);
  $('tl-repair').textContent       = fmt2(d.repair_estimate);
  $('tl-threshold').textContent    = fmt2(d.threshold_amount);
  $('tl-pct').textContent          = d.repair_pct_of_pav+'%';
  $('tl-bar-fill').style.width     = Math.min(d.repair_pct_of_pav,100)+'%';
  $('tl-bar-fill').className       = 'tl-bar-fill '+(isTL?'tl-bar-loss':'tl-bar-repair');
  const estimate = _lastMergedPipeline?window.Pricing?.buildEstimate(_lastMergedPipeline,estimateSettings):null;
  const spares   = buildSparePartsList(estimate?.lineItems??[]);
  const sparesEl = $('tl-spare-parts');
  if (sparesEl) {
    if (spares.length) {
      sparesEl.innerHTML = spares.map(s => `
        <div class="tl-spare-item">
          <div class="tl-spare-icon sev-icon-${s.severity}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
          </div>
          <div class="tl-spare-info">
            <span class="tl-spare-name">${s.part}</span>
            <span class="tl-spare-reason">${s.reason}</span>
          </div>
          <span class="tl-spare-badge sev-bg-${s.severity}">${s.severity.toUpperCase()}</span>
        </div>`).join('');
      show('tl-spare-parts-section');
    } else { hide('tl-spare-parts-section'); }
  }
}

function switchList(type) {
  estimateSettings.listType = type;
  $('btn-client')?.classList.toggle('active',  type==='client');
  $('btn-interne')?.classList.toggle('active', type==='interne');
  refreshEstimate();
}

function onVehicleInput(value) {
  if (typeof window.Pricing==='undefined') return;
  const resolved = window.Pricing.resolveVehicle(value);
  estimateSettings.vehicleSize = resolved?.size??'medium';
  estimateSettings.labourTier  = resolved?.labourTier??'standard';
  updateSizeBadge(estimateSettings.vehicleSize);
  setText('vehicle-brand-detected', resolved?.brand?`✓ ${resolved.brand}`:'');
  // Fetch spare parts for the model portion of the input (last word)
  const modelSlug = value.trim().split(/\s+/).pop();
  if (modelSlug) fetchSparePartsForModel(modelSlug);
  refreshEstimate();
}

function updateSizeBadge(size) {
  const badge = $('size-badge'); if (!badge) return;
  badge.textContent = size==='large'?'Large':'Medium';
  badge.className   = `size-badge ${size}`;
}

function populateVehicleAutocomplete() {
  if (typeof window.Pricing==='undefined') return;
  const dl = $('vehicle-models-list'); if (!dl) return;
  dl.innerHTML = (window.Pricing.listAllModels?.()??[]).map(m => `<option value="${m.brand} ${m.name}">`).join('');
}


// SAVE INSPECTION

async function saveInspection() {
  const btn = $('save-btn'); const status = $('save-status');
  if (btn) btn.disabled=true;
  if (status) { status.textContent='Saving…'; status.className='save-status saving'; }
  try {
    const estimate      = _lastMergedPipeline?window.Pricing?.buildEstimate(_lastMergedPipeline,estimateSettings):null;
    const VAT           = 0.15;
    const filteredItems = (estimate?.lineItems??[]).filter(item => !manualRemovals.has(`${item.partKey}__${item.damageType??''}`));
    const manualPriced  = manualAdditions.map(a => {
      const dl = a.severity==='minor'?'leger':'moyen';
      const priced = window.Pricing?.lookupPrices?.(a.partKey,dl,estimateSettings.vehicleSize,estimateSettings.listType,estimateSettings.labourTier);
      if (!priced) return null;
      return { part:priced.partLabel, partKey:a.partKey, damageType:a.damageType, severity:a.severity, fru:priced.fru, forfait:priced.forfait, price:priced.fru?.total??0 };
    }).filter(Boolean);
    const seenManual = new Set(manualPriced.map(m => m.partKey));
    const allItems   = [...filteredItems.filter(i => !seenManual.has(i.partKey)),...manualPriced];

    let repairSub = 0, replaceSub = 0;
    allItems.forEach(i => {
      const itemKey    = `${i.partKey}__${i.damageType??''}`;
      const dec        = partDecisions.get(itemKey) ?? 'repair';
      const sparePrice = sparePartsMap[i.partKey] ?? null;
      const fruCost    = i.fru?.total ?? i.price ?? 0;
      if (dec === 'repair' || dec === 'replace') repairSub  += fruCost;
      if (dec === 'replace' && sparePrice !== null) replaceSub += sparePrice;
    });
    const subtotal = repairSub + replaceSub;
    const vat      = Math.round(subtotal*VAT);
    const total    = subtotal+vat;

    // Severity — check stage2 regions too
    const donePh = photoQueue.filter(e => e.status==='done'&&e.result);
    let worstSev = 'minor';
    for (const e of donePh) {
      if (SEV_RANK[e.result.stage1.severity.class]>SEV_RANK[worstSev]) worstSev=e.result.stage1.severity.class;
      for (const region of (e.result.stage2??[])) {
        const cls=region.severity?.class??'minor';
        if (SEV_RANK[cls]>SEV_RANK[worstSev]) worstSev=cls;
      }
    }

    let totalLossData = null;
    const tlPanel = $('total-loss-panel');
    if (tlPanel && tlPanel.style.display!=='none') {
      totalLossData = { decision:$('tl-decision')?.textContent??null, pre_accident_value:$('tl-pav')?.textContent??null, repair_estimate:$('tl-repair')?.textContent??null, threshold:$('tl-threshold')?.textContent??null, repair_pct_of_pav:$('tl-pct')?.textContent??null };
    }

    const payload = {
      vehicle: { make:vehicleInfo?.make??null, model:vehicleInfo?.model??$('vehicle-model')?.value?.trim()??null,
        year:(vehicleInfo?.year??parseInt($('vehicle-year-input')?.value))||null, vin:vehicleInfo?.vin??null,
        registration:vehicleInfo?.registration??null, size:estimateSettings.vehicleSize },
      severity: worstSev,
      estimate: { listType:estimateSettings.listType, vehicleSize:estimateSettings.vehicleSize, subtotal, vat, total,
        items: allItems.map(i => {
          const itemKey    = `${i.partKey}__${i.damageType??''}`;
          const dec        = partDecisions.get(itemKey) ?? 'repair';
          const sparePrice = sparePartsMap[i.partKey] ?? null;
          return { part:i.part, partKey:i.partKey, damageType:i.damageType??'',
            severity:i.severity, damageLevel:i.damageLevel??'',
            fru_total:i.fru?.total??i.price??0, forfait:i.forfait??null,
            decision:dec,
            spare_part_price: dec==='replace' ? sparePrice : null,
            line_total: dec==='none' ? 0 : dec==='replace' && sparePrice ? (i.fru?.total??i.price??0) + sparePrice : (i.fru?.total??i.price??0),
            manual:i.manual??false };
        })
      },
      total_loss: totalLossData,
    };

    const res  = await fetch(`${API_URL}/inspections`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    if (status) { status.textContent=`Saved — ID: ${data.id}`; status.className='save-status saved'; }
    if (btn)    { btn.classList.add('saved'); btn.textContent='✓ Saved'; }
  } catch (err) {
    if (status) { status.textContent=`Save failed: ${err.message}`; status.className='save-status error'; }
    if (btn)    { btn.disabled=false; }
  }
}



function reset() {
  photoQueue=[]; nextPhotoId=1; _lastMergedPipeline=null;
  $('file-in').value=''; $('cam-in').value='';
  hide('photo-queue'); hide('add-more-btn'); hide('combined-results'); hide('reset-btn');
  show('drop-zone'); show('upload-btn'); show('cam-btn');
  clearCombinedResults();
}

function clearCombinedResults() {
  manualAdditions=[]; manualRemovals=new Set(); severityOverrides=new Map();
  partDecisions=new Map(); sparePartsMap={}; _lastAllItems=[];
  hide('manual-damage-section'); hide('add-damage-form'); hide('save-section'); hide('total-loss-panel');
  ['severity-badge','prob-bars','damage-section','parts-section','error-box',
   'estimate-settings','estimate-section','unknown-parts-warn','est-forfait-compare'].forEach(hide);
  setText('damage-list',''); setText('parts-list','');
  const qg=$('queue-grid'); if(qg) qg.innerHTML='';
}

// IMAGE RESIZE


function resizeImage(file, maxDim) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      if (width<=maxDim && height<=maxDim) { resolve(file); return; }
      const scale = maxDim/Math.max(width,height);
      const w=Math.round(width*scale), h=Math.round(height*scale);
      const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      canvas.toBlob(blob => resolve(new File([blob],file.name,{type:'image/jpeg'})),'image/jpeg',0.85);
    };
    img.src=URL.createObjectURL(file);
  });
}


// ERROR / HISTORY


function showError(msg) { const el=$('error-box'); if(el){el.textContent=msg;show('error-box');} }
function hideError()    { hide('error-box'); }

async function loadHistory() {
  const panel=$('history-list'); if(!panel) return;
  panel.innerHTML='<p class="hist-loading">Loading…</p>';
  try {
    const res  = await fetch(`${API_URL}/inspections?limit=50`);
    const data = await res.json();
    if (!data.length) { panel.innerHTML='<p class="hist-loading">No saved inspections yet.</p>'; return; }
    panel.innerHTML = data.map(insp => {
      const v=insp.vehicle??{};
      const date=insp.created_at?new Date(insp.created_at).toLocaleDateString('en-MU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
      const sev=insp.severity??'minor';
      const total=insp.total?`Rs ${Number(insp.total).toLocaleString('en-MU')}`:'—';
      const vehicle=[v.make,v.model,v.year].filter(Boolean).join(' ')||'Unknown vehicle';
      const decision=insp.decision?`<span class="hist-decision ${insp.decision==='Total Loss'?'hist-loss':'hist-repair'}">${insp.decision}</span>`:'';
      return `
        <div class="history-row" onclick="viewInspection('${insp.id}')">
          <div class="hist-left">
            <div class="hist-vehicle">${vehicle}</div>
            <div class="hist-meta">${date} · ID: ${insp.id}</div>
          </div>
          <div class="hist-right">${decision}<span class="hist-sev sev-${sev}">${sev.toUpperCase()}</span><span class="hist-total">${total}</span></div>
        </div>`;
    }).join('');
  } catch (err) { panel.innerHTML=`<p class="hist-loading" style="color:var(--danger)">Failed: ${err.message}</p>`; }
}

async function viewInspection(id) {
  try {
    const res=await fetch(`${API_URL}/inspections/${id}`);
    if (!res.ok) throw new Error('Not found');
    const d=await res.json(); const v=d.vehicle??{}; const est=d.estimate??{};
    const fmt2=n=>n!=null?`Rs ${Number(n).toLocaleString('en-MU')}`:'—';
    const date=d.created_at?new Date(d.created_at).toLocaleDateString('en-MU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
    const items=(est.items??[]).map(i=>`
      <tr>
        <td>${i.part}</td><td>${i.damageType||'—'}</td>
        <td><span class="hist-sev sev-${i.severity}" style="font-size:0.7rem">${(i.severity??'').toUpperCase()}</span></td>
        <td style="text-align:right;font-weight:700;color:var(--navy)">${fmt2(i.fru_total)}</td>
        ${i.manual?'<td><span class="manual-tag">Manual</span></td>':'<td></td>'}
      </tr>`).join('');
    const tl=d.total_loss;
    const tlBlock=tl?`
      <div class="insp-detail-section">
        <p class="insp-detail-label">Economic Loss</p>
        <div class="insp-tl-verdict ${tl.decision==='Total Loss'?'tl-loss-text':'tl-repair-text'}">${tl.decision}</div>
        <div class="insp-tl-row"><span>Pre-accident value</span><span>${tl.pre_accident_value}</span></div>
        <div class="insp-tl-row"><span>Repair estimate</span><span>${tl.repair_estimate}</span></div>
        <div class="insp-tl-row"><span>Repair as % of PAV</span><span>${tl.repair_pct_of_pav}</span></div>
      </div>`:'';
    const existing=document.getElementById('insp-modal'); if(existing) existing.remove();
    const modal=document.createElement('div'); modal.id='insp-modal'; modal.className='insp-modal-overlay';
    modal.innerHTML=`
      <div class="insp-modal">
        <div class="insp-modal-head">
          <div>
            <div class="insp-modal-title">${[v.make,v.model,v.year].filter(Boolean).join(' ')||'Unknown vehicle'}</div>
            <div class="insp-modal-meta">${date} · ID: ${d.id} · <span class="hist-sev sev-${d.severity}" style="font-size:0.72rem">${(d.severity??'').toUpperCase()}</span></div>
          </div>
          <button class="insp-modal-close" onclick="document.getElementById('insp-modal').remove()">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>
          </button>
        </div>
        <div class="insp-modal-body">
          <div class="insp-detail-section">
            <p class="insp-detail-label">Vehicle</p>
            <div class="insp-detail-grid">
              <span>Make / Model</span><span>${[v.make,v.model].filter(Boolean).join(' ')||'—'}</span>
              <span>Year</span><span>${v.year??'—'}</span>
              <span>VIN</span><span>${v.vin??'—'}</span>
              <span>Registration</span><span>${v.registration??'—'}</span>
              <span>Size</span><span>${v.size??'—'}</span>
            </div>
          </div>
          <div class="insp-detail-section">
            <p class="insp-detail-label">Repair Estimate — ${est.listType?.toUpperCase()??''}</p>
            <table class="insp-items-table">
              <thead><tr><th>Part</th><th>Type</th><th>Severity</th><th style="text-align:right">Amount</th><th></th></tr></thead>
              <tbody>${items}</tbody>
            </table>
            <div class="insp-totals">
              <div class="insp-total-row"><span>Subtotal excl. VAT</span><span>${fmt2(est.subtotal)}</span></div>
              <div class="insp-total-row"><span>VAT 15%</span><span>${fmt2(est.vat)}</span></div>
              <div class="insp-total-row insp-grand-total"><span>Total (FRU)</span><span>${fmt2(est.total)}</span></div>
            </div>
          </div>
          ${tlBlock}
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  } catch(err) { alert(`Could not load inspection: ${err.message}`); }
}


// UTILS

const $       = id  => document.getElementById(id);
const setText = (id, val) => { const el=$(id); if(el) el.textContent=val; };
const show    = id  => { const el=$(id); if(el) el.style.display='block'; };
const hide    = id  => { const el=$(id); if(el) el.style.display='none';  };
const fmt     = str => str?str.replace(/[_-]/g,' ').toUpperCase():'';