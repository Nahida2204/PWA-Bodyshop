from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import uvicorn, io, asyncio, logging, time, traceback
from PIL import Image, UnidentifiedImageError
from pipeline import run_pipeline
from vignette_pipeline import scan_vignette
from concurrent.futures import ThreadPoolExecutor

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("app")

# ── Shared thread pool ────────────────────────────────────────────────────────
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="pipeline")

# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("🚀 Server starting up")
    yield
    log.info("🛑 Shutting down — closing thread pool")
    _executor.shutdown(wait=False)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="PWA Bodyshop — Damage Detection API",
    version="2.0.0",
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

MAX_FILE_BYTES = 20 * 1024 * 1024   # 20 MB


# ── Shared helpers ────────────────────────────────────────────────────────────

async def _read_image(file: UploadFile) -> Image.Image:
    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(
            status_code=415,
            detail=f"Expected an image file, got '{file.content_type}'",
        )
    contents = await file.read()
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(contents)//1024} KB). Max 20 MB.",
        )
    try:
        return Image.open(io.BytesIO(contents)).convert("RGB")
    except UnidentifiedImageError:
        raise HTTPException(status_code=422, detail="Could not decode image file.")
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
    """
    Step 1 — scan the vehicle vignette (insurance card).
    Returns decoded vehicle info: make, model, year, vehicle_size, VIN, etc.
    Call this BEFORE /predict.
    """
    img = await _read_image(file)
    log.info("🪪 Vignette — %s  %dx%d", file.filename or "upload", img.width, img.height)

    t0 = time.perf_counter()
    try:
        result = await _run_in_pool(scan_vignette, img)
    except Exception:
        log.error("Vignette error:\n%s", traceback.format_exc())
        raise HTTPException(status_code=500,
            detail="Vignette processing failed — check server logs.")

    elapsed = time.perf_counter() - t0
    log.info("%s Vignette %.2fs — make=%s model=%s year=%s size=%s",
        "✅" if result.get("success") else "❌", elapsed,
        result.get("make"), result.get("model"),
        result.get("year"), result.get("vehicle_size"),
    )
    return JSONResponse(content=result)


# ── /predict ──────────────────────────────────────────────────────────────────
@app.post("/predict", tags=["inference"])
async def predict(file: UploadFile = File(...)):
    """
    Step 2 — run the full damage detection pipeline.
    Returns stage1 severity, stage2 per-region damage + parts.
    """
    img = await _read_image(file)
    log.info("📥 Damage — %s  %dx%d", file.filename or "upload", img.width, img.height)

    t0 = time.perf_counter()
    try:
        result = await _run_in_pool(run_pipeline, img)
    except Exception:
        log.error("Pipeline error:\n%s", traceback.format_exc())
        raise HTTPException(status_code=500,
            detail="Pipeline failed — check server logs.")

    elapsed  = time.perf_counter() - t0
    n_stage2 = len(result.get("stage2", []))
    log.info("✅ Damage %.2fs — severity=%s  regions=%d",
        elapsed,
        result.get("stage1", {}).get("severity", {}).get("class", "?"),
        n_stage2,
    )
    return JSONResponse(content=result)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False, log_level="info")