// ── CONFIG ────────────────────────────────────────────────────────────────────
const hostname = location.hostname || '192.168.100.65';
const API_URL  = (hostname === 'localhost' || hostname === '127.0.0.1')
  ? 'http://127.0.0.1:8000'
  : `http://${hostname}:8000`;

const MAX_DIM    = 640;
const TIMEOUT_MS = 180_000;

// ── STATE ─────────────────────────────────────────────────────────────────────
let vehicleInfo      = null;   // from vignette scan
let estimateSettings = { listType: 'client', vehicleSize: 'medium', labourTier: 'standard' };

// Manual damage overrides — additions and removals applied on top of AI results
// Each entry: { id, partKey, partLabel, damageType, severity, manual: true }
let manualAdditions = [];
// Set of partKey__damageType combos removed by user
let manualRemovals  = new Set();

// Photo queue — each entry:
// { id, file, previewUrl, status: 'pending'|'analysing'|'done'|'error', result, error }
let photoQueue = [];
let nextPhotoId = 1;

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Vignette
  $('vig-input')?.addEventListener('change', e => e.target.files[0] && scanVignette(e.target.files[0]));
  $('vig-btn')?.addEventListener('click',  () => $('vig-input')?.click());
  $('vig-skip')?.addEventListener('click', skipVignette);

  // File inputs for photo queue
  $('file-in').addEventListener('change',  e => { if (e.target.files.length) addFiles(e.target.files); });
  $('cam-in').addEventListener('change',   e => { if (e.target.files[0]) addFiles(e.target.files); });
  $('upload-btn').addEventListener('click', () => $('file-in').click());
  $('cam-btn').addEventListener('click',    () => $('cam-in').click());

  // Add more button (shown after first photo)
  $('add-more-btn')?.addEventListener('click', () => $('file-in').click());

  // Drag and drop
  const dz = $('drop-zone');
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // Reset
  $('reset-btn').addEventListener('click', reset);

  // Estimate controls
  $('btn-client')?.addEventListener('click',  () => switchList('client'));
  $('btn-interne')?.addEventListener('click', () => switchList('interne'));
  $('vehicle-model')?.addEventListener('input', e => onVehicleInput(e.target.value));

  // Tabs
  $('history-tab')?.addEventListener('click', () => { show('history-panel'); hide('main-panel'); loadHistory(); });
  $('main-tab')?.addEventListener('click',    () => { show('main-panel'); hide('history-panel'); });

  // Pricing module loads async — wait for it before populating autocomplete
  if (typeof window.Pricing !== 'undefined') {
    populateVehicleAutocomplete();
  } else {
    window.addEventListener('pricing-ready', populateVehicleAutocomplete, { once: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — VIGNETTE
// ─────────────────────────────────────────────────────────────────────────────
async function scanVignette(file) {
  setVigLoading(true);
  hideError();

  try {
    const fd  = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API_URL}/scan-vignette`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    vehicleInfo = data;

    const hasData = data.make || data.model || data.policy_no || data.registration;
    if (hasData) {
      applyVehicleInfo(data);
      renderVignetteCard(data);
    } else {
      // OCR succeeded but extracted nothing useful — show manual fallback
      showVignetteFallback('Could not read vehicle details from the vignette.');
    }
  } catch (err) {
    showVignetteFallback('Vignette scan failed. Please enter vehicle details manually.');
  } finally {
    setVigLoading(false);
  }
}

function skipVignette() {
  vehicleInfo = null;
  showVignetteFallback(null);   // show manual entry, not an error
}

// ─────────────────────────────────────────────────────────────────────────────
// VIGNETTE FALLBACK — VIN decode or manual make/model/year entry
// ─────────────────────────────────────────────────────────────────────────────

function showVignetteFallback(errorMsg) {
  // Show the static HTML fallback panel, set error message if any
  const errEl = $('vf-error-msg');
  if (errEl) {
    errEl.textContent = errorMsg ?? '';
    errEl.style.display = errorMsg ? 'block' : 'none';
  }
  // Populate make dropdown — wait for Pricing if not ready yet
  const populateMakes = () => {
    const makeEl = $('vf-make');
    if (!makeEl || makeEl.options.length > 1) return;
    const models = window.Pricing?.listAllModels?.() ?? [];
    const makes  = [...new Set(models.map(m => m.brand))];
    makes.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      makeEl.appendChild(opt);
    });
  };
  if (typeof window.Pricing !== 'undefined') {
    populateMakes();
  } else {
    window.addEventListener('pricing-ready', populateMakes, { once: true });
  }
  // Reset to VIN tab
  switchVigTab('vin');
  const vinInput = $('vf-vin-input');
  if (vinInput) vinInput.value = '';
  hide('vf-vin-result');

  show('vig-fallback');
  hide('vig-step');
  show('damage-step');
}

function switchVigTab(tab) {
  ['vin', 'manual'].forEach(t => {
    $('vf-tab-' + t)?.classList.toggle('active', t === tab);
    const panel = $('vf-' + t + '-panel');
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
  });
}

function onMakeChange(make) {
  const modelSel = $('vf-model');
  if (!modelSel) return;
  const models = window.Pricing?.listAllModels?.() ?? [];
  const list   = models.filter(m => m.brand === make);
  modelSel.innerHTML = '<option value="">Select model\u2026</option>' +
    list.map(m => '<option value="' + m.name + '">' +
      m.name.charAt(0).toUpperCase() + m.name.slice(1) + '</option>').join('');
  modelSel.disabled = list.length === 0;
}


async function decodeVIN() {
  const input = $('vf-vin-input');
  // Send raw input to backend — it handles spaces, dashes, OCR corrections
  const vin = input?.value?.trim().toUpperCase();
  const res = $('vf-vin-result');

  const stripped = vin?.replace(/[^A-Z0-9]/g, '') ?? '';
  if (stripped.length < 6) {
    if (res) {
      res.textContent = 'Enter at least 6 characters of the VIN.';
      res.style.display = 'block';
      res.className = 'vig-fallback-decoded error';
    }
    return;
  }

  // Show loading state
  if (res) { res.textContent = 'Decoding…'; res.style.display = 'block'; res.className = 'vig-fallback-decoded'; }

  try {
    const resp = await fetch(`${API_URL}/decode-vin?vin=${encodeURIComponent(vin)}`);
    const data = await resp.json();

    if (data.success && (data.make || data.model)) {
      const label = [data.make, data.model, data.year].filter(Boolean).join(' ');
      if (res) {
        res.innerHTML = `
          <span class="vig-decoded-vehicle">${label}</span>
          <button class="vig-decoded-confirm" id="vin-use-btn">Use this vehicle</button>`;
        res.className = 'vig-fallback-decoded success';
        // Attach handler directly — avoids inline onclick with complex JSON args
        const btn = document.getElementById('vin-use-btn');
        if (btn) btn.addEventListener('click', () => completeVigFallback({
          make:  data.make,
          model: data.model,
          year:  data.year ?? null,
          vin:   data.vin,
        }));
      }
    } else {
      if (res) {
        res.textContent = data.error ?? 'Could not decode this VIN. Try the manual entry tab.';
        res.className = 'vig-fallback-decoded error';
      }
    }
  } catch (err) {
    if (res) {
      res.textContent = `Decode failed: ${err.message}`;
      res.className = 'vig-fallback-decoded error';
    }
  }
}

function applyManualEntry() {
  const make  = $('vf-make')?.value?.trim();
  const model = $('vf-model')?.value?.trim();
  const year  = parseInt($('vf-year')?.value) || null;
  if (!make || !model) {
    alert('Please select a make and model.');
    return;
  }
  completeVigFallback({ make, model, year, vin: null });
}

function completeVigFallback(data) {
  hide('vig-fallback');
  if (data) {
    applyVehicleInfo({
      make:         data.make,
      model:        data.model,
      year:         data.year,
      vin:          data.vin,
      vehicle_size: window.Pricing?.resolveVehicle((data.make + ' ' + data.model))?.size ?? 'medium',
    });
    // Populate the static vig-confirm card and show it
    const size = window.Pricing?.resolveVehicle((data.make + ' ' + data.model))?.size ?? 'medium';
    setText('vc-vehicle', (data.make ?? '') + ' ' + (data.model ?? '') + (data.year ? ' ' + data.year : ''));
    const sizeTag = $('vc-size-tag');
    if (sizeTag) { sizeTag.textContent = size.toUpperCase(); sizeTag.className = 'vig-size-tag ' + size; }
    setText('vc-vin', data.vin ?? '');
    $('vc-vin-wrap') && ($('vc-vin-wrap').style.display = data.vin ? 'block' : 'none');
    show('vig-confirm');
  }
  show('damage-step');
}

function applyVehicleInfo(data) {
  if (data.vehicle_size) {
    estimateSettings.vehicleSize = data.vehicle_size;
    updateSizeBadge(data.vehicle_size);
  }
  // Auto-fill the year input in estimate settings
  if (data.year) {
    const yearEl = $('vehicle-year-input');
    if (yearEl && !yearEl.value) yearEl.value = data.year;
  }
  const modelInput = $('vehicle-model');
  if (modelInput && data.make && data.model) {
    const modelStr = `${data.make} ${data.model}`;
    modelInput.value = modelStr;
    setText('vehicle-brand-detected', `✓ ${data.make}`);
    const resolved = window.Pricing?.resolveVehicle(modelStr);
    if (resolved?.labourTier) estimateSettings.labourTier = resolved.labourTier;
  }
}

function renderVignetteCard(data) {
  const card = $('vig-result');
  if (!card) return;
  const year = data.year  ? ` ${data.year}`  : '';
  const vin  = data.vin   ? `<div class="vig-vin">VIN: ${data.vin}</div>` : '';
  const exp  = data.expiry_date ? `<div class="vig-exp">Expiry: ${data.expiry_date}</div>` : '';
  card.innerHTML = `
    <div class="vig-card">
      <div class="vig-vehicle">${data.make ?? '?'} ${data.model ?? '?'}${year}</div>
      <div class="vig-meta">
        <span class="vig-size-tag ${data.vehicle_size ?? 'medium'}">${(data.vehicle_size ?? 'medium').toUpperCase()}</span>
        ${data.insurer      ? `<span class="vig-tag">${data.insurer}</span>` : ''}
        ${data.registration ? `<span class="vig-tag">${data.registration}</span>` : ''}
      </div>
      ${vin}${exp}
    </div>`;
  show('vig-result');
  hide('vig-step');
  show('damage-step');
}

function setVigLoading(on) {
  const btn = $('vig-btn');
  if (btn) btn.disabled = on;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — PHOTO QUEUE
// ─────────────────────────────────────────────────────────────────────────────

function addFiles(fileList) {
  Array.from(fileList).forEach(file => {
    const entry = {
      id:         nextPhotoId++,
      file,
      previewUrl: URL.createObjectURL(file),
      status:     'pending',
      result:     null,
      error:      null,
    };
    photoQueue.push(entry);
  });

  // Reset file inputs so same file can be re-added
  $('file-in').value = '';
  $('cam-in').value  = '';

  hide('drop-zone');
  hide('upload-btn');
  hide('cam-btn');
  show('photo-queue');
  show('add-more-btn');
  show('reset-btn');

  renderQueue();
  processQueue();
}

function renderQueue() {
  const container = $('queue-grid');
  if (!container) return;

  container.innerHTML = photoQueue.map(entry => `
    <div class="q-thumb" id="qt-${entry.id}">
      <div class="q-img-wrap">
        <img src="${entry.previewUrl}" alt="photo ${entry.id}" />
        <div class="q-overlay status-${entry.status}">
          ${entry.status === 'analysing' ? '<div class="q-spinner"></div>' : ''}
          ${entry.status === 'done'      ? '<div class="q-check"></div>'   : ''}
          ${entry.status === 'error'     ? '<div class="q-err-icon"></div>': ''}
        </div>
      </div>
      <div class="q-label">
        ${entry.status === 'pending'   ? 'Pending'   : ''}
        ${entry.status === 'analysing' ? 'Analysing' : ''}
        ${entry.status === 'done'      ? entry.result?.stage1?.severity?.class?.toUpperCase() ?? 'Done' : ''}
        ${entry.status === 'error'     ? 'Error'     : ''}
      </div>
      <button class="q-remove" onclick="removePhoto(${entry.id})" title="Remove">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
        </svg>
      </button>
    </div>`).join('');
}

function updateThumb(id) {
  const entry = photoQueue.find(e => e.id === id);
  if (!entry) return;
  const el = $(`qt-${id}`);
  if (!el) return;

  const overlay = el.querySelector('.q-overlay');
  const label   = el.querySelector('.q-label');

  if (overlay) {
    overlay.className = `q-overlay status-${entry.status}`;
    overlay.innerHTML =
      entry.status === 'analysing' ? '<div class="q-spinner"></div>'  :
      entry.status === 'done'      ? '<div class="q-check"></div>'    :
      entry.status === 'error'     ? '<div class="q-err-icon"></div>' : '';
  }
  if (label) {
    label.textContent =
      entry.status === 'pending'   ? 'Pending'   :
      entry.status === 'analysing' ? 'Analysing' :
      entry.status === 'done'      ? (entry.result?.stage1?.severity?.class?.toUpperCase() ?? 'Done') :
      entry.status === 'error'     ? 'Error'      : '';
  }
}

async function processQueue() {
  // Process all pending entries concurrently (max 2 at a time)
  const pending = photoQueue.filter(e => e.status === 'pending');
  const chunks  = [];
  for (let i = 0; i < pending.length; i += 2) chunks.push(pending.slice(i, i + 2));

  for (const chunk of chunks) {
    await Promise.all(chunk.map(entry => analysePhoto(entry)));
  }

  rebuildCombinedResults();
}

async function analysePhoto(entry) {
  entry.status = 'analysing';
  updateThumb(entry.id);

  try {
    const resized = await resizeImage(entry.file, MAX_DIM);
    const fd      = new FormData();
    fd.append('file', resized);

    const params = new URLSearchParams();
    if (vehicleInfo?.success) params.set('vehicle_data', JSON.stringify(vehicleInfo));

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${API_URL}/predict?${params}`, {
      method: 'POST', body: fd, signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail ?? `Server error ${res.status}`);
    }

    const data = await res.json();
    if (!data?.stage1?.severity) throw new Error('Unexpected response from server');

    entry.result = data;
    entry.status = 'done';
  } catch (err) {
    entry.error  = err.name === 'AbortError' ? 'Timed out' : err.message;
    entry.status = 'error';
  }

  updateThumb(entry.id);
}

function removePhoto(id) {
  photoQueue = photoQueue.filter(e => e.id !== id);
  if (photoQueue.length === 0) {
    reset();
    return;
  }
  renderQueue();
  rebuildCombinedResults();
}

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED RESULTS
// ─────────────────────────────────────────────────────────────────────────────

const SEV_RANK = { minor: 0, moderate: 1, severe: 2 };

function rebuildCombinedResults() {
  const done = photoQueue.filter(e => e.status === 'done' && e.result);
  if (!done.length) {
    hide('combined-results');
    return;
  }

  // ── Merge all stage2 detections across photos ─────────────────────────────
  // Key = partKey. Keep worst severity per part.
  const partMap  = new Map();  // partKey → best item
  const allParts = new Set();  // part names for chips

  for (const entry of done) {
    const { stage1, stage2 } = entry.result;
    const overallSev = stage1.severity.class;

    // Collect all parts detected in this photo
    for (const region of (stage2 ?? [])) {
      for (const part of (region.parts ?? [])) allParts.add(part.name);
      for (const dmg of (region.damages ?? [])) {
        if (dmg.on_part && dmg.on_part !== 'unknown') allParts.add(dmg.on_part);
      }
    }
  }

  // Build a synthetic merged pipeline result for estimate
  const merged = buildMergedPipeline(done);

  // ── Overall severity = worst across all photos ────────────────────────────
  let worstSev    = 'minor';
  let worstConf   = 0;
  let worstProbs  = { minor: 0, moderate: 0, severe: 0 };

  for (const entry of done) {
    const sev = entry.result.stage1.severity;
    if (SEV_RANK[sev.class] > SEV_RANK[worstSev]) {
      worstSev   = sev.class;
      worstConf  = sev.confidence;
      worstProbs = sev.probabilities;
    }
  }

  show('combined-results');

  // Severity badge
  renderSeverityBadge({ class: worstSev, confidence: worstConf, probabilities: worstProbs });

  // Parts affected (union of all photos)
  renderAllParts(allParts, merged);

  // Detections summary
  renderCombinedDetections(done);

  // Estimate
  renderEstimate(merged);
}

function buildMergedPipeline(doneEntries) {
  // Merge all stage2 regions from all photos.
  // Dedup rule: same on_part = same physical part.
  // Keep worst severity per part. Collect all damage types on that part.

  // Map: on_part → { worstSeverity, damages[], parts[], triggered_by }
  const partBuckets = new Map();

  for (const entry of doneEntries) {
    for (const region of (entry.result.stage2 ?? [])) {
      const regionSev = region.severity?.class ?? 'minor';

      for (const dmg of (region.damages ?? [])) {
        const partKey = dmg.on_part || 'unknown';
        if (partKey === 'unknown') continue;

        if (!partBuckets.has(partKey)) {
          partBuckets.set(partKey, {
            triggered_by: region.triggered_by,
            severity:     region.severity,
            damages:      [dmg],
            parts:        region.parts ?? [],
          });
        } else {
          const bucket = partBuckets.get(partKey);
          // Upgrade severity if this region is worse
          if (SEV_RANK[regionSev] > SEV_RANK[bucket.severity?.class ?? 'minor']) {
            bucket.severity     = region.severity;
            bucket.triggered_by = region.triggered_by;
          }
          // Add this damage only if same type not already present
          const alreadyHas = bucket.damages.some(d => d.type === dmg.type);
          if (!alreadyHas) bucket.damages.push(dmg);
          // Merge parts list
          for (const p of (region.parts ?? [])) {
            if (!bucket.parts.some(bp => bp.name === p.name)) bucket.parts.push(p);
          }
        }
      }
    }
  }

  // Convert buckets → allRegions (one region per unique part)
  const allRegions = [...partBuckets.values()];

  // Worst overall severity
  let worstSev = 'minor';
  for (const e of doneEntries) {
    if (SEV_RANK[e.result.stage1.severity.class] > SEV_RANK[worstSev]) {
      worstSev = e.result.stage1.severity.class;
    }
  }

  return {
    image_size: doneEntries[0].result.image_size,
    stage1: {
      severity: {
        class: worstSev,
        confidence: doneEntries.reduce((m, e) => Math.max(m, e.result.stage1.severity.confidence), 0),
        probabilities: { minor: 0, moderate: 0, severe: 0 },
      },
      detections: [],   // don't cross-match localised detections across photos
    },
    stage2: allRegions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER COMBINED RESULTS
// ─────────────────────────────────────────────────────────────────────────────

function renderSeverityBadge(sev) {
  const badge = $('severity-badge');
  if (!badge) return;
  badge.className = `sev-${sev.class}`;
  setText('sev-val',  sev.class.toUpperCase());
  setText('sev-conf', `${Math.round(sev.confidence * 100)}% confidence`);
  show('severity-badge');

  show('prob-bars');
  ['minor', 'moderate', 'severe'].forEach(c => {
    const pct = Math.round((sev.probabilities[c] ?? 0) * 100);
    const bar = $(`b-${c}`);
    if (bar) bar.style.width = pct + '%';
    setText(`p-${c}`, pct + '%');
  });
}

function renderAllParts(partNames, mergedPipeline) {
  const partsList = $('parts-list');
  if (!partsList) return;

  // Which parts have confirmed damage in estimate
  let damagedKeys = new Set();
  if (typeof window.Pricing !== 'undefined') {
    const est = window.Pricing.buildEstimate(mergedPipeline, estimateSettings);
    damagedKeys = new Set(est.lineItems.map(i => i.partKey));
  }

  partsList.innerHTML = [...partNames].map(name => {
    const key = window.Pricing?.resolvePartRegion?.(name) ?? name;
    const damaged = damagedKeys.has(key);
    return `<span class="part-chip ${damaged ? 'damaged' : ''}" data-part="${name}">${fmt(name)}</span>`;
  }).join('');

  show('parts-section');
}

function renderCombinedDetections(doneEntries) {
  const list = $('damage-list');
  if (!list) return;
  list.innerHTML = '';

  doneEntries.forEach((entry, photoIdx) => {
    // Photo header
    list.insertAdjacentHTML('beforeend', `
      <div class="photo-header">
        <img src="${entry.previewUrl}" class="photo-thumb-sm" />
        <span>Photo ${photoIdx + 1}</span>
        <span class="region-sev">${entry.result.stage1.severity.class.toUpperCase()}</span>
      </div>`);

    for (const region of (entry.result.stage2 ?? [])) {
      const sev = region.severity;
      list.insertAdjacentHTML('beforeend', `
        <div class="region-header sev-${sev.class}">
          <span class="region-title">${fmt(region.triggered_by?.type ?? '')}</span>
          <span class="region-sev">${sev.class.toUpperCase()}${sev.confidence >= 0.5 ? " · " + Math.round(sev.confidence * 100) + "%" : ""}</span>
        </div>`);

      if (region.damages?.length) {
        region.damages.forEach(d => {
          list.insertAdjacentHTML('beforeend', detectionCard(d, true));
        });
      }
    }
  });

  show('damage-section');
}

function detectionCard(d, detailed = false) {
  const part = d.on_part
    ? `<div class="dmg-part">${fmt(d.on_part)}${d.overlap_pct > 0 ? ` · ${d.overlap_pct}%` : ''}</div>`
    : '';
  // Per-damage severity badge
  const sev     = d.severity;
  const sevBadge = sev
    ? `<span class="dmg-sev-badge sev-bg-${sev.class}">${sev.class.toUpperCase()}${sev.confidence >= 0.5 ? " " + Math.round(sev.confidence * 100) + "%" : ""}</span>`
    : '';
  return `
    <div class="dmg-card ${detailed ? 'dmg-detailed' : ''}">
      <div class="dmg-left">
        <div class="dmg-type">${fmt(d.type)} ${sevBadge}</div>
        ${detailed ? part : ''}
      </div>
      <div class="dmg-conf-badge">${Math.round(d.conf * 100)}%</div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ESTIMATE
// ─────────────────────────────────────────────────────────────────────────────

function renderEstimate(mergedPipeline) {
  if (typeof window.Pricing === 'undefined') return;
  show('estimate-settings');
  show('estimate-section');
  show('manual-damage-section');
  show('save-section');
  // Reset save status when estimate changes
  setText('save-status', '');
  const btn = $('save-btn');
  if (btn) { btn.disabled = false; btn.classList.remove('saved'); }
  refreshEstimate(mergedPipeline);
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL DAMAGE EDITOR
// ─────────────────────────────────────────────────────────────────────────────

const PART_LABELS_MAP = {
  front_bumper: 'Front Bumper', rear_bumper: 'Rear Bumper',
  bonnet: 'Bonnet / Hood', front_fender: 'Front Fender',
  rear_fender: 'Rear Fender', front_door: 'Front Door',
  rear_door: 'Rear Door', trunk: 'Trunk / Boot',
  roof: 'Roof', sill: 'Sill / Rocker', mirror: 'Mirror',
  wheel_rim: 'Wheel Rim', spot_repair: 'Spot Repair',
  paint_touchup: 'Paint Touch-up',
};

function renderManualDamageList(aiLineItems) {
  const list = $('manual-damage-list');
  if (!list) return;

  // Combine AI items + manual additions, excluding removals
  const allItems = [
    ...(aiLineItems ?? []).map(item => ({
      id:         `ai__${item.partKey}__${item.damageType ?? ''}`,
      partKey:    item.partKey,
      partLabel:  item.part,
      damageType: item.damageType ?? '',
      severity:   item.severity,
      manual:     false,
    })),
    ...manualAdditions,
  ].filter(item => !manualRemovals.has(`${item.partKey}__${item.damageType}`));

  if (!allItems.length) {
    list.innerHTML = '<p class="manual-empty">No damage items yet. Add one below.</p>';
    return;
  }

  list.innerHTML = allItems.map(item => `
    <div class="manual-item ${item.manual ? 'manual-item-added' : ''}">
      <div class="manual-item-left">
        <span class="manual-item-part">${item.partLabel}</span>
        <span class="manual-item-meta">
          <span class="dmg-sev-badge sev-bg-${item.severity}">${item.severity.toUpperCase()}</span>
          ${fmt(item.damageType)}
          ${item.manual ? '<span class="manual-tag">Manual</span>' : ''}
        </span>
      </div>
      <button class="manual-remove-btn" onclick="removeDamageItem('${item.partKey}', '${item.damageType}', ${item.manual}, '${item.id}')"
              title="Remove this damage">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
        </svg>
      </button>
    </div>`).join('');
}

function removeDamageItem(partKey, damageType, isManual, id) {
  if (isManual) {
    manualAdditions = manualAdditions.filter(a => a.id !== id);
  } else {
    manualRemovals.add(`${partKey}__${damageType}`);
  }
  refreshEstimate();
}

function openAddDamage() {
  show('add-damage-form');
}

function cancelAddDamage() {
  hide('add-damage-form');
  $('add-part').value     = '';
  $('add-type').value     = 'dent';
  $('add-severity').value = 'moderate';
}

function confirmAddDamage() {
  const partKey   = $('add-part')?.value;
  const damageType= $('add-type')?.value  ?? 'dent';
  const severity  = $('add-severity')?.value ?? 'moderate';

  if (!partKey) { alert('Please select a part.'); return; }

  // Remove from removals if it was previously removed
  manualRemovals.delete(`${partKey}__${damageType}`);

  const id = `manual__${partKey}__${damageType}__${Date.now()}`;
  manualAdditions.push({
    id,
    partKey,
    partLabel:  PART_LABELS_MAP[partKey] ?? partKey,
    damageType,
    severity,
    manual:     true,
  });

  cancelAddDamage();
  refreshEstimate();
}

function refreshEstimate(mergedPipeline) {
  // Use stored merged pipeline or rebuild
  const pipeline = mergedPipeline ?? _lastMergedPipeline;
  if (!pipeline || typeof window.Pricing === 'undefined') return;
  _lastMergedPipeline = pipeline;

  const estimate = window.Pricing.buildEstimate(pipeline, estimateSettings);
  const fmt2     = window.Pricing.formatMUR;

  // Apply manual removals — filter out AI items the user removed
  const filteredItems = estimate.lineItems.filter(item => {
    const key = `${item.partKey}__${item.damageType ?? ''}`;
    return !manualRemovals.has(key);
  });

  // Apply manual additions — add user-added damage items
  const manualPriced = manualAdditions.map(a => {
    const damageLevel = a.severity === 'minor' ? 'leger' : 'moyen';
    const priced = window.Pricing.lookupPrices?.(
      a.partKey, damageLevel,
      estimateSettings.vehicleSize,
      estimateSettings.listType,
      estimateSettings.labourTier
    );
    if (!priced) return null;
    return {
      part:        priced.partLabel,
      partKey:     a.partKey,
      damageType:  a.damageType,
      severity:    a.severity,
      damageLevel,
      fru:         priced.fru,
      forfait:     priced.forfait,
      price:       priced.fru?.total ?? priced.forfait ?? 0,
      manual:      true,
    };
  }).filter(Boolean);

  // Combine: filtered AI items + manual additions (dedup by partKey)
  const seenManual = new Set(manualPriced.map(m => m.partKey));
  const allItems   = [
    ...filteredItems.filter(i => !seenManual.has(i.partKey)),
    ...manualPriced,
  ];

  // Render the manual damage list (for editing)
  renderManualDamageList(estimate.lineItems);

  const tierLabel = estimateSettings.labourTier === 'ev' ? ' · EV/Hybrid' : '';
  setText('estimate-list-label',
    (window.Pricing.LIST_LABELS?.[estimateSettings.listType] ?? estimateSettings.listType) + tierLabel);

  const container = $('estimate-items');
  if (!container) return;

  // Recalculate totals from allItems (includes manual adds/removes)
  const VAT = 0.15;
  const manualSubtotal   = allItems.reduce((s, i) => s + (i.fru?.total ?? i.price ?? 0), 0);
  const manualVat        = Math.round(manualSubtotal * VAT);
  const manualTotal      = manualSubtotal + manualVat;
  const manualForfaitSub = allItems.reduce((s, i) => s + (i.forfait ?? 0), 0);
  const manualForfaitVat = Math.round(manualForfaitSub * VAT);
  const manualForfaitTot = manualForfaitSub + manualForfaitVat;

  if (!allItems.length) {
    container.innerHTML = `<div class="no-items">No parts matched in price list.
      ${estimate.unknownParts.length ? `<br><small>${estimate.unknownParts.join(', ')}</small>` : ''}</div>`;
  } else {
    container.innerHTML = allItems.map(item => {
      const fru = item.fru;
      const fruBreakdown = fru ? `
        <div class="fru-row">
          <span class="fru-cell"><span class="fru-label">D/P</span> ${fru.dp}×${fru.lev1} = ${fmt2(fru.dp_cost)}</span>
          <span class="fru-cell"><span class="fru-label">R</span> ${fru.r}×${fru.lev2} = ${fmt2(fru.r_cost)}</span>
          <span class="fru-cell"><span class="fru-label">P</span> ${fru.p}×${fru.lev1} = ${fmt2(fru.p_cost)}</span>
        </div>` : '';
      return `
        <div class="estimate-item sev-${item.severity}">
          <div class="item-left">
            <div class="item-part">${item.part}</div>
            <div class="item-meta">
              <span class="sev-tag">${item.severity}</span>
              ${window.Pricing.DAMAGE_LABELS?.[item.damageLevel] ?? item.damageLevel} ·
              ${window.Pricing.SIZE_LABELS?.[estimateSettings.vehicleSize] ?? estimateSettings.vehicleSize}
            </div>
            ${fruBreakdown}
          </div>
          <div class="item-prices">
            <div class="item-price-fru">${fmt2(item.fru?.total ?? item.price)}</div>
            ${item.forfait ? `<div class="item-price-forfait">Forfait ${fmt2(item.forfait)}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  // FRU totals — use manually adjusted totals
  setText('est-subtotal', fmt2(manualSubtotal));
  setText('est-vat',      fmt2(manualVat));
  setText('est-total',    fmt2(manualTotal));

  // Forfait comparison totals
  const compRow = $('est-forfait-compare');
  if (compRow) {
    if (estimate.forfaitTotal) {
      compRow.innerHTML = `
        <div class="forfait-compare-row">
          <span>Forfait subtotal excl. VAT</span><span>${fmt2(estimate.forfaitSubtotal)}</span>
        </div>
        <div class="forfait-compare-row">
          <span>Forfait VAT 15%</span><span>${fmt2(estimate.forfaitVat)}</span>
        </div>
        <div class="forfait-compare-row forfait-compare-total">
          <span>Total (Forfait)</span><span>${fmt2(estimate.forfaitTotal)}</span>
        </div>`;
      show('est-forfait-compare');
    } else {
      hide('est-forfait-compare');
    }
  }

  const warn = $('unknown-parts-warn');
  if (warn) {
    warn.textContent = estimate.unknownParts.length
      ? `No price found for: ${estimate.unknownParts.join(', ')}` : '';
    estimate.unknownParts.length ? show('unknown-parts-warn') : hide('unknown-parts-warn');
  }

  // Total loss check — only if we have vehicle year
  checkTotalLoss(estimate.subtotal);
}

async function checkTotalLoss(repairSubtotal) {
  const panel = $('total-loss-panel');
  if (!panel) return;

  const modelInput = $('vehicle-model')?.value?.trim() || '';

  // Year — try all sources
  const yearInput = parseInt($('vehicle-year-input')?.value);
  const yearVig   = vehicleInfo?.year ? parseInt(vehicleInfo.year) : NaN;
  const yearMan   = parseInt($('vf-year')?.value);
  const year      = (!isNaN(yearInput) && yearInput > 2000) ? yearInput
                  : (!isNaN(yearVig)   && yearVig   > 2000) ? yearVig
                  : (!isNaN(yearMan)   && yearMan   > 2000) ? yearMan
                  : null;

  console.log('[TotalLoss] model=', modelInput, 'year=', year, 'repair=', repairSubtotal);

  if (!modelInput || !year || !repairSubtotal) {
    hide('total-loss-panel');
    return;
  }

  // Strip "Kia" prefix, take first remaining word as model
  const tokens = modelInput.trim().split(' ').filter(Boolean);
  const model  = tokens[0].toLowerCase() === 'kia'
    ? (tokens[1] ?? tokens[0])
    : tokens[0];

  try {
    const params = new URLSearchParams({
      model,
      vehicle_year:    year,
      repair_estimate: repairSubtotal,
    });
    console.log('[TotalLoss] fetching:', `${API_URL}/total-loss?${params}`);

    const res  = await fetch(`${API_URL}/total-loss?${params}`);
    const data = await res.json();
    console.log('[TotalLoss] result:', data);

    if (!res.ok || data.decision === 'UNKNOWN' || data.success === false) {
      console.warn('[TotalLoss] model not found:', data.error);
      hide('total-loss-panel');
      return;
    }

    renderTotalLoss(data);
    show('total-loss-panel');
  } catch (e) {
    console.warn('[TotalLoss] fetch failed:', e.message);
    hide('total-loss-panel');
  }
}

function onYearInput(val) {
  // Re-run total loss when year changes
  if (_lastMergedPipeline) refreshEstimate();
}

// Damage types that always require replacement regardless of severity
const REPLACEMENT_DAMAGE_TYPES = new Set([
  'broken_light', 'broken_glass', 'hole', 'tear',
]);

function buildSparePartsList(lineItems) {
  if (!lineItems?.length) return [];
  const spares = [];
  for (const item of lineItems) {
    const sev     = item.severity ?? 'minor';
    const dmgType = (item.damageType ?? '').toLowerCase();
    const needsReplacement =
      sev === 'severe' ||
      REPLACEMENT_DAMAGE_TYPES.has(dmgType);

    if (needsReplacement) {
      spares.push({
        part:      item.part,
        partKey:   item.partKey,
        severity:  sev,
        reason:    sev === 'severe' ? 'Severe damage — replacement required'
                 : `${dmgType} — replacement required`,
      });
    }
  }
  return spares;
}

function renderTotalLoss(d) {
  const fmt  = n => `Rs ${Number(n).toLocaleString('en-MU')}`;
  const pct  = d.repair_pct_of_pav;
  const isTL = d.is_total_loss;

  // Verdict badge + card colour
  const panel = $('total-loss-panel');
  if (panel) {
    panel.className = 'tl-card ' + (isTL ? 'tl-card-loss' : 'tl-card-repair');
  }
  $('tl-decision').textContent     = isTL ? 'Total Loss' : 'Repairable';
  $('tl-note').textContent         = d.decision_note;

  // Stats
  $('tl-showroom').textContent     = fmt(d.showroom_price);
  $('tl-depreciation').textContent = `${d.age_years} yr${d.age_years !== 1 ? 's' : ''} × 15% reducing balance`;
  $('tl-pav').textContent          = fmt(d.pre_accident_value);
  $('tl-repair').textContent       = fmt(d.repair_estimate);
  $('tl-threshold').textContent    = fmt(d.threshold_amount);

  // Bar
  $('tl-pct').textContent          = pct + '%';
  $('tl-bar-fill').style.width     = Math.min(pct, 100) + '%';
  $('tl-bar-fill').className       = 'tl-bar-fill ' + (isTL ? 'tl-bar-loss' : 'tl-bar-repair');

  // Spare parts
  const estimate = _lastMergedPipeline
    ? window.Pricing?.buildEstimate(_lastMergedPipeline, estimateSettings)
    : null;
  const spares   = buildSparePartsList(estimate?.lineItems ?? []);
  const sparesEl = $('tl-spare-parts');
  if (sparesEl) {
    if (spares.length) {
      sparesEl.innerHTML = spares.map(s => `
        <div class="tl-spare-item">
          <div class="tl-spare-icon sev-icon-${s.severity}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
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
    } else {
      hide('tl-spare-parts-section');
    }
  }
}

let _lastMergedPipeline = null;

function switchList(type) {
  estimateSettings.listType = type;
  $('btn-client')?.classList.toggle('active',  type === 'client');
  $('btn-interne')?.classList.toggle('active', type === 'interne');
  refreshEstimate();
}

function onVehicleInput(value) {
  if (typeof window.Pricing === 'undefined') return;
  const resolved = window.Pricing.resolveVehicle(value);
  const size     = resolved?.size       ?? 'medium';
  const tier     = resolved?.labourTier ?? 'standard';
  estimateSettings.vehicleSize = size;
  estimateSettings.labourTier  = tier;
  updateSizeBadge(size);
  setText('vehicle-brand-detected', resolved?.brand ? `✓ ${resolved.brand}` : '');
  refreshEstimate();
}

function updateSizeBadge(size) {
  const badge = $('size-badge');
  if (!badge) return;
  badge.textContent = size === 'large' ? 'Large' : 'Medium';
  badge.className   = `size-badge ${size}`;
}

function populateVehicleAutocomplete() {
  if (typeof window.Pricing === 'undefined') return;
  const dl = $('vehicle-models-list');
  if (!dl) return;
  dl.innerHTML = (window.Pricing.listAllModels?.() ?? [])
    .map(m => `<option value="${m.brand} ${m.name}">`).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// RESET
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SAVE INSPECTION
// ─────────────────────────────────────────────────────────────────────────────

async function saveInspection() {
  const btn = $('save-btn');
  const status = $('save-status');
  if (btn) btn.disabled = true;
  if (status) { status.textContent = 'Saving…'; status.className = 'save-status saving'; }

  try {
    // Build payload from current state
    const estimate = _lastMergedPipeline
      ? window.Pricing?.buildEstimate(_lastMergedPipeline, estimateSettings)
      : null;

    // Apply manual overrides to get the actual displayed totals
    const VAT = 0.15;
    const filteredItems = (estimate?.lineItems ?? []).filter(item =>
      !manualRemovals.has(`${item.partKey}__${item.damageType ?? ''}`)
    );
    const manualPriced = manualAdditions.map(a => {
      const damageLevel = a.severity === 'minor' ? 'leger' : 'moyen';
      const priced = window.Pricing?.lookupPrices?.(
        a.partKey, damageLevel,
        estimateSettings.vehicleSize,
        estimateSettings.listType,
        estimateSettings.labourTier
      );
      if (!priced) return null;
      return { part: priced.partLabel, partKey: a.partKey,
               damageType: a.damageType, severity: a.severity,
               fru: priced.fru, forfait: priced.forfait,
               price: priced.fru?.total ?? 0 };
    }).filter(Boolean);

    const seenManual = new Set(manualPriced.map(m => m.partKey));
    const allItems   = [
      ...filteredItems.filter(i => !seenManual.has(i.partKey)),
      ...manualPriced,
    ];

    const subtotal = allItems.reduce((s, i) => s + (i.fru?.total ?? i.price ?? 0), 0);
    const vat      = Math.round(subtotal * VAT);
    const total    = subtotal + vat;

    // Overall severity
    const done      = photoQueue.filter(e => e.status === 'done' && e.result);
    const SEV_RANK  = { minor: 0, moderate: 1, severe: 2 };
    let worstSev    = 'minor';
    for (const e of done) {
      if (SEV_RANK[e.result.stage1.severity.class] > SEV_RANK[worstSev])
        worstSev = e.result.stage1.severity.class;
    }

    // Total loss data from last rendered panel
    let totalLossData = null;
    const tlPanel = $('total-loss-panel');
    if (tlPanel && tlPanel.style.display !== 'none') {
      totalLossData = {
        decision:           $('tl-decision')?.textContent ?? null,
        pre_accident_value: $('tl-pav')?.textContent ?? null,
        repair_estimate:    $('tl-repair')?.textContent ?? null,
        threshold:          $('tl-threshold')?.textContent ?? null,
        repair_pct_of_pav:  $('tl-pct')?.textContent ?? null,
      };
    }

    const payload = {
      vehicle: {
        make:         vehicleInfo?.make ?? null,
        model:        vehicleInfo?.model ?? $('vehicle-model')?.value?.trim() ?? null,
        year:         (vehicleInfo?.year ?? parseInt($('vehicle-year-input')?.value)) || null,
        vin:          vehicleInfo?.vin  ?? null,
        registration: vehicleInfo?.registration ?? null,
        size:         estimateSettings.vehicleSize,
      },
      severity:  worstSev,
      estimate: {
        listType:  estimateSettings.listType,
        vehicleSize: estimateSettings.vehicleSize,
        subtotal,
        vat,
        total,
        items: allItems.map(i => ({
          part:        i.part,
          partKey:     i.partKey,
          damageType:  i.damageType ?? '',
          severity:    i.severity,
          damageLevel: i.damageLevel ?? '',
          fru_total:   i.fru?.total ?? i.price ?? 0,
          forfait:     i.forfait ?? null,
          manual:      i.manual ?? false,
        })),
      },
      total_loss: totalLossData,
    };

    const res  = await fetch(`${API_URL}/inspections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();

    if (status) { status.textContent = `Saved — ID: ${data.id}`; status.className = 'save-status saved'; }
    if (btn)    { btn.classList.add('saved'); btn.textContent = '✓ Saved'; }

  } catch (err) {
    if (status) { status.textContent = `Save failed: ${err.message}`; status.className = 'save-status error'; }
    if (btn)    { btn.disabled = false; }
  }
}

function reset() {
  photoQueue          = [];
  nextPhotoId         = 1;
  _lastMergedPipeline = null;

  $('file-in').value = '';
  $('cam-in').value  = '';

  hide('photo-queue');
  hide('add-more-btn');
  hide('combined-results');
  hide('reset-btn');
  show('drop-zone');
  show('upload-btn');
  show('cam-btn');

  clearCombinedResults();
}

function clearCombinedResults() {
  // Reset manual damage overrides
  manualAdditions = [];
  manualRemovals  = new Set();
  hide('manual-damage-section');
  hide('add-damage-form');
  hide('save-section');
  hide('total-loss-panel');

  ['severity-badge','prob-bars','damage-section','parts-section',
   'error-box','estimate-settings','estimate-section','unknown-parts-warn',
   'est-forfait-compare',
  ].forEach(hide);
  setText('damage-list', '');
  setText('parts-list',  '');
  const qg = $('queue-grid');
  if (qg) qg.innerHTML = '';
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE RESIZE
// ─────────────────────────────────────────────────────────────────────────────

function resizeImage(file, maxDim) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      if (width <= maxDim && height <= maxDim) { resolve(file); return; }
      const scale = maxDim / Math.max(width, height);
      const w = Math.round(width * scale);
      const h = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        blob => resolve(new File([blob], file.name, { type: 'image/jpeg' })),
        'image/jpeg', 0.85,
      );
    };
    img.src = URL.createObjectURL(file);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ERROR
// ─────────────────────────────────────────────────────────────────────────────

function showError(msg) {
  const el = $('error-box');
  if (el) { el.textContent = msg; show('error-box'); }
}
function hideError() { hide('error-box'); }

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────────────────────────────────────────

async function loadHistory() {
  const panel = $('history-list');
  if (!panel) return;
  panel.innerHTML = '<p class="hist-loading">Loading…</p>';
  try {
    const res  = await fetch(`${API_URL}/inspections?limit=50`);
    const data = await res.json();
    if (!data.length) {
      panel.innerHTML = '<p class="hist-loading">No saved inspections yet.</p>';
      return;
    }
    panel.innerHTML = data.map(insp => {
      const v     = insp.vehicle ?? {};
      const date  = insp.created_at
        ? new Date(insp.created_at).toLocaleDateString('en-MU',
            { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';
      const sev     = insp.severity ?? 'minor';
      const total   = insp.total
        ? `Rs ${Number(insp.total).toLocaleString('en-MU')}` : '—';
      const vehicle = [v.make, v.model, v.year].filter(Boolean).join(' ') || 'Unknown vehicle';
      const decision = insp.decision
        ? `<span class="hist-decision ${insp.decision === 'Total Loss' ? 'hist-loss' : 'hist-repair'}">${insp.decision}</span>`
        : '';
      return `
        <div class="history-row" onclick="viewInspection('${insp.id}')">
          <div class="hist-left">
            <div class="hist-vehicle">${vehicle}</div>
            <div class="hist-meta">${date} · ID: ${insp.id}</div>
          </div>
          <div class="hist-right">
            ${decision}
            <span class="hist-sev sev-${sev}">${sev.toUpperCase()}</span>
            <span class="hist-total">${total}</span>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    panel.innerHTML = `<p class="hist-loading" style="color:var(--danger)">Failed: ${err.message}</p>`;
  }
}

async function viewInspection(id) {
  try {
    const res  = await fetch(`${API_URL}/inspections/${id}`);
    if (!res.ok) throw new Error('Not found');
    const d    = await res.json();
    const v    = d.vehicle ?? {};
    const est  = d.estimate ?? {};
    const fmt  = n => n != null ? `Rs ${Number(n).toLocaleString('en-MU')}` : '—';
    const date = d.created_at
      ? new Date(d.created_at).toLocaleDateString('en-MU',
          { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';

    const items = (est.items ?? []).map(i => `
      <tr>
        <td>${i.part}</td>
        <td>${i.damageType || '—'}</td>
        <td><span class="hist-sev sev-${i.severity}" style="font-size:0.7rem">${(i.severity ?? '').toUpperCase()}</span></td>
        <td style="text-align:right;font-weight:700;color:var(--navy)">${fmt(i.fru_total)}</td>
        ${i.manual ? '<td><span class="manual-tag">Manual</span></td>' : '<td></td>'}
      </tr>`).join('');

    const tl = d.total_loss;
    const tlBlock = tl ? `
      <div class="insp-detail-section">
        <p class="insp-detail-label">Economic Loss</p>
        <div class="insp-tl-verdict ${tl.decision === 'Total Loss' ? 'tl-loss-text' : 'tl-repair-text'}">${tl.decision}</div>
        <div class="insp-tl-row"><span>Pre-accident value</span><span>${tl.pre_accident_value}</span></div>
        <div class="insp-tl-row"><span>Repair estimate</span><span>${tl.repair_estimate}</span></div>
        <div class="insp-tl-row"><span>Repair as % of PAV</span><span>${tl.repair_pct_of_pav}</span></div>
      </div>` : '';

    // Show detail in a modal overlay
    const existing = document.getElementById('insp-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'insp-modal';
    modal.className = 'insp-modal-overlay';
    modal.innerHTML = `
      <div class="insp-modal">
        <div class="insp-modal-head">
          <div>
            <div class="insp-modal-title">${[v.make, v.model, v.year].filter(Boolean).join(' ') || 'Unknown vehicle'}</div>
            <div class="insp-modal-meta">${date} · ID: ${d.id} · <span class="hist-sev sev-${d.severity}" style="font-size:0.72rem">${(d.severity ?? '').toUpperCase()}</span></div>
          </div>
          <button class="insp-modal-close" onclick="document.getElementById('insp-modal').remove()">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/>
            </svg>
          </button>
        </div>
        <div class="insp-modal-body">
          <div class="insp-detail-section">
            <p class="insp-detail-label">Vehicle</p>
            <div class="insp-detail-grid">
              <span>Make / Model</span><span>${[v.make, v.model].filter(Boolean).join(' ') || '—'}</span>
              <span>Year</span><span>${v.year ?? '—'}</span>
              <span>VIN</span><span>${v.vin ?? '—'}</span>
              <span>Registration</span><span>${v.registration ?? '—'}</span>
              <span>Size</span><span>${v.size ?? '—'}</span>
            </div>
          </div>
          <div class="insp-detail-section">
            <p class="insp-detail-label">Repair Estimate — ${est.listType?.toUpperCase() ?? ''}</p>
            <table class="insp-items-table">
              <thead><tr><th>Part</th><th>Type</th><th>Severity</th><th style="text-align:right">Amount</th><th></th></tr></thead>
              <tbody>${items}</tbody>
            </table>
            <div class="insp-totals">
              <div class="insp-total-row"><span>Subtotal excl. VAT</span><span>${fmt(est.subtotal)}</span></div>
              <div class="insp-total-row"><span>VAT 15%</span><span>${fmt(est.vat)}</span></div>
              <div class="insp-total-row insp-grand-total"><span>Total (FRU)</span><span>${fmt(est.total)}</span></div>
            </div>
          </div>
          ${tlBlock}
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  } catch (err) {
    alert(`Could not load inspection: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
const $       = id  => document.getElementById(id);
const setText = (id, val) => { const el=$(id); if(el) el.textContent = val; };
const show    = id  => { const el=$(id); if(el) el.style.display = 'block'; };
const hide    = id  => { const el=$(id); if(el) el.style.display = 'none';  };
const fmt     = str => str ? str.replace(/[_-]/g, ' ').toUpperCase() : '';