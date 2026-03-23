from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import uvicorn, io, asyncio, logging, time, traceback
from PIL import Image, UnidentifiedImageError
from pipeline import run_pipeline
from concurrent.futures import ThreadPoolExecutor

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("app")

# ── Thread pool (shared, sized to CPU count) ──────────────────────────────────
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="pipeline")

# ── App lifecycle ─────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("🚀 Server starting up")
    yield
    log.info("🛑 Shutting down — closing thread pool")
    _executor.shutdown(wait=False)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="PWA Bodyshop — Damage Detection API",
    version="1.0.0",
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

# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok"}

# ── Predict ───────────────────────────────────────────────────────────────────
MAX_FILE_BYTES = 20 * 1024 * 1024   # 20 MB hard limit

@app.post("/predict", tags=["inference"])
async def predict(file: UploadFile = File(...)):

    # ── Validate content type ─────────────────────────────────────────────
    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(
            status_code=415,
            detail=f"Expected an image file, got '{file.content_type}'",
        )

    # ── Read & size-check ─────────────────────────────────────────────────
    contents = await file.read()
    size_kb   = len(contents) / 1024
    log.info("📥 Received '%s'  %.1f KB", file.filename or "upload", size_kb)

    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({size_kb:.0f} KB). Max 20 MB.",
        )

    # ── Decode image ──────────────────────────────────────────────────────
    try:
        img = Image.open(io.BytesIO(contents)).convert("RGB")
    except UnidentifiedImageError:
        raise HTTPException(status_code=422, detail="Could not decode image file.")
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Image decode error: {e}")

    log.info("🖼  Image size: %dx%d", img.width, img.height)

    # ── Run pipeline in thread pool ───────────────────────────────────────
    t0 = time.perf_counter()
    try:
        loop   = asyncio.get_running_loop()
        result = await loop.run_in_executor(_executor, run_pipeline, img)
    except Exception:
        log.error("Pipeline error:\n%s", traceback.format_exc())
        raise HTTPException(
            status_code=500,
            detail="Pipeline failed — check server logs for details.",
        )

    elapsed = time.perf_counter() - t0
    n_stage2 = len(result.get("stage2", []))
    log.info(
        "✅ Done in %.2fs — severity=%s  stage2_regions=%d",
        elapsed,
        result.get("stage1", {}).get("severity", {}).get("class", "?"),
        n_stage2,
    )

    return JSONResponse(content=result)

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        log_level="info",
    )