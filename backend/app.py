from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import uvicorn, io, asyncio, logging, time, traceback, os, re
from PIL import Image, UnidentifiedImageError
from pipeline import run_pipeline
from vignette_pipeline import (
    scan_vignette, _clean_vin, _decode_vin, _find_vin
)
from concurrent.futures import ThreadPoolExecutor

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("app")

# ── Storage folders ───────────────────────────────────────────────────────────
IMAGES_DIR      = os.path.join(os.path.dirname(__file__), "inspection_images")
INSPECTIONS_DIR = os.path.join(os.path.dirname(__file__), "inspections")
SPARE_PARTS_CSV = os.path.join(os.path.dirname(__file__), "spare_parts_prices.csv")
os.makedirs(IMAGES_DIR,      exist_ok=True)
os.makedirs(INSPECTIONS_DIR, exist_ok=True)

# ── Shared thread pool ────────────────────────────────────────────────────────
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="pipeline")

# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(" Server starting up")
    yield
    log.info("Shutting down")
    _executor.shutdown(wait=False)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="PWA Bodyshop — Damage Detection API",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Serve saved inspection images statically
app.mount("/inspection-images", StaticFiles(directory=IMAGES_DIR), name="images")

MAX_FILE_BYTES = 20 * 1024 * 1024


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _read_image(file: UploadFile) -> tuple[Image.Image, bytes]:
    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415,
            detail=f"Expected image, got '{file.content_type}'")
    contents = await file.read()
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413,
            detail=f"File too large ({len(contents)//1024} KB). Max 20 MB.")
    try:
        return Image.open(io.BytesIO(contents)).convert("RGB"), contents
    except UnidentifiedImageError:
        raise HTTPException(status_code=422, detail="Could not decode image.")
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Image decode error: {e}")


async def _run_in_pool(fn, *args):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, fn, *args)


# ── /health ───────────────────────────────────────────────────────────────────
@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok"}


# ── /scan-vignette ────────────────────────────────────────────────────────────
@app.post("/scan-vignette", tags=["vignette"])
async def scan_vignette_endpoint(file: UploadFile = File(...)):
    """Scan insurance vignette image, return decoded vehicle info."""
    img, _ = await _read_image(file)
    log.info("🪪 Vignette — %s  %dx%d", file.filename or "upload", img.width, img.height)

    t0 = time.perf_counter()
    try:
        result = await _run_in_pool(scan_vignette, img)
    except Exception:
        log.error("Vignette error:\n%s", traceback.format_exc())
        raise HTTPException(status_code=500, detail="Vignette processing failed.")

    elapsed = time.perf_counter() - t0
    log.info("%s Vignette %.2fs — %s %s %s",
        "✅" if result.get("success") else "⚠️", elapsed,
        result.get("make"), result.get("model"), result.get("year"))
    return JSONResponse(content=result)


# ── /decode-vin ───────────────────────────────────────────────────────────────
@app.get("/decode-vin", tags=["vignette"])
async def decode_vin_endpoint(vin: str):
    """
    Decode a VIN using the same logic as the vignette pipeline.

    Accepts:
      KNADBSI8LN6669278        full 17-char VIN
      KNAD-BSI8-LN66-69278     dashes/spaces stripped automatically
      KNA0BS18LN6669278        OCR noise corrected (O->0, I->1 at pos 11-16)
      KNADBSI8LN6              partial — make + model decoded, year if pos 9 present
    """
    raw = vin.strip().upper()
    if not raw:
        raise HTTPException(status_code=422, detail="VIN is required.")

    stripped = re.sub(r"[^A-Z0-9]", "", raw)
    if len(stripped) < 3:
        raise HTTPException(status_code=422,
            detail="Enter at least the first 3 characters of the VIN.")

    result_vin = stripped
    decoded    = {"make": None, "model": None, "year": None, "vehicle_size": None}

    # Pass 1: _clean_vin + _decode_vin directly (mirrors chassis_raw path)
    candidate = _clean_vin(stripped) if len(stripped) >= 17 else stripped
    decoded   = _decode_vin(candidate.ljust(17, "X"))
    result_vin = stripped

    # Pass 2: _find_vin on the stripped string as a single OCR token
    if not any(decoded.get(k) for k in ("make", "model")):
        found = _find_vin([([0, 0, 0, 0], stripped, 0.9)])
        if found:
            decoded    = _decode_vin(found)
            result_vin = found

    # Pass 3: _find_vin on space-separated segments (e.g. "KNAD BSI8 LN6669278")
    if not any(decoded.get(k) for k in ("make", "model")) and " " in raw:
        tokens = [([0, 0, 0, 0], seg, 0.9) for seg in raw.split()]
        found  = _find_vin(tokens)
        if found:
            decoded    = _decode_vin(found)
            result_vin = found

    # Pass 4: concatenate segments and retry as full VIN
    if not any(decoded.get(k) for k in ("make", "model")) and " " in raw:
        concat = re.sub(r"[^A-Z0-9]", "", raw)
        if len(concat) >= 17:
            cleaned    = _clean_vin(concat[:17])
            decoded    = _decode_vin(cleaned)
            result_vin = cleaned

    has_data = any(decoded.get(k) for k in ("make", "model", "year"))

    return JSONResponse(content={
        "success": has_data,
        "vin":     result_vin,
        "error":   None if has_data else (
            "Could not identify make or model. "
            "Check the VIN or use the manual entry tab."
        ),
        **decoded,
    })


# ── /spare-parts ──────────────────────────────────────────────────────────────
@app.get("/spare-parts", tags=["vehicles"])
def get_spare_parts(model: str = Query(default=None, description="Vehicle model slug e.g. 'sportage'")):
    """
    Return spare parts replacement prices for a given vehicle model.
    Reads from spare_parts_prices.csv next to this file.

    ?model=sportage  → { "front_bumper": { "label": "...", "price": 22000 }, ... }
    ?model=          → all rows (for admin / autocomplete use)
    """
    import csv as _csv

    if not os.path.exists(SPARE_PARTS_CSV):
        raise HTTPException(status_code=503, detail="Spare parts price file not found on server.")

    model_key = (model or "").strip().lower()
    results   = {}

    with open(SPARE_PARTS_CSV, newline="", encoding="utf-8") as f:
        reader = _csv.DictReader(f)
        for row in reader:
            if model_key and row["model"].strip().lower() != model_key:
                continue
            results[row["part_key"].strip()] = {
                "label": row["part_label"].strip(),
                "price": int(row["price_mur"]),
                "model": row["model"].strip(),
            }

    return JSONResponse(content=results)


# ── /spare-parts/models ───────────────────────────────────────────────────────
@app.get("/spare-parts/models", tags=["vehicles"])
def list_spare_parts_models():
    """Return the list of models that have spare parts prices in the CSV."""
    import csv as _csv

    if not os.path.exists(SPARE_PARTS_CSV):
        return JSONResponse(content=[])

    seen = []
    with open(SPARE_PARTS_CSV, newline="", encoding="utf-8") as f:
        for row in _csv.DictReader(f):
            m = row["model"].strip().lower()
            if m not in seen:
                seen.append(m)

    return JSONResponse(content=seen)


# ── /predict ──────────────────────────────────────────────────────────────────
@app.post("/predict", tags=["inference"])
async def predict(
    file:         UploadFile = File(...),
    vehicle_data: str        = Query(default=None,
        description="JSON-encoded vignette result from /scan-vignette"),
):
    """Run damage pipeline and return results."""
    img, contents = await _read_image(file)
    log.info("📥 Damage — %s  %dx%d", file.filename or "upload", img.width, img.height)

    import json
    vehicle = None
    if vehicle_data:
        try:
            vehicle = json.loads(vehicle_data)
        except Exception:
            pass

    t0 = time.perf_counter()
    try:
        result = await _run_in_pool(run_pipeline, img)
    except Exception:
        log.error("Pipeline error:\n%s", traceback.format_exc())
        raise HTTPException(status_code=500,
            detail="Pipeline failed — check server logs.")

    elapsed  = time.perf_counter() - t0
    n_stage2 = len(result.get("stage2", []))
    severity = result.get("stage1", {}).get("severity", {}).get("class", "?")
    log.info("✅ Pipeline %.2fs — severity=%s  regions=%d", elapsed, severity, n_stage2)

    return JSONResponse(content=result)


# ── /total-loss ───────────────────────────────────────────────────────────────
@app.get("/total-loss", tags=["vehicles"])
def total_loss_endpoint(
    model:          str = Query(...,            description="e.g. Seltos"),
    vehicle_year:   int = Query(...,            description="Year of registration e.g. 2022"),
    repair_estimate:int = Query(...,            description="FRU repair total excl. VAT (MUR)"),
    accident_year:  int = Query(default=None,   description="Year of accident (defaults to current year)"),
):
    """
    Calculate pre-accident value and total loss decision using model average price.

    Pre-accident value = avg_showroom_price × (0.85 ^ age_years)  [15% reducing balance]
    Total loss if repair_estimate >= 60% of pre-accident value.
    Uses the average showroom price across all variants of the model.
    """
    from vehicle_prices import get_average_price, total_loss_decision

    from vehicle_prices import list_models
    avg = get_average_price(model)

    # Fuzzy fallback — try substring match if exact not found
    if not avg:
        model_lower = model.lower()
        all_models  = list_models()
        match = next((m for m in all_models if model_lower in m.lower()
                      or m.lower() in model_lower), None)
        if match:
            avg = get_average_price(match)

    if not avg:
        return JSONResponse(
            status_code=200,
            content={
                "success":      False,
                "error":        f"Model '{model}' not found in price list. "
                                f"Available: {', '.join(list_models())}",
                "is_total_loss": None,
                "decision":     "UNKNOWN",
            }
        )

    result = total_loss_decision(
        repair_estimate_excl_vat = repair_estimate,
        showroom_price           = avg["avg_showroom_price"],
        vehicle_year             = vehicle_year,
        accident_year            = accident_year,
    )
    result["model"]       = avg["model"]
    result["price_basis"] = "average showroom price"
    return JSONResponse(content=result)


# ── /inspections — save ───────────────────────────────────────────────────────
@app.post("/inspections", tags=["history"])
async def save_inspection_endpoint(payload: dict):
    """
    Save a completed inspection to disk as a JSON file.
    Called by the frontend Save button after estimate is built.

    Expected payload:
    {
      "vehicle":   { make, model, year, vin, registration },
      "severity":  "moderate",
      "estimate":  { subtotal, vat, total, listType, items: [...] },
      "total_loss": { decision, pre_accident_value, repair_pct_of_pav, ... } | null,
      "image_path": "..." | null
    }
    """
    import uuid, json
    from datetime import datetime, timezone

    inspection_id = str(uuid.uuid4())[:8].upper()
    now           = datetime.now(timezone.utc).isoformat()

    record = {
        "id":         inspection_id,
        "created_at": now,
        **payload,
    }

    path = os.path.join(INSPECTIONS_DIR, f"{inspection_id}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)

    log.info("💾 Saved inspection %s — %s %s Rs %s",
        inspection_id,
        payload.get("vehicle", {}).get("make", "?"),
        payload.get("vehicle", {}).get("model", "?"),
        payload.get("estimate", {}).get("total", "?"),
    )

    return JSONResponse(content={"id": inspection_id, "created_at": now})


# ── /inspections — list ────────────────────────────────────────────────────────
@app.get("/inspections", tags=["history"])
def list_inspections_endpoint(limit: int = Query(default=50, ge=1, le=200)):
    """Return list of saved inspections, newest first (summary only)."""
    import json, glob

    files = sorted(
        glob.glob(os.path.join(INSPECTIONS_DIR, "*.json")),
        key=os.path.getmtime,
        reverse=True,
    )[:limit]

    summaries = []
    for f in files:
        try:
            with open(f, encoding="utf-8") as fh:
                data = json.load(fh)
            summaries.append({
                "id":         data.get("id"),
                "created_at": data.get("created_at"),
                "vehicle":    data.get("vehicle", {}),
                "severity":   data.get("severity"),
                "total":      data.get("estimate", {}).get("total"),
                "decision":   data.get("total_loss", {}).get("decision") if data.get("total_loss") else None,
            })
        except Exception:
            continue

    return JSONResponse(content=summaries)


# ── /inspections/{id} — detail ────────────────────────────────────────────────
@app.get("/inspections/{inspection_id}", tags=["history"])
def get_inspection_endpoint(inspection_id: str):
    """Return full detail for one inspection."""
    import json

    path = os.path.join(INSPECTIONS_DIR, f"{inspection_id.upper()}.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Inspection not found.")

    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    return JSONResponse(content=data)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=8000,
                reload=False, log_level="info")