from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn, io, asyncio
from PIL import Image
from pipeline import run_pipeline
import concurrent.futures

app = FastAPI()

# ── Fix CORS for mobile ────────────────────────────────
app.add_middleware(CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"]
)

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    contents = await file.read()

    # Run pipeline in thread pool so it doesn't block
    loop = asyncio.get_event_loop()
    with concurrent.futures.ThreadPoolExecutor() as pool:
        img    = Image.open(io.BytesIO(contents)).convert('RGB')
        result = await loop.run_in_executor(pool, run_pipeline, img)

    return JSONResponse(result)

if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)