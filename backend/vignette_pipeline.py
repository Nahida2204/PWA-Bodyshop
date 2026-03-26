"""
vignette_pipeline.py
────────────────────
Vignette detection, OCR, VIN decode.
Exposes a single function:  scan_vignette(img: PIL.Image) -> dict

Designed to run in the same FastAPI process as the damage pipeline,
but completely independent — no shared state.
"""

import cv2
import re
import numpy as np
from difflib import get_close_matches
from PIL import Image
from pathlib import Path

# ── Model paths ───────────────────────────────────────────────────────────────
import os
BASE        = r"C:\Users\23052\OneDrive - Middlesex University\Desktop\PWA-Bodyshop\PWA-Bodyshop\models"
YOLO_PATH   = os.path.join(BASE, "vignette.pt")   # your vignette YOLO model

# ── Lazy imports (heavy libs only loaded if this module is used) ──────────────
_yolo_model  = None
_ocr_reader  = None

def _get_yolo():
    global _yolo_model
    if _yolo_model is None:
        from ultralytics import YOLO
        _yolo_model = YOLO(YOLO_PATH)
    return _yolo_model

def _get_reader():
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr
        _ocr_reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    return _ocr_reader


# ══════════════════════════════════════════════════════════════════════════════
#  VIN DATA TABLES
# ══════════════════════════════════════════════════════════════════════════════

KIA_PREFIX = {
    "KNA": "Kia", "KNH": "Kia", "KNC": "Kia",
    "U5Y": "Kia", "MZB": "Kia", "LJD": "Kia",
}

YEAR_CODES = {
    "A":2010,"B":2011,"C":2012,"D":2013,"E":2014,
    "F":2015,"G":2016,"H":2017,"J":2018,"K":2019,
    "L":2020,"M":2021,"N":2022,"P":2023,"R":2024,
    "S":2025,"T":2026,
}

KIA_MODELS = {
    "B351":"Picanto",        "DCS":"Rio",
    "PH8":"Sportage",        "PX8":"Sportage Hybrid",
    "PU8":"Sportage Diesel", "PK8":"Sportage GT",
    "ER8":"Seltos",          "FB8":"Sonet",
    "MF3":"Carnival",        "NB3":"Carnival",
    "GB8":"Carens",          "RH8":"Sorento",
    "CB8":"Niro",            "D68":"Stonic",
    "JP8":"Soul",            "JT8":"Soul",
}

# Models that map to LARGE size (Grande Taille) for pricing
KIA_LARGE_MODELS = {
    "Sorento", "Carnival", "Stinger", "EV6", "EV9",
    "K5", "K8", "Telluride",
}

DIGIT_CORRECTIONS = {
    "O":"0","Q":"0","I":"1","Z":"2","S":"5","B":"8","G":"6",
}


# ══════════════════════════════════════════════════════════════════════════════
#  VIN DECODE
# ══════════════════════════════════════════════════════════════════════════════

def _clean_vin(raw: str) -> str:
    raw = re.sub(r"[^A-Z0-9]", "", raw.upper())
    if len(raw) < 17:
        return raw
    chars = list(raw[:17])
    for i in range(11, 17):                          # positions 11-16 = digits
        chars[i] = DIGIT_CORRECTIONS.get(chars[i], chars[i])
    return "".join(chars)


def _find_vin(raw_texts: list[tuple]) -> str | None:
    candidates = []
    for _, text, _ in raw_texts:
        cleaned = re.sub(r"[^A-Z0-9]", "", text.upper())
        if 15 <= len(cleaned) <= 18:
            candidates.append(cleaned)
    candidates.sort(
        key=lambda c: 1 if c[:3] in KIA_PREFIX else 0,
        reverse=True,
    )
    for c in candidates:
        if len(c) >= 17:
            return _clean_vin(c[:17])
    return None


def _decode_vin(vin: str | None) -> dict:
    if not vin:
        return {"make": None, "model": None, "year": None, "vehicle_size": None}

    # Make
    prefix = vin[:3]
    make_match = get_close_matches(prefix, KIA_PREFIX.keys(), n=1, cutoff=0.6)
    make = KIA_PREFIX[make_match[0]] if make_match else None

    # Model
    code = vin[3:6]
    model_match = get_close_matches(code, KIA_MODELS.keys(), n=1, cutoff=0.5)
    model = KIA_MODELS[model_match[0]] if model_match else None

    # Year
    year_char = vin[9] if len(vin) > 9 else None
    year = YEAR_CODES.get(year_char)
    if not year and year_char:
        yr_match = get_close_matches(year_char, YEAR_CODES.keys(), n=1, cutoff=0.5)
        year = YEAR_CODES[yr_match[0]] if yr_match else None

    # Vehicle size for pricing
    vehicle_size = None
    if model:
        vehicle_size = "large" if model in KIA_LARGE_MODELS else "medium"

    return {
        "make":         make,
        "model":        model,
        "year":         year,
        "vehicle_size": vehicle_size,
    }


# ══════════════════════════════════════════════════════════════════════════════
#  FIELD EXTRACTION
# ══════════════════════════════════════════════════════════════════════════════

def _join(raw_texts):
    return " ".join(t for _, t, _ in raw_texts)


def _find(pattern, text, group=1):
    m = re.search(pattern, text, re.IGNORECASE)
    return m.group(group).strip() if m else None


def _extract_fields(raw_texts: list[tuple]) -> dict:
    full = _join(raw_texts)

    policy_no = _find(
        r"Policy\s*(?:No|number|No\.?)[:\s]+([A-Z0-9/\-]+)", full)

    make_model = _find(
        r"(?:Make[/\s&]*(?:Model|Type|and\s*Type))[:\s]+"
        r"((?:[A-Z][A-Z0-9\s]+?))"
        r"(?=\s*(?:PRIVATE|COMMERCIAL|MOTORCYCLE|Chassis|Registration|$))",
        full)

    registration = _find(
        r"Registration\s*(?:Mark|mark|No|number)?[:\s]+([A-Z0-9]+)", full)

    chassis_raw = _find(
        r"Chassis\s*(?:No|number|No\.?)[:\s]+([A-Z0-9]+)", full)

    exp_date = _find(
        r"(?:Date\s*of\s*[Ee]xpir[yi]|Expiry\s*Date)[:\s]+([\d\-]+)", full)

    insurer = _find(
        r"(JUBILEE|ALLIANZ|MAURITIUS\s*UNION|SWAN|PHOENIX|SICOM"
        r"|CIM|MUA|GENERAL\s*INSURANCE)[^\n]*",
        full)

    # VIN
    vin = None
    if chassis_raw:
        cleaned = re.sub(r"[^A-Z0-9]", "", chassis_raw.upper())
        if len(cleaned) >= 17:
            vin = _clean_vin(cleaned[:17])
    if not vin:
        vin = _find_vin(raw_texts)

    vin_data = _decode_vin(vin)

    # OCR make/model override
    if make_model and make_model.strip():
        parts = make_model.strip().split()
        ocr_make  = parts[0]
        ocr_model = " ".join(parts[1:])
        if ocr_make.upper() in ("KIA","TOYOTA","NISSAN","HONDA",
                                 "SUZUKI","MITSUBISHI","HYUNDAI"):
            vin_data["make"] = ocr_make.capitalize()
        if len(ocr_model) > 2:
            vin_data["model"] = ocr_model
            vin_data["vehicle_size"] = (
                "large" if ocr_model in KIA_LARGE_MODELS else "medium"
            )

    return {
        "policy_no":    policy_no,
        "registration": registration,
        "chassis_no":   chassis_raw,
        "expiry_date":  exp_date,
        "insurer":      insurer,
        "vin":          vin,
        **vin_data,     # make, model, year, vehicle_size
    }


# ══════════════════════════════════════════════════════════════════════════════
#  IMAGE PROCESSING
# ══════════════════════════════════════════════════════════════════════════════

def _upscale(img, target_h=600):
    h = img.shape[0]
    if h < target_h:
        s = target_h / h
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    return img


def _clahe(gray, clip=2.0, tile=8):
    return cv2.createCLAHE(
        clipLimit=clip, tileGridSize=(tile, tile)
    ).apply(gray)


def _remove_glare(img_bgr):
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    thr  = int(np.percentile(l, 85))
    mask = np.where(l >= thr, 255, 0).astype(np.uint8)
    k    = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    mask = cv2.dilate(mask, k, iterations=2)
    if np.count_nonzero(mask) / mask.size > 0.40:
        return img_bgr
    return cv2.inpaint(img_bgr, mask, inpaintRadius=7, flags=cv2.INPAINT_TELEA)


def _assess_quality(gray):
    brightness = float(np.mean(gray))
    contrast   = float(np.std(gray))
    sharpness  = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    glare      = float(np.count_nonzero(gray > 230)) / gray.size
    return {
        "is_dark":   brightness < 80,
        "is_blurry": sharpness < 100,
        "has_glare": glare > 0.05,
        "is_good":   contrast > 40 and sharpness > 200 and glare < 0.10,
    }


def _build_variants(crop_bgr):
    crop_bgr = _upscale(crop_bgr)
    gray     = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    q        = _assess_quality(gray)
    variants = {}

    variants["gray_clahe"]      = _clahe(gray, 2.0)
    variants["gray_clahe_mild"] = _clahe(gray, 1.0)
    k_sharp = np.array([[0,-1,0],[-1,5,-1],[0,-1,0]])
    variants["sharpened"] = np.clip(
        cv2.filter2D(_clahe(gray, 1.5), -1, k_sharp), 0, 255
    ).astype(np.uint8)
    variants["denoised"] = cv2.fastNlMeansDenoising(
        _clahe(gray, 2.0), h=10, templateWindowSize=7, searchWindowSize=21)

    if q["is_good"]:
        _, otsu = cv2.threshold(
            _clahe(gray, 1.5), 0, 255,
            cv2.THRESH_BINARY + cv2.THRESH_OTSU,
        )
        variants["otsu_gentle"] = otsu
        return variants

    bgr = crop_bgr
    if q["has_glare"]:
        bgr  = _remove_glare(bgr)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if q["is_dark"]:
        lut  = np.array([((i/255)**0.5)*255 for i in range(256)], np.uint8)
        gray = cv2.LUT(gray, lut)

    g = cv2.bilateralFilter(_clahe(gray, 3.0), 9, 75, 75)
    variants["adaptive_31"] = cv2.adaptiveThreshold(
        g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 10)
    variants["adaptive_15"] = cv2.adaptiveThreshold(
        g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 15, 8)
    _, otsu = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants["otsu"] = otsu

    return variants


def _ocr_score(img, reader):
    try:
        out = reader.readtext(img, detail=1, paragraph=False)
        if not out:
            return 0.0, []
        confs = [x[2] for x in out]
        return float(np.mean(confs)) * np.log1p(len(out)), \
               [(x[0], x[1], x[2]) for x in out]
    except Exception:
        return 0.0, []


def _best_ocr(crop_bgr, reader):
    variants   = _build_variants(crop_bgr)
    best_score = -1.0
    best_texts = []
    for name, img in variants.items():
        score, texts = _ocr_score(img, reader)
        if score > best_score:
            best_score = score
            best_texts = texts
    return best_texts


def _nms(boxes_list, confs_list, iou_thr=0.4):
    if not boxes_list:
        return np.array([]), np.array([])
    boxes = np.array(boxes_list, np.float32)
    confs = np.array(confs_list, np.float32)
    x1,y1,x2,y2 = boxes[:,0],boxes[:,1],boxes[:,2],boxes[:,3]
    areas = (x2-x1)*(y2-y1)
    order, keep = confs.argsort()[::-1], []
    while order.size:
        i = order[0]; keep.append(i)
        ix1 = np.maximum(x1[i], x1[order[1:]])
        iy1 = np.maximum(y1[i], y1[order[1:]])
        ix2 = np.minimum(x2[i], x2[order[1:]])
        iy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0,ix2-ix1)*np.maximum(0,iy2-iy1)
        iou   = inter/(areas[i]+areas[order[1:]]-inter+1e-6)
        order = order[1:][iou < iou_thr]
    return boxes[keep], confs[keep]


# ══════════════════════════════════════════════════════════════════════════════
#  PUBLIC ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

def scan_vignette(img: Image.Image) -> dict:
    """
    Process a vignette photo and return decoded vehicle info.

    Returns:
    {
        "success":      bool,
        "error":        str | None,
        "vin":          str | None,
        "make":         str | None,   e.g. "Kia"
        "model":        str | None,   e.g. "Sportage"
        "year":         int | None,   e.g. 2022
        "vehicle_size": str | None,   "medium" | "large"
        "policy_no":    str | None,
        "registration": str | None,
        "chassis_no":   str | None,
        "expiry_date":  str | None,
        "insurer":      str | None,
        "detection_confidence": float | None,
    }
    """
    try:
        img_bgr = cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2BGR)
        yolo    = _get_yolo()
        reader  = _get_reader()

        # ── YOLO detection (try progressively lower thresholds) ─────────────
        crop = None
        conf = 0.0
        all_boxes, all_confs = [], []

        for threshold in [0.25, 0.10, 0.05, 0.01]:
            res = yolo(img_bgr, conf=threshold, verbose=False)[0]
            bs  = res.boxes.xyxy.cpu().numpy().tolist()
            cs  = res.boxes.conf.cpu().numpy().tolist()
            print(f"  YOLO conf={threshold}  ->  {len(bs)} detection(s)  {[round(c,3) for c in cs]}")
            all_boxes.extend(bs)
            all_confs.extend(cs)
            if bs:
                break  # found something, stop lowering threshold

        boxes, confs = _nms(all_boxes, all_confs)

        if len(boxes) > 0:
            best_idx     = int(np.argmax(confs))
            x1,y1,x2,y2 = map(int, boxes[best_idx])
            conf         = float(confs[best_idx])
            pad          = 15
            crop = img_bgr[
                max(0, y1-pad) : min(img_bgr.shape[0], y2+pad),
                max(0, x1-pad) : min(img_bgr.shape[1], x2+pad),
            ]
            print(f"  Vignette crop: {x1},{y1} -> {x2},{y2}  conf={conf:.3f}")
        else:
            # Fallback: no detection — OCR the whole image
            # Handles dashboard shots where card is not isolated
            print("  No YOLO detection — falling back to full-image OCR")
            crop = img_bgr
            conf = 0.0

        # ── OCR ───────────────────────────────────────────────────────────────
        raw_texts = _best_ocr(crop, reader)
        print(f"  OCR words: {len(raw_texts)}")
        for _, text, c in raw_texts:
            print(f"    [{c:.2f}] {text}")

        if not raw_texts:
            return {
                "success": False,
                "error":   "Could not read any text. Try a clearer, well-lit photo.",
                **_empty_fields(),
            }

        # ── Field extraction ──────────────────────────────────────────────────
        fields = _extract_fields(raw_texts)

        has_useful = any(fields.get(k) for k in
                         ("vin", "make", "model", "policy_no", "registration",
                          "make_model_raw", "chassis_no"))

        return {
            "success":              has_useful,
            "error":                None if has_useful else
                                    "Could not extract vehicle details. "
                                    "Try a closer, flatter photo of the vignette.",
            "detection_confidence": conf,
            **fields,
        }

    except Exception as e:
        import traceback
        return {
            "success": False,
            "error":   f"Vignette processing failed: {str(e)}",
            **_empty_fields(),
        }


def _empty_fields():
    return {
        "vin": None, "make": None, "model": None,
        "year": None, "vehicle_size": None,
        "policy_no": None, "registration": None,
        "chassis_no": None, "expiry_date": None, "insurer": None,
        "detection_confidence": None,
    }