import torch, torch.nn as nn
from torchvision import models
from ultralytics import YOLO
from PIL import Image
import numpy as np
import albumentations as A
from albumentations.pytorch import ToTensorV2
import os

# ── CONFIG ────────────────────────────────────────────────────────────────────

BASE          = r"C:\Users\23052\OneDrive - Middlesex University\Desktop\PWA-Bodyshop\PWA-Bodyshop\models"
MAIN_PATH     = os.path.join(BASE, "main.pt")
VEHIDE_PATH   = os.path.join(BASE, "vehide.pt")
PARTS_PATH    = os.path.join(BASE, "car_part.pt")
SEVERITY_PATH = os.path.join(BASE, "resnet50_severity_best.pth")

CLASS_NAMES     = ['minor', 'moderate', 'severe']
TRIGGER_CLASSES = {
    # Generic damage descriptors
    "damaged", "dent", "scratch", "dent-or-scratch",
    "scratchdent", "medium-bodypanel-dent", "pillar-dent",
    # Localised — name the part directly, each gets its own stage2 region
    "damaged-front-bumper", "front-bumper-dent",
    "damaged-rear-bumper",  "rear-bumper-dent", "major-rear-bumper-dent",
    "damaged-hood",         "bonnet-dent",
    "damaged-trunk",
    "damaged-door",         "doorouter-dent",
    "fender-dent",          "quaterpanel-dent",
    "roof-dent",
    "runningboard-dent",
    "sidemirror-damage",
    # Lights and glass
    "damaged-head-light", "damaged-tail-light",
    "damaged-window",     "damaged-windscreen",   "damaged-rear-window",
    "front-windscreen-damage", "rear-windscreen-damage",
    "headlight-damage",   "taillight-damage",     "signlight-damage",
}
IMG_SIZE        = 224
DEVICE          = torch.device('cpu')

# ── LOAD MODELS ───────────────────────────────────────────────────────────────

print("Loading models...")

main_model   = YOLO(MAIN_PATH)
vehide_model = YOLO(VEHIDE_PATH)
parts_model  = YOLO(PARTS_PATH)

severity_model = models.resnet50(weights=None)
severity_model.fc = nn.Sequential(
    nn.BatchNorm1d(severity_model.fc.in_features), nn.Dropout(0.4),
    nn.Linear(severity_model.fc.in_features, 512), nn.ReLU(),
    nn.BatchNorm1d(512), nn.Dropout(0.3), nn.Linear(512, 3)
)
severity_model.load_state_dict(torch.load(SEVERITY_PATH, map_location=DEVICE))
severity_model = severity_model.to(DEVICE).eval()

severity_tf = A.Compose([
    A.Resize(IMG_SIZE, IMG_SIZE),
    A.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ToTensorV2(),
])

print("✅ All models loaded")

# ── HELPERS ───────────────────────────────────────────────────────────────────

def dedup(boxes, thresh=0.5):
    """Non-maximum suppression deduplication."""
    if boxes is None or len(boxes) == 0:
        return boxes
    xyxy  = boxes.xyxy.cpu().numpy()
    confs = boxes.conf.cpu().numpy()
    order = confs.argsort()[::-1]
    keep  = []
    while len(order):
        i = order[0]
        keep.append(i)
        if len(order) == 1:
            break
        rest  = order[1:]
        inter = (
            np.maximum(0, np.minimum(xyxy[i,2], xyxy[rest,2]) - np.maximum(xyxy[i,0], xyxy[rest,0])) *
            np.maximum(0, np.minimum(xyxy[i,3], xyxy[rest,3]) - np.maximum(xyxy[i,1], xyxy[rest,1]))
        )
        areas = (
            (xyxy[i,2]    - xyxy[i,0])    * (xyxy[i,3]    - xyxy[i,1]) +
            (xyxy[rest,2] - xyxy[rest,0]) * (xyxy[rest,3] - xyxy[rest,1])
        )
        iou   = inter / (areas - inter + 1e-6)
        order = rest[iou < thresh]
    return boxes[keep]


def box_iod(dmg_box, part_box):
    """
    Intersection over Damage-area (IoD).
    Measures what fraction of the damage box is covered by the part box.
    Range 0–1. Higher = damage is more inside this part.
    """
    dx1, dy1, dx2, dy2 = dmg_box
    px1, py1, px2, py2 = part_box
    inter_w = max(0, min(dx2, px2) - max(dx1, px1))
    inter_h = max(0, min(dy2, py2) - max(dy1, py1))
    inter   = inter_w * inter_h
    dmg_area = max(1, (dx2 - dx1) * (dy2 - dy1))
    return inter / dmg_area


def find_best_part(dmg_box, parts):
    """
    Match a damage bounding box to the best car part using IoD.
    Falls back to nearest centroid if no overlap found.

    Returns (part_name, overlap_pct)
    """
    best_name = 'unknown'
    best_iod  = 0.0

    for p in parts:
        iod = box_iod(dmg_box, p['box'])
        if iod > best_iod:
            best_iod  = iod
            best_name = p['name']

    # Centroid fallback — no overlap at all
    if best_name == 'unknown' and parts:
        dx1, dy1, dx2, dy2 = dmg_box
        dcx, dcy = (dx1 + dx2) / 2, (dy1 + dy2) / 2
        best_name = min(
            parts,
            key=lambda p: (
                (dcx - (p['box'][0] + p['box'][2]) / 2) ** 2 +
                (dcy - (p['box'][1] + p['box'][3]) / 2) ** 2
            ) ** 0.5
        )['name']

    return best_name, round(best_iod * 100)


def classify_severity(img: Image.Image) -> dict:
    arr = np.array(img.convert('RGB'))
    t   = severity_tf(image=arr)['image'].unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        p = torch.softmax(severity_model(t), dim=1)[0].cpu().numpy()
    return {
        'class':         CLASS_NAMES[p.argmax()],
        'confidence':    round(float(p.max()), 3),
        'probabilities': {CLASS_NAMES[i]: round(float(p[i]), 3) for i in range(3)},
    }


def padded_crop(img_np, box, pad=20):
    h, w = img_np.shape[:2]
    x1 = max(0, box[0] - pad);  y1 = max(0, box[1] - pad)
    x2 = min(w, box[2] + pad);  y2 = min(h, box[3] + pad)
    return img_np[y1:y2, x1:x2], (x1, y1)


def yolo_to_list(boxes, names, offset=(0, 0)):
    """Convert YOLO boxes tensor → list of dicts, with optional xy offset."""
    ox, oy = offset
    result = []
    if boxes is None:
        return result
    for b in boxes:
        cls  = names[int(b.cls[0])].lower().strip()
        conf = round(float(b.conf[0]), 3)
        box  = b.xyxy[0].cpu().numpy().astype(int).tolist()
        result.append({
            'type': cls,
            'conf': conf,
            'box':  [box[0] + ox, box[1] + oy, box[2] + ox, box[3] + oy],
        })
    return result

# ── MAIN ENTRY POINT ──────────────────────────────────────────────────────────

def run_pipeline(img: Image.Image) -> dict:
    img_np = np.array(img.convert('RGB'))
    W, H   = img.size

    # ── Stage 1: severity + main.pt on full image ─────────────────────────────
    s1_severity   = classify_severity(img)
    mb            = dedup(main_model(img_np, conf=0.07, iou=0.4, verbose=False)[0].boxes)
    s1_detections = yolo_to_list(mb, main_model.names)

    triggers = [d for d in s1_detections if d['type'] in TRIGGER_CLASSES]

    # Fallback: if no trigger-class detections, treat ALL detections as triggers
    if not triggers and s1_detections:
        triggers = s1_detections

    # Last resort: run stage 2 on full image
    if not triggers:
        triggers = [{'type': 'full_image', 'conf': 1.0, 'box': [0, 0, W, H]}]

    # ── Run car_part.pt ONCE on the full image ────────────────────────────────
    pb           = dedup(parts_model(img_np, conf=0.25, iou=0.4, verbose=False)[0].boxes)
    all_parts    = []
    if pb is not None:
        for i, b in enumerate(pb):
            cls  = parts_model.names[int(b.cls[0])].lower().strip()
            conf = round(float(b.conf[0]), 3)
            box  = b.xyxy[0].cpu().numpy().astype(int).tolist()
            all_parts.append({
                'idx':  i + 1,
                'name': cls,
                'conf': conf,
                'box':  box,
            })

    # ── Stage 2: per-trigger crop → vehide.pt + severity ─────────────────────
    stage2 = []

    for trig in triggers:
        crop_np, (ox, oy) = padded_crop(img_np, trig['box'])
        crop_pil          = Image.fromarray(crop_np)

        # Severity on this crop
        crop_severity = classify_severity(crop_pil)

        # vehide.pt on crop (offset boxes back to full-image coords)
        vb          = dedup(vehide_model(crop_np, conf=0.08, iou=0.4, verbose=False)[0].boxes)
        vehide_dets = yolo_to_list(vb, vehide_model.names, offset=(ox, oy))

        # Filter all_parts to only those that overlap with this trigger region
        # — gives cleaner part chips per region in the UI
        tx1, ty1, tx2, ty2 = trig['box']
        region_parts = [
            p for p in all_parts
            if box_iod(p['box'], [tx1, ty1, tx2, ty2]) > 0.10  # part at least 10% inside trigger
            or box_iod([tx1, ty1, tx2, ty2], p['box']) > 0.10  # trigger at least 10% inside part
        ]

        # If no parts overlap trigger region, fall back to all detected parts
        if not region_parts:
            region_parts = all_parts

        # Match each vehide damage box → best car part (full-image coords)
        for vdet in vehide_dets:
            part_name, overlap = find_best_part(vdet['box'], all_parts)
            vdet['on_part']     = part_name
            vdet['overlap_pct'] = overlap

        # Skip completely empty regions (no vehide detections)
        if not vehide_dets:
            continue

        # Use the MORE SEVERE of crop vs full-image severity.
        # Crop is better for localised damage; full-image catches overall context.
        # Never downgrade a high-severity crop just because the full image is minor.
        SEVERITY_RANK = {'minor': 0, 'moderate': 1, 'severe': 2}
        crop_rank     = SEVERITY_RANK.get(crop_severity['class'], 0)
        s1_rank       = SEVERITY_RANK.get(s1_severity['class'], 0)
        if s1_rank > crop_rank:
            crop_severity = s1_severity   # full image is worse — use it
        # else keep crop_severity (localised damage is worse than overall)

        # Deduplicate region_parts by name (car_part.pt can detect same part twice)
        seen_part_names = set()
        unique_parts = []
        for p in region_parts:
            if p['name'] not in seen_part_names:
                seen_part_names.add(p['name'])
                unique_parts.append(p)

        stage2.append({
            'triggered_by': trig,
            'severity':     crop_severity,
            'damages':      vehide_dets,
            'parts':        unique_parts,
        })

    return {
        'image_size': {'width': W, 'height': H},
        'stage1': {
            'severity':   s1_severity,
            'detections': s1_detections,
        },
        'stage2':    stage2,
        'all_parts': all_parts,   # full list available if frontend needs it
    }