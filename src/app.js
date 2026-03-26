// ── CONFIG ────────────────────────────────────────────────────────────────────
const API_URL    = `http://${location.hostname}:8000`;
const MAX_DIM    = 640;
const TIMEOUT_MS = 180_000;

// ── STATE ─────────────────────────────────────────────────────────────────────
let selectedFile        = null;     // damage photo
let lastPipelineResult  = null;
let vehicleInfo         = null;     // decoded from vignette
let estimateSettings    = { listType: 'client', vehicleSize: 'medium', labourTier: 'standard' };

// ── LOADING MESSAGES ──────────────────────────────────────────────────────────
const DAMAGE_MESSAGES = [
  'Stage 1 — scanning full image...',
  'Detecting damage regions...',
  'Stage 2 — analysing each region...',
  'Running VehiDE model on crops...',
  'Detecting car parts...',
  'Running severity classifier...',
  'Almost done...',
];

const VIGNETTE_MESSAGES = [
  'Detecting vignette...',
  'Running OCR...',
  'Decoding VIN...',
  'Reading vehicle details...',
];

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Step 1 — vignette
  $('vig-input')?.addEventListener('change',
    e => e.target.files[0] && scanVignette(e.target.files[0]));
  $('vig-btn')?.addEventListener('click', () => $('vig-input')?.click());
  $('vig-skip')?.addEventListener('click', skipVignette);

  // Step 2 — damage photo
  $('file-in').addEventListener('change',  e => e.target.files[0] && handleFile(e.target.files[0]));
  $('cam-in').addEventListener('change',   e => e.target.files[0] && handleFile(e.target.files[0]));
  $('upload-btn').addEventListener('click', () => $('file-in').click());
  $('cam-btn').addEventListener('click',    () => $('cam-in').click());

  // Actions
  $('analyse-btn').addEventListener('click', analyse);
  $('reset-btn').addEventListener('click', reset);

  // Drag-and-drop
  const dz = $('drop-zone');
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // Estimate controls
  $('btn-client')?.addEventListener('click',  () => switchList('client'));
  $('btn-interne')?.addEventListener('click', () => switchList('interne'));
  $('vehicle-model')?.addEventListener('input', e => onVehicleInput(e.target.value));

  populateVehicleAutocomplete();
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — VIGNETTE SCAN
// ─────────────────────────────────────────────────────────────────────────────
async function scanVignette(file) {
  setLoading(true, VIGNETTE_MESSAGES);
  hideError();
  hide('vig-result');

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 120_000);  // 2 min — OCR is slow

  try {
    const fd = new FormData();
    fd.append('file', file);

    const res = await fetch(`${API_URL}/scan-vignette`, {
      method: 'POST', body: fd, signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail ?? `Server error ${res.status}`);
    }

    const data = await res.json();
    vehicleInfo = data;

    // Show card if we got anything useful — even partial success
    const hasData = data.make || data.model || data.policy_no || data.registration;
    if (hasData) {
      applyVehicleInfo(data);
      renderVignetteCard(data);
    }
    if (!data.success && data.error) {
      showError(`⚠️ ${data.error} — you can still analyse damage manually.`);
    }

  } catch (err) {
    clearTimeout(timeout);
    showError(err.name === 'AbortError'
      ? '⏱ Vignette scan timed out.'
      : `❌ ${err.message}`);
  } finally {
    setLoading(false);
    // Unlock damage step regardless of vignette success
    show('damage-step');
  }
}

function skipVignette() {
  vehicleInfo = null;
  hide('vig-step');
  show('damage-step');
}

function applyVehicleInfo(data) {
  // Auto-set vehicle size + labour tier from VIN decode
  if (data.vehicle_size) {
    estimateSettings.vehicleSize = data.vehicle_size;
    const badge = $('size-badge');
    if (badge) {
      badge.textContent = data.vehicle_size === 'large' ? 'Large' : 'Medium';
      badge.className   = `size-badge ${data.vehicle_size}`;
    }
  }

  // Auto-fill vehicle model input + resolve labour tier
  const modelInput = $('vehicle-model');
  if (modelInput && data.make && data.model) {
    const modelStr = `${data.make} ${data.model}`;
    modelInput.value = modelStr;
    const brandEl = $('vehicle-brand-detected');
    if (brandEl) brandEl.textContent = `✓ ${data.make}`;
    // Resolve labour tier from model
    const resolved = window.Pricing?.resolveVehicle(modelStr);
    if (resolved?.labourTier) {
      estimateSettings.labourTier = resolved.labourTier;
    }
  }
}

function renderVignetteCard(data) {
  const card = $('vig-result');
  if (!card) return;

  const year  = data.year  ? ` ${data.year}`  : '';
  const reg   = data.registration ? ` · ${data.registration}` : '';
  const vin   = data.vin   ? `<div class="vig-vin">VIN: ${data.vin}</div>` : '';
  const exp   = data.expiry_date ? `<div class="vig-exp">Expiry: ${data.expiry_date}</div>` : '';

  card.innerHTML = `
    <div class="vig-card">
      <div class="vig-vehicle">${data.make ?? '?'} ${data.model ?? '?'}${year}${reg}</div>
      <div class="vig-meta">
        <span class="vig-size-tag ${data.vehicle_size ?? 'medium'}">${(data.vehicle_size ?? 'medium').toUpperCase()}</span>
        ${data.insurer ? `<span class="vig-tag">${data.insurer}</span>` : ''}
        ${data.registration ? `<span class="vig-tag">${data.registration}</span>` : ''}
      </div>
      ${vin}${exp}
    </div>`;
  show('vig-result');
  hide('vig-step');
  show('damage-step');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — DAMAGE PHOTO
// ─────────────────────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;

  const preview = $('preview');
  preview.src   = URL.createObjectURL(file);
  preview.onload = () => { show('preview-wrap'); clearResults(); };

  resizeImage(file, MAX_DIM).then(resized => { selectedFile = resized; });

  $('analyse-btn').disabled = false;
  hide('drop-zone');
  hide('upload-btn');
  hide('cam-btn');
}

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
// ANALYSE
// ─────────────────────────────────────────────────────────────────────────────
async function analyse() {
  if (!selectedFile) return;

  setLoading(true, DAMAGE_MESSAGES);
  hideError();

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const fd = new FormData();
    fd.append('file', selectedFile);

    // Build query params — pass vehicle + estimate data for DB save
    const params = new URLSearchParams();
    if (vehicleInfo?.success) {
      params.set('vehicle_data', JSON.stringify(vehicleInfo));
    }

    const res = await fetch(`${API_URL}/predict?${params}`, {
      method: 'POST', body: fd, signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail ?? `Server error ${res.status}`);
    }

    const data = await res.json();

    if (!data?.stage1?.severity) {
      throw new Error('Unexpected response from server — check backend logs.');
    }

    lastPipelineResult = data;
    renderResults(data);
    drawBoxes(data);
    renderEstimate(data);

    // After estimate is built, save it to DB via a second request
    if (data.inspection_id) {
      saveEstimateToDB(data.inspection_id);
    }

  } catch (err) {
    clearTimeout(timeout);
    showError(err.name === 'AbortError'
      ? '⏱ Timed out — is the backend running?  cd backend && python app.py'
      : `❌ ${err.message}`);
  } finally {
    setLoading(false);
    show('reset-btn');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER RESULTS
// ─────────────────────────────────────────────────────────────────────────────
function renderResults(data) {
  const { stage1, stage2 } = data;

  renderSeverityBadge(stage1.severity);

  const list = $('damage-list');
  list.innerHTML = '';

  if (stage1.detections?.length) {
    list.insertAdjacentHTML('beforeend', `
      <div class="scan-label">Initial scan</div>
      ${stage1.detections.map(d => detectionCard(d)).join('')}
    `);
    show('damage-section');
  }

  if (stage2?.length) {
    stage2.forEach((region, idx) => renderRegion(region, idx + 1, list));
    show('damage-section');
  }
}

function renderSeverityBadge(sev) {
  const badge = $('severity-badge');
  badge.className = `sev-${sev.class}`;
  setText('sev-val',  sev.class.toUpperCase());
  setText('sev-conf', `${Math.round(sev.confidence * 100)}% confidence`);
  show('severity-badge');

  show('prob-bars');
  ['minor', 'moderate', 'severe'].forEach(c => {
    const pct = Math.round((sev.probabilities[c] ?? 0) * 100);
    $(`b-${c}`).style.width = pct + '%';
    $(`p-${c}`).textContent = pct + '%';
  });
}

function renderRegion(region, idx, container) {
  const regionSev = region.severity;
  container.insertAdjacentHTML('beforeend', `
    <div class="region-header sev-${regionSev.class}">
      <span class="region-title">Region ${String(idx).padStart(2,'0')} — ${fmt(region.triggered_by.type)}</span>
      <span class="region-sev">${regionSev.class.toUpperCase()} · ${Math.round(regionSev.confidence * 100)}%</span>
    </div>
  `);

  if (region.damages?.length) {
    region.damages.forEach(d => container.insertAdjacentHTML('beforeend', detectionCard(d, true)));
  } else {
    container.insertAdjacentHTML('beforeend',
      `<div class="dmg-card dmg-detailed muted">No specific damage detected</div>`);
  }

  if (region.parts?.length) {
    const partsList = $('parts-list');
    // Collect already-rendered part names to avoid duplicates across regions
    const existing = new Set(
      [...partsList.querySelectorAll('.part-chip')].map(el => el.dataset.part)
    );
    region.parts.forEach(p => {
      if (existing.has(p.name)) return;
      existing.add(p.name);
      const hasDmg = region.damages?.some(d => d.on_part === p.name);
      partsList.insertAdjacentHTML('beforeend',
        `<span class="part-chip ${hasDmg ? 'damaged' : ''}" data-part="${p.name}">${fmt(p.name)}</span>`
      );
    });
    show('parts-section');
  }
}

function detectionCard(d, detailed = false) {
  const part = d.on_part
    ? `<div class="dmg-part">${fmt(d.on_part)}${d.overlap_pct > 0 ? ` · ${d.overlap_pct}%` : ''}</div>`
    : '';
  return `
    <div class="dmg-card ${detailed ? 'dmg-detailed' : ''}">
      <div class="dmg-left">
        <div class="dmg-type">${fmt(d.type)}</div>
        ${detailed ? part : ''}
      </div>
      <div class="dmg-conf-badge">${Math.round(d.conf * 100)}%</div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDING BOXES
// ─────────────────────────────────────────────────────────────────────────────
function drawBoxes(data) {
  const img = $('preview');
  const cv  = $('overlay');
  cv.width  = img.naturalWidth;
  cv.height = img.naturalHeight;
  cv.style.width  = img.offsetWidth  + 'px';
  cv.style.height = img.offsetHeight + 'px';

  const ctx = cv.getContext('2d');
  const sx  = img.naturalWidth  / data.image_size.width;
  const sy  = img.naturalHeight / data.image_size.height;

  (data.stage1.detections ?? []).forEach(d => {
    const [x1,y1,x2,y2] = d.box.map((v,i) => v*(i%2===0?sx:sy));
    drawBox(ctx, x1,y1,x2,y2, '#f39c12', fmt(d.type), { dashed:true, alpha:0.13 });
  });

  (data.stage2 ?? []).forEach(region => {
    (region.parts ?? []).forEach(p => {
      const [x1,y1,x2,y2] = p.box.map((v,i) => v*(i%2===0?sx:sy));
      drawBox(ctx, x1,y1,x2,y2, '#3498db', fmt(p.name), { labelBottom:true, alpha:0.13 });
    });
    (region.damages ?? []).forEach(d => {
      const [x1,y1,x2,y2] = d.box.map((v,i) => v*(i%2===0?sx:sy));
      drawBox(ctx, x1,y1,x2,y2, '#e74c3c', fmt(d.type), { lineWidth:3, alpha:0 });
    });
  });
}

function drawBox(ctx, x1,y1,x2,y2, color, label, {
  dashed=false, lineWidth=2, alpha=0.13, labelBottom=false
}={}) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = lineWidth;
  if (dashed) ctx.setLineDash([6,3]);
  ctx.strokeRect(x1, y1, x2-x1, y2-y1);
  ctx.setLineDash([]);
  if (alpha > 0) {
    ctx.fillStyle = color + Math.round(alpha*255).toString(16).padStart(2,'0');
    ctx.fillRect(x1, y1, x2-x1, y2-y1);
  }
  if (label) {
    ctx.font = `${labelBottom?'normal 10':'bold 11'}px system-ui`;
    const tw = ctx.measureText(label).width;
    if (labelBottom) {
      ctx.fillStyle = color;
      ctx.fillText(label, x1+4, y2-4);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(x1, y1-20, tw+10, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x1+5, y1-5);
    }
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// ESTIMATE
// ─────────────────────────────────────────────────────────────────────────────
function renderEstimate(data) {
  show('estimate-settings');
  show('estimate-section');
  refreshEstimate();
}

function refreshEstimate() {
  if (!lastPipelineResult || typeof window.Pricing === 'undefined') return;

  const estimate = window.Pricing.buildEstimate(lastPipelineResult, estimateSettings);
  const fmt      = window.Pricing.formatMUR;

  // Header label — show labour tier if EV
  const tierLabel = estimateSettings.labourTier === 'ev' ? ' · EV/Hybrid' : '';
  setText('estimate-list-label',
    window.Pricing.LIST_LABELS[estimateSettings.listType] + tierLabel);

  const container = $('estimate-items');
  if (!estimate.lineItems.length) {
    container.innerHTML = `
      <div class="no-items">
        No parts matched in price list.
        ${estimate.unknownParts.length
          ? `<br><small>Unmatched: ${estimate.unknownParts.join(', ')}</small>`
          : ''}
      </div>`;
  } else {
    container.innerHTML = estimate.lineItems.map(item => {
      const fru = item.fru;
      const fruBreakdown = fru ? `
        <div class="fru-row">
          <span class="fru-cell"><span class="fru-label">D/P</span> ${fru.dp} × ${fru.lev1} = ${fmt(fru.dp_cost)}</span>
          <span class="fru-cell"><span class="fru-label">R</span> ${fru.r} × ${fru.lev2} = ${fmt(fru.r_cost)}</span>
          <span class="fru-cell"><span class="fru-label">P</span> ${fru.p} × ${fru.lev1} = ${fmt(fru.p_cost)}</span>
        </div>` : '';
      const forfaitNote = item.forfait
        ? `<span class="forfait-compare">Forfait: ${fmt(item.forfait)}</span>`
        : '';
      return `
      <div class="estimate-item sev-${item.severity}">
        <div class="item-left">
          <div class="item-part">${item.part}</div>
          <div class="item-meta">
            <span class="sev-tag">${item.severity}</span>
            ${window.Pricing.DAMAGE_LABELS[item.damageLevel]} ·
            ${window.Pricing.SIZE_LABELS[estimateSettings.vehicleSize]}
          </div>
          ${fruBreakdown}
          ${forfaitNote}
        </div>
        <div class="item-price">${fmt(item.price)}</div>
      </div>`;
    }).join('');
  }

  setText('est-subtotal', fmt(estimate.subtotal));
  setText('est-vat',      fmt(estimate.vat));
  setText('est-total',    fmt(estimate.total));

  // Forfait comparison totals
  const compRow = $('est-forfait-compare');
  if (compRow && estimate.forfaitTotal) {
    compRow.textContent = `Forfait total: ${fmt(estimate.forfaitTotal)} (excl. VAT ${fmt(estimate.forfaitSubtotal)})`;
    show('est-forfait-compare');
  }

  const warn = $('unknown-parts-warn');
  if (warn) {
    warn.textContent = estimate.unknownParts.length
      ? `⚠️ No price found for: ${estimate.unknownParts.join(', ')}`
      : '';
    estimate.unknownParts.length ? show('unknown-parts-warn') : hide('unknown-parts-warn');
  }
}

function switchList(type) {
  estimateSettings.listType = type;
  $('btn-client')?.classList.toggle('active',  type === 'client');
  $('btn-interne')?.classList.toggle('active', type === 'interne');
  refreshEstimate();
}

function onVehicleInput(value) {
  if (typeof window.Pricing === 'undefined') return;
  const resolved = window.Pricing.resolveVehicle(value);
  const size       = resolved?.size       ?? 'medium';
  const labourTier = resolved?.labourTier ?? 'standard';
  estimateSettings.vehicleSize = size;
  estimateSettings.labourTier  = labourTier;
  const badge = $('size-badge');
  if (badge) { badge.textContent = size === 'large' ? 'Large' : 'Medium'; badge.className = `size-badge ${size}`; }
  const brandEl = $('vehicle-brand-detected');
  if (brandEl) brandEl.textContent = resolved?.brand ? `✓ ${resolved.brand}` : '';
  refreshEstimate();
}

function populateVehicleAutocomplete() {
  if (typeof window.Pricing === 'undefined') return;
  const dl = $('vehicle-models-list');
  if (!dl) return;
  dl.innerHTML = window.Pricing.listAllModels()
    .map(m => `<option value="${m.brand} ${m.name}">`).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// RESET
// ─────────────────────────────────────────────────────────────────────────────
function reset() {
  selectedFile = lastPipelineResult = null;
  $('preview').src = '';
  $('file-in').value = $('cam-in').value = '';
  hide('preview-wrap');
  show('drop-zone'); show('upload-btn'); show('cam-btn');
  $('analyse-btn').disabled = true;
  hide('reset-btn');
  clearResults();

  // Re-show vignette step for a new scan
  if (!vehicleInfo) {
    show('vig-step');
    hide('damage-step');
  }
}

function clearResults() {
  ['severity-badge','prob-bars','damage-section','parts-section',
   'error-box','estimate-settings','estimate-section','unknown-parts-warn',
  ].forEach(hide);
  $('damage-list') && ($('damage-list').innerHTML = '');
  $('parts-list')  && ($('parts-list').innerHTML  = '');
  const cv = $('overlay');
  if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
}

// ─────────────────────────────────────────────────────────────────────────────
// LOADING / ERROR
// ─────────────────────────────────────────────────────────────────────────────
let _msgTimer = null;

function setLoading(on, messages = DAMAGE_MESSAGES) {
  if (on) {
    show('dmg-loading');
    $('analyse-btn').disabled = true;
    let idx = 0;
    const msgEl = document.querySelector('#dmg-loading p');
    if (msgEl) {
      msgEl.textContent = messages[0];
      _msgTimer = setInterval(() => {
        idx = (idx + 1) % messages.length;
        msgEl.textContent = messages[idx];
      }, 8000);
    }
  } else {
    clearInterval(_msgTimer); _msgTimer = null;
    const msgEl = document.querySelector('#dmg-loading p');
    if (msgEl) msgEl.textContent = 'Processing...';
    hide('dmg-loading');
    $('analyse-btn').disabled = false;
  }
}

function showError(msg) { const el=$('error-box'); if(el){el.textContent=msg;show('error-box');} }
function hideError()    { hide('error-box'); }

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
const $       = id  => document.getElementById(id);
const setText = (id, val) => { const el=$(id); if(el) el.textContent=val; };
const show    = id  => { const el=$(id); if(el) el.style.display='block'; };
const hide    = id  => { const el=$(id); if(el) el.style.display='none';  };
const fmt     = str => str ? str.replace(/[_-]/g,' ').toUpperCase() : '';

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE — save estimate + load history
// ─────────────────────────────────────────────────────────────────────────────

async function saveEstimateToDB(inspectionId) {
  if (!inspectionId || typeof window.Pricing === 'undefined') return;
  if (!lastPipelineResult) return;

  const estimate = window.Pricing.buildEstimate(lastPipelineResult, estimateSettings);

  try {
    const params = new URLSearchParams({
      estimate_data: JSON.stringify({
        listType:    estimateSettings.listType,
        vehicleSize: estimateSettings.vehicleSize,
        lineItems:   estimate.lineItems,
        subtotal:    estimate.subtotal,
        vat:         estimate.vat,
        total:       estimate.total,
      }),
    });
    await fetch(`${API_URL}/inspections/${inspectionId}/estimate?${params}`, {
      method: 'PATCH',
    }).catch(() => {});  // fire-and-forget, don't block UI
  } catch (_) {}
}

// ── History panel ─────────────────────────────────────────────────────────────
async function loadHistory() {
  const panel = $('history-list');
  if (!panel) return;
  panel.innerHTML = '<p class="step-label" style="padding:16px">Loading...</p>';

  try {
    const res  = await fetch(`${API_URL}/inspections?limit=20`);
    const data = await res.json();

    if (!data.length) {
      panel.innerHTML = '<p class="step-label" style="padding:16px">No inspections yet.</p>';
      return;
    }

    panel.innerHTML = data.map(insp => {
      const v    = insp.vehicle;
      const date = insp.created_at
        ? new Date(insp.created_at).toLocaleDateString('en-MU', {
            day:'2-digit', month:'short', year:'numeric'
          })
        : '—';
      const sev  = insp.severity ?? '—';
      const total = insp.total ? `Rs ${Number(insp.total).toLocaleString('en-MU')}` : '—';

      return `
        <div class="history-row" onclick="viewInspection('${insp.id}')">
          <div class="hist-left">
            <div class="hist-vehicle">${v ? `${v.make ?? ''} ${v.model ?? ''} ${v.year ?? ''}`.trim() : 'Unknown vehicle'}</div>
            <div class="hist-meta">${date} &middot; ${v?.registration ?? '—'}</div>
          </div>
          <div class="hist-right">
            <span class="hist-sev sev-${sev}">${sev.toUpperCase()}</span>
            <span class="hist-total">${total}</span>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    panel.innerHTML = `<p class="step-label" style="padding:16px;color:#e74c3c">Failed to load: ${err.message}</p>`;
  }
}

async function viewInspection(id) {
  try {
    const res  = await fetch(`${API_URL}/inspections/${id}`);
    const data = await res.json();
    // Re-render results from saved inspection
    alert(`Inspection ${id}\nVehicle: ${data.vehicle?.make} ${data.vehicle?.model}\nTotal: Rs ${data.total?.toLocaleString()}`);
    // TODO: full detail view
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// Load history when tab becomes visible
document.addEventListener('DOMContentLoaded', () => {
  $('history-tab')?.addEventListener('click', () => {
    show('history-panel');
    hide('main-panel');
    loadHistory();
  });
  $('main-tab')?.addEventListener('click', () => {
    show('main-panel');
    hide('history-panel');
  });
});