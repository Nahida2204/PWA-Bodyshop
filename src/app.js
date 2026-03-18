const API_URL = "http://192.168.1.45:8000";
let selectedFile = null;

// ── Wire up all events after DOM ready ─────────────────
document.addEventListener("DOMContentLoaded", () => {
  // ── Direct click on upload button ───────────────────
  document.getElementById("upload-btn").addEventListener("click", () => {
    document.getElementById("file-in").click();
  });

  // ── Direct click on camera button ───────────────────
  document.getElementById("cam-btn").addEventListener("click", () => {
    document.getElementById("cam-in").click();
  });

  // File inputs
  document.getElementById("file-in").addEventListener("change", (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });
  document.getElementById("cam-in").addEventListener("change", (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  document.getElementById("analyse-btn").addEventListener("click", analyse);
  document.getElementById("reset-btn").addEventListener("click", resetDamage);

  // Drag & drop on drop zone
  const dz = document.getElementById("drop-zone");
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
});

// ── Handle file selection ──────────────────────────────
function handleFile(file) {
  if (!file) return;
  selectedFile = file;

  const img = document.getElementById("preview");
  img.src = URL.createObjectURL(file);
  img.onload = () => {
    show("preview-wrap");
    clearResults();

    // Resize image to max 800px before sending to backend
    resizeImage(file, 640).then((resized) => {
      selectedFile = resized;
    });
  };

  document.getElementById("analyse-btn").disabled = false;
  hide("drop-zone");
  hide("upload-btn");
  hide("cam-btn");
}

// Resize image to maxDim on longest side
function resizeImage(file, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;

      if (width <= maxDim && height <= maxDim) {
        resolve(file); // already small enough
        return;
      }

      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          resolve(new File([blob], file.name, { type: "image/jpeg" }));
        },
        "image/jpeg",
        0.75,
      );

      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

// ── Analyse ────────────────────────────────────────────
async function analyse() {
  if (!selectedFile) return;

  show("dmg-loading");
  document.getElementById("analyse-btn").disabled = true;
  hide("error-box");

  // Progress messages so user knows it's working
  const messages = [
    "Analysing damage...",
    "Running part detection...",
    "Running damage detection...",
    "Running severity model...",
    "Almost done...",
  ];
  let msgIdx = 0;
  const msgEl = document.querySelector("#dmg-loading p");
  msgEl.textContent = messages[0];
  const msgTimer = setInterval(() => {
    msgIdx = (msgIdx + 1) % messages.length;
    msgEl.textContent = messages[msgIdx];
  }, 8000);

  try {
    const fd = new FormData();
    fd.append("file", selectedFile);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000); // 3 min

    const res = await fetch(`${API_URL}/predict`, {
      method: "POST",
      body: fd,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    renderResults(data);
    drawBoxes(data);
  } catch (err) {
    show("error-box");
    document.getElementById("error-box").textContent =
      err.name === "AbortError"
        ? "❌ Timed out after 3 min — backend may have crashed. Restart python app.py"
        : `❌ ${err.message}`;
  } finally {
    clearInterval(msgTimer);
    msgEl.textContent = "Analysing damage...";
    hide("dmg-loading");
    show("reset-btn");
  }
}

// ── Render results ─────────────────────────────────────
function renderResults(d) {
  const { severity, damages, parts } = d;

  // Severity badge
  const badge = document.getElementById("severity-badge");
  badge.className = `sev-${severity.class}`;
  show("severity-badge");
  document.getElementById("sev-val").textContent = severity.class.toUpperCase();
  document.getElementById("sev-conf").textContent =
    `${Math.round(severity.confidence * 100)}% confidence`;

  // Probability bars
  show("prob-bars");
  ["minor", "moderate", "severe"].forEach((c) => {
    const pct = Math.round((severity.probabilities[c] || 0) * 100);
    document.getElementById(`b-${c}`).style.width = pct + "%";
    document.getElementById(`p-${c}`).textContent = pct + "%";
  });

  // Damage cards
  if (damages && damages.length) {
    show("damage-section");
    document.getElementById("damage-list").innerHTML = damages
      .map(
        (d) => `
      <div class="dmg-card">
        <div class="dmg-left">
          <div class="dmg-type">${d.type.replace(/_/g, " ").toUpperCase()}</div>
          <div class="dmg-part">📍 ${d.on_part.replace(/_/g, " ")}
            ${d.overlap_pct > 0 ? `· ${d.overlap_pct}% overlap` : "· nearest part"}
          </div>
        </div>
        <div class="dmg-conf-badge">${Math.round(d.conf * 100)}%</div>
      </div>`,
      )
      .join("");
  }

  // Parts chips
  if (parts && parts.length) {
    show("parts-section");
    const dp = new Set((damages || []).map((d) => d.on_part));
    document.getElementById("parts-list").innerHTML = parts
      .map(
        (p) => `
      <span class="part-chip ${dp.has(p.name) ? "damaged" : ""}">
        ${p.name.replace(/_/g, " ")}
      </span>`,
      )
      .join("");
  }
}

// ── Draw bounding boxes on canvas ──────────────────────
function drawBoxes(data) {
  const img = document.getElementById("preview");
  const cv = document.getElementById("overlay");
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  cv.style.width = img.offsetWidth + "px";
  cv.style.height = img.offsetHeight + "px";

  const ctx = cv.getContext("2d");
  const sx = img.naturalWidth / data.image_size.width;
  const sy = img.naturalHeight / data.image_size.height;

  // Part boxes — blue
  (data.parts || []).forEach((p) => {
    const [x1, y1, x2, y2] = p.box.map((v, i) => v * (i % 2 === 0 ? sx : sy));
    ctx.strokeStyle = "#3498db";
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.fillStyle = "#3498db22";
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px system-ui";
    ctx.fillText(p.name.replace(/_/g, " "), x1 + 4, y1 + 14);
  });

  // Damage boxes — red
  (data.damages || []).forEach((d) => {
    const [x1, y1, x2, y2] = d.box.map((v, i) => v * (i % 2 === 0 ? sx : sy));
    ctx.strokeStyle = "#e74c3c";
    ctx.lineWidth = 3;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const lbl = d.type.replace(/_/g, " ");
    const tw = ctx.measureText(lbl).width;
    ctx.fillStyle = "#e74c3c";
    ctx.fillRect(x1, y1 - 20, tw + 10, 20);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px system-ui";
    ctx.fillText(lbl, x1 + 5, y1 - 5);
  });
}

// ── Reset ──────────────────────────────────────────────
function resetDamage() {
  selectedFile = null;
  document.getElementById("preview").src = "";
  document.getElementById("file-in").value = "";
  document.getElementById("cam-in").value = "";
  hide("preview-wrap");
  show("drop-zone");
  show("upload-btn"); // ← show upload button again
  show("cam-btn");
  document.getElementById("analyse-btn").disabled = true;
  hide("reset-btn");
  clearResults();
}

function clearResults() {
  [
    "severity-badge",
    "prob-bars",
    "damage-section",
    "parts-section",
    "error-box",
  ].forEach((id) => hide(id));
  const cv = document.getElementById("overlay");
  if (cv) cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
}

function show(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "block";
}
function hide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "none";
}
