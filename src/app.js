// ── CONFIG ────────────────────────────────────────────────────────────────────
const API_URL    = "http://192.168.100.65:8000";
const MAX_DIM    = 640;
const TIMEOUT_MS = 180_000;

// ── STATE ─────────────────────────────────────────────────────────────────────
let selectedFile        = null;
let lastPipelineResult  = null;
let estimateSettings    = { listType: 'client', vehicleSize: 'medium' };

// ── LOADING MESSAGES ──────────────────────────────────────────────────────────
const LOADING_MESSAGES = [
  'Stage 1 — scanning full image...',
  'Detecting damage regions...',
  'Stage 2 — analysing each region...',
  'Running VehiDE model on crops...',
  'Detecting car parts...',
  'Running severity classifier...',
  'Almost done...',
];

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // File / camera inputs
  $('file-in').addEventListener('change', e => e.target.files[0] && handleFile(e.target.files[0]));
  $('cam-in').addEventListener('change',  e => e.target.files[0] && handleFile(e.target.files[0]));
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
    e.preventDefault();
    dz.classList.remove('drag');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // Estimate controls
  $('btn-client')?.addEventListener('click',  () => switchList('client'));
  $('btn-interne')?.addEventListener('click', () => switchList('interne'));
  $('vehicle-model')?.addEventListener('input', e => onVehicleInput(e.target.value));

  // Populate vehicle autocomplete
  populateVehicleAutocomplete();
});

// ─────────────────────────────────────────────────────────────────────────────
// FILE HANDLING
// ─────────────────────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;

  // Show preview immediately from original file
  const preview = $('preview');
  preview.src = URL.createObjectURL(file);
  preview.onload = () => {
    show('preview-wrap');
    clearResults();
  };

  // Resize in background — store resized version for upload
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
      const scale  = maxDim / Math.max(width, height);
      const w      = Math.round(width  * scale);
      const h      = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
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

  setLoading(true);
  hideError();

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const fd = new FormData();
    fd.append('file', selectedFile);

    const res = await fetch(`${API_URL}/predict`, {
      method: 'POST',
      body:   fd,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail ?? `Server error ${res.status}`);
    }

    const data = await res.json();

    if (!data?.stage1?.severity) {
      throw new Error(`Unexpected response — check backend logs.\n${JSON.stringify(data)}`);
    }

    lastPipelineResult = data;
    renderResults(data);
    drawBoxes(data);
    renderEstimate(data);

  } catch (err) {
    clearTimeout(timeout);
    showError(
      err.name === 'AbortError'
        ? '⏱ Timed out — is the backend running?  cd backend && python app.py'
        : `❌ ${err.message}`,
    );
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

  // ── Overall severity ──────────────────────────────────────────────────────
  renderSeverityBadge(stage1.severity);

  // ── Stage 1 detections ────────────────────────────────────────────────────
  const list = $('damage-list');
  list.innerHTML = '';

  if (stage1.detections?.length) {
    list.insertAdjacentHTML('beforeend', `
      <div class="section-label">🔍 Initial scan</div>
      ${stage1.detections.map(d => detectionCard(d)).join('')}
    `);
    show('damage-section');
  }

  // ── Stage 2 regions ───────────────────────────────────────────────────────
  if (stage2?.length) {
    stage2.forEach((region, idx) => renderRegion(region, idx + 1, list));
    show('damage-section');
  }
}

function renderSeverityBadge(sev) {
  const badge = $('severity-badge');
  badge.className = `sev-${sev.class}`;
  $('sev-val').textContent  = sev.class.toUpperCase();
  $('sev-conf').textContent = `${Math.round(sev.confidence * 100)}% confidence`;
  show('severity-badge');

  show('prob-bars');
  ['minor', 'moderate', 'severe'].forEach(c => {
    const pct = Math.round((sev.probabilities[c] ?? 0) * 100);
    $(`b-${c}`).style.width  = pct + '%';
    $(`p-${c}`).textContent  = pct + '%';
  });
}

function renderRegion(region, idx, container) {
  const regionSev = region.severity;

  container.insertAdjacentHTML('beforeend', `
    <div class="region-header sev-${regionSev.class}">
      Region #${idx} — ${fmt(region.triggered_by.type)}
      <span class="region-sev">
        ${regionSev.class.toUpperCase()} · ${Math.round(regionSev.confidence * 100)}%
      </span>
    </div>
  `);

  if (region.damages?.length) {
    region.damages.forEach(d => {
      container.insertAdjacentHTML('beforeend', detectionCard(d, true));
    });
  } else {
    container.insertAdjacentHTML('beforeend', `
      <div class="dmg-card dmg-detailed muted">No specific damage detected</div>
    `);
  }

  if (region.parts?.length) {
    const partsList = $('parts-list');
    partsList.innerHTML += region.parts.map(p => {
      const hasDmg = region.damages?.some(d => d.on_part === p.name);
      return `<span class="part-chip ${hasDmg ? 'damaged' : ''}">${fmt(p.name)}</span>`;
    }).join('');
    show('parts-section');
  }
}

function detectionCard(d, detailed = false) {
  const part = d.on_part
    ? `<div class="dmg-part">📍 ${fmt(d.on_part)}${d.overlap_pct > 0 ? ` · ${d.overlap_pct}% overlap` : ''}</div>`
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
// DRAW BOUNDING BOXES
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

  const scale = v => (i => v * (i % 2 === 0 ? sx : sy));

  // Stage 1 — orange dashed
  (data.stage1.detections ?? []).forEach(d => {
    const [x1, y1, x2, y2] = d.box.map((v, i) => v * (i % 2 === 0 ? sx : sy));
    drawBox(ctx, x1, y1, x2, y2, '#f39c12', fmt(d.type), { dashed: true, alpha: 0.13 });
  });

  // Stage 2
  (data.stage2 ?? []).forEach(region => {
    // Parts — blue
    (region.parts ?? []).forEach(p => {
      const [x1, y1, x2, y2] = p.box.map((v, i) => v * (i % 2 === 0 ? sx : sy));
      drawBox(ctx, x1, y1, x2, y2, '#3498db', fmt(p.name), { labelBottom: true, alpha: 0.13 });
    });
    // Damages — red
    (region.damages ?? []).forEach(d => {
      const [x1, y1, x2, y2] = d.box.map((v, i) => v * (i % 2 === 0 ? sx : sy));
      drawBox(ctx, x1, y1, x2, y2, '#e74c3c', fmt(d.type), { lineWidth: 3, alpha: 0 });
    });
  });
}

function drawBox(ctx, x1, y1, x2, y2, color, label, {
  dashed      = false,
  lineWidth   = 2,
  alpha       = 0.13,
  labelBottom = false,
} = {}) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = lineWidth;
  if (dashed) ctx.setLineDash([6, 3]);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  ctx.setLineDash([]);

  if (alpha > 0) {
    ctx.fillStyle = color + Math.round(alpha * 255).toString(16).padStart(2, '0');
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  }

  if (label) {
    ctx.font = `${labelBottom ? 'normal 10' : 'bold 11'}px system-ui`;
    const tw = ctx.measureText(label).width;
    if (labelBottom) {
      ctx.fillStyle = color;
      ctx.fillText(label, x1 + 4, y2 - 4);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(x1, y1 - 20, tw + 10, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x1 + 5, y1 - 5);
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

  // Header label
  $('estimate-list-label').textContent =
    window.Pricing.LIST_LABELS[estimateSettings.listType];

  // Line items
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
    container.innerHTML = estimate.lineItems.map(item => `
      <div class="estimate-item sev-${item.severity}">
        <div class="item-left">
          <div class="item-part">${item.part}</div>
          <div class="item-meta">
            <span class="sev-tag">${item.severity}</span>
            ${window.Pricing.DAMAGE_LABELS[item.damageLevel]} ·
            ${window.Pricing.SIZE_LABELS[estimateSettings.vehicleSize]}
          </div>
        </div>
        <div class="item-price">${window.Pricing.formatMUR(item.price)}</div>
      </div>`).join('');
  }

  // Totals
  $('est-subtotal').textContent = window.Pricing.formatMUR(estimate.subtotal);
  $('est-vat').textContent      = window.Pricing.formatMUR(estimate.vat);
  $('est-total').textContent    = window.Pricing.formatMUR(estimate.total);

  // Unknown parts warning
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
  const size     = resolved?.size ?? 'medium';
  const brand    = resolved?.brand ?? null;

  estimateSettings.vehicleSize = size;

  const badge = $('size-badge');
  if (badge) {
    badge.textContent = size === 'large' ? 'Large' : 'Medium';
    badge.className   = `size-badge ${size}`;
  }

  const brandEl = $('vehicle-brand-detected');
  if (brandEl) brandEl.textContent = brand ? `✓ ${brand}` : '';

  refreshEstimate();
}

function populateVehicleAutocomplete() {
  if (typeof window.Pricing === 'undefined') return;
  const datalist = $('vehicle-models-list');
  if (!datalist) return;
  datalist.innerHTML = window.Pricing.listAllModels()
    .map(m => `<option value="${m.brand} ${m.name}">`)
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// RESET / CLEAR
// ─────────────────────────────────────────────────────────────────────────────
function reset() {
  selectedFile       = null;
  lastPipelineResult = null;

  $('preview').src    = '';
  $('file-in').value  = '';
  $('cam-in').value   = '';

  hide('preview-wrap');
  show('drop-zone');
  show('upload-btn');
  show('cam-btn');

  $('analyse-btn').disabled = true;
  hide('reset-btn');

  clearResults();
}

function clearResults() {
  [
    'severity-badge', 'prob-bars', 'damage-section',
    'parts-section',  'error-box', 'estimate-settings',
    'estimate-section', 'unknown-parts-warn',
  ].forEach(hide);

  $('damage-list') && ($('damage-list').innerHTML = '');
  $('parts-list')  && ($('parts-list').innerHTML  = '');

  const cv = $('overlay');
  if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
}

// ─────────────────────────────────────────────────────────────────────────────
// LOADING / ERROR UI
// ─────────────────────────────────────────────────────────────────────────────
let _msgTimer = null;

function setLoading(on) {
  if (on) {
    show('dmg-loading');
    $('analyse-btn').disabled = true;

    let idx = 0;
    const msgEl = document.querySelector('#dmg-loading p');
    if (msgEl) {
      msgEl.textContent = LOADING_MESSAGES[0];
      _msgTimer = setInterval(() => {
        idx = (idx + 1) % LOADING_MESSAGES.length;
        msgEl.textContent = LOADING_MESSAGES[idx];
      }, 7000);
    }
  } else {
    clearInterval(_msgTimer);
    _msgTimer = null;
    const msgEl = document.querySelector('#dmg-loading p');
    if (msgEl) msgEl.textContent = 'Analysing damage...';
    hide('dmg-loading');
    $('analyse-btn').disabled = false;
  }
}

function showError(msg) {
  const el = $('error-box');
  if (!el) return;
  el.textContent = msg;
  show('error-box');
}

function hideError() {
  hide('error-box');
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
const $    = id  => document.getElementById(id);
const show = id  => { const el = $(id); if (el) el.style.display = 'block'; };
const hide = id  => { const el = $(id); if (el) el.style.display = 'none';  };
const fmt  = str => str ? str.replace(/[_-]/g, ' ').toUpperCase() : '';