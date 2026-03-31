import cv2
import torch, torch.nn as nn
from torchvision import models
from ultralytics import YOLO
from PIL import Image
import numpy as np
import albumentations as A
from albumentations.pytorch import ToTensorV2
import os, logging

log = logging.getLogger("pipeline")

# ── CONFIG ────────────────────────────────────────────────────────────────────

BASE          = r"C:\Users\23052\OneDrive - Middlesex University\Desktop\PWA-Bodyshop\PWA-Bodyshop\models"
MAIN_PATH     = os.path.join(BASE, "main.pt")
VEHIDE_PATH   = os.path.join(BASE, "vehide.pt")
PARTS_PATH    = os.path.join(BASE, "car_part.pt")
SEVERITY_PATH = os.path.join(BASE, "resnet50_severity_best.pth")

CLASS_NAMES     = ['minor', 'moderate', 'severe']
TRIGGER_CLASSES = {
    "damaged", "dent", "scratch", "dent-or-scratch",
    "scratchdent", "medium-bodypanel-dent", "pillar-dent",
    "damaged-front-bumper", "front-bumper-dent",
    "damaged-rear-bumper",  "rear-bumper-dent", "major-rear-bumper-dent",
    "damaged-hood",         "bonnet-dent",
    "damaged-trunk",
    "damaged-door",         "doorouter-dent",
    "fender-dent",          "quaterpanel-dent",
    "roof-dent",
    "runningboard-dent",
    "sidemirror-damage",
    "damaged-head-light", "damaged-tail-light",
    "damaged-window",     "damaged-windscreen",   "damaged-rear-window",
    "front-windscreen-damage", "rear-windscreen-damage",
    "headlight-damage",   "taillight-damage",     "signlight-damage",
}
GENERIC_FALLBACK = {'damaged', 'dent', 'scratch', 'scratchdent', 'dent-or-scratch'}
IMG_SIZE         = 224
DEVICE           = torch.device('cpu')
SEV_RANK         = {'minor': 0, 'moderate': 1, 'severe': 2}

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


# ══════════════════════════════════════════════════════════════════════════════
# PREPROCESSING — applied to each image before inference
# Reduces glare, colour bias and contrast issues without multi-variant overhead
# ══════════════════════════════════════════════════════════════════════════════

def preprocess(img_np: np.ndarray) -> np.ndarray:
    """
    Single-pass preprocessing applied to every image.
    - CLAHE in LAB space: boosts local contrast without hue shift
    - Partial desaturation (30%): reduces colour bias on vivid car paint
    - Mild sharpening: makes dent/scratch edges crisper for detectors
    Returns BGR numpy array same shape as input.
    """
    # 1. CLAHE contrast enhancement
    lab = cv2.cvtColor(img_np, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8)).apply(l)
    img_clahe = cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)

    # 2. Glare check — if >8% pixels are blown out, inpaint glare spots
    gray  = cv2.cvtColor(img_clahe, cv2.COLOR_BGR2GRAY)
    glare = float(np.count_nonzero(gray > 230)) / gray.size
    if glare > 0.08:
        mask = np.where(gray >= int(np.percentile(gray, 87)), 255, 0).astype(np.uint8)
        k    = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        mask = cv2.dilate(mask, k, iterations=2)
        if np.count_nonzero(mask) / mask.size < 0.40:
            img_clahe = cv2.inpaint(img_clahe, mask, 7, cv2.INPAINT_TELEA)

    # 3. Partial desaturation (30%) — reduce colour-saturation bias
    gray3     = cv2.cvtColor(cv2.cvtColor(img_clahe, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    img_desat = cv2.addWeighted(img_clahe, 0.70, gray3, 0.30, 0)

    # 4. Mild unsharp mask sharpening
    blur      = cv2.GaussianBlur(img_desat, (0, 0), sigmaX=1.5)
    img_sharp = cv2.addWeighted(img_desat, 1.3, blur, -0.3, 0)

    return img_sharp


# ══════════════════════════════════════════════════════════════════════════════
# SEVERITY — run on original + preprocessed, take worst result
# ══════════════════════════════════════════════════════════════════════════════

def classify_severity(img_bgr: np.ndarray) -> dict:
    """
    Run severity on original and preprocessed variant.
    Takes the worst (highest) severity class across both.
    Falls back gracefully if either variant fails.
    """
    variants = [img_bgr, preprocess(img_bgr)]
    best_class = 'minor'
    best_conf  = 0.333   # sane default — equal probability
    best_probs = {'minor': 0.333, 'moderate': 0.333, 'severe': 0.333}

    for variant in variants:
        try:
            pil = Image.fromarray(cv2.cvtColor(variant, cv2.COLOR_BGR2RGB))
            arr = np.array(pil.convert('RGB'))
            t   = severity_tf(image=arr)['image'].unsqueeze(0).to(DEVICE)
            with torch.no_grad():
                p = torch.softmax(severity_model(t), dim=1)[0].cpu().numpy()

            cls   = CLASS_NAMES[int(p.argmax())]
            conf  = float(p.max())
            probs = {CLASS_NAMES[i]: round(float(p[i]), 3) for i in range(3)}

            # Keep worst severity; break ties by confidence
            if (SEV_RANK[cls] > SEV_RANK[best_class] or
                    (SEV_RANK[cls] == SEV_RANK[best_class] and conf > best_conf)):
                best_class = cls
                best_conf  = conf
                best_probs = probs

        except Exception as e:
            log.warning("Severity variant failed: %s", e)
            continue

    return {
        'class':         best_class,
        'confidence':    round(best_conf, 3),
        'probabilities': best_probs,
    }


# ══════════════════════════════════════════════════════════════════════════════
# GEOMETRY HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def dedup(boxes, thresh=0.5):
    if boxes is None or len(boxes) == 0:
        return boxes
    xyxy  = boxes.xyxy.cpu().numpy()
    confs = boxes.conf.cpu().numpy()
    order = confs.argsort()[::-1]
    keep  = []
    while len(order):
        i = order[0]; keep.append(i)
        if len(order) == 1: break
        rest  = order[1:]
        inter = (np.maximum(0, np.minimum(xyxy[i,2], xyxy[rest,2]) - np.maximum(xyxy[i,0], xyxy[rest,0])) *
                 np.maximum(0, np.minimum(xyxy[i,3], xyxy[rest,3]) - np.maximum(xyxy[i,1], xyxy[rest,1])))
        areas = ((xyxy[i,2]-xyxy[i,0])*(xyxy[i,3]-xyxy[i,1]) +
                 (xyxy[rest,2]-xyxy[rest,0])*(xyxy[rest,3]-xyxy[rest,1]))
        iou   = inter / (areas - inter + 1e-6)
        order = rest[iou < thresh]
    return boxes[keep]


def box_iod(dmg_box, part_box):
    dx1, dy1, dx2, dy2 = dmg_box
    px1, py1, px2, py2 = part_box
    iw = max(0, min(dx2, px2) - max(dx1, px1))
    ih = max(0, min(dy2, py2) - max(dy1, py1))
    return (iw * ih) / max(1, (dx2-dx1)*(dy2-dy1))


def find_all_parts(dmg_box, parts, threshold=0.10):
    overlapping = sorted(
        [(p['name'], round(box_iod(dmg_box, p['box']) * 100))
         for p in parts if box_iod(dmg_box, p['box']) >= threshold],
        key=lambda x: x[1], reverse=True
    )
    if overlapping:
        return overlapping
    if parts:
        dx1, dy1, dx2, dy2 = dmg_box
        dcx, dcy = (dx1+dx2)/2, (dy1+dy2)/2
        closest = min(parts, key=lambda p: (
            (dcx-(p['box'][0]+p['box'][2])/2)**2 +
            (dcy-(p['box'][1]+p['box'][3])/2)**2)**0.5)
        return [(closest['name'], 0)]
    return [('unknown', 0)]


def padded_crop(img_np, box, pad=20):
    h, w = img_np.shape[:2]
    x1 = max(0, box[0]-pad); y1 = max(0, box[1]-pad)
    x2 = min(w, box[2]+pad); y2 = min(h, box[3]+pad)
    return img_np[y1:y2, x1:x2], (x1, y1)


def yolo_to_list(boxes, names, offset=(0, 0)):
    if boxes is None: return []
    ox, oy = offset
    result = []
    for b in boxes:
        cls  = names[int(b.cls[0])].lower().strip()
        conf = round(float(b.conf[0]), 3)
        box  = b.xyxy[0].cpu().numpy().astype(int).tolist()
        result.append({
            'type': cls, 'conf': conf,
            'box':  [box[0]+ox, box[1]+oy, box[2]+ox, box[3]+oy],
        })
    return result


# ══════════════════════════════════════════════════════════════════════════════
# MAIN PIPELINE
# ══════════════════════════════════════════════════════════════════════════════

def run_pipeline(img: Image.Image) -> dict:
    # Convert to BGR and preprocess once
    img_bgr  = cv2.cvtColor(np.array(img.convert('RGB')), cv2.COLOR_RGB2BGR)
    img_proc = preprocess(img_bgr)   # preprocessed version for detectors
    W, H     = img.size

    # ── Stage 1: severity + main.pt on full image ─────────────────────────────
    s1_severity   = classify_severity(img_bgr)

    mb            = dedup(main_model(img_proc, conf=0.07, iou=0.4, verbose=False)[0].boxes)
    s1_detections = yolo_to_list(mb, main_model.names)

    # Triggers: all classes in TRIGGER_CLASSES
    # Quick lookup for dedup (full map defined later in per-trigger loop)
    TRIGGER_TO_PART_EARLY = {
        'doorouter-dent': 'front_door', 'damaged-door': 'front_door',
        'front-bumper-dent': 'front_bumper', 'damaged-front-bumper': 'front_bumper',
        'rear-bumper-dent': 'back_bumper', 'major-rear-bumper-dent': 'back_bumper',
        'damaged-rear-bumper': 'back_bumper', 'bonnet-dent': 'hood',
        'damaged-hood': 'hood', 'damaged-trunk': 'trunk',
        'fender-dent': 'front_fender', 'quaterpanel-dent': 'rear_fender',
        'roof-dent': 'roof', 'runningboard-dent': 'sill',
        'sidemirror-damage': 'left_mirror', 'damaged-head-light': 'front_left_light',
        'damaged-tail-light': 'back_left_light', 'headlight-damage': 'front_left_light',
        'taillight-damage': 'back_left_light',
    }

    triggers = [d for d in s1_detections if d['type'] in TRIGGER_CLASSES]

    # Fallback: only generic damage words — never let localised classes fall through
    if not triggers and s1_detections:
        triggers = [d for d in s1_detections if d['type'] in GENERIC_FALLBACK]

    # Last resort: full image
    if not triggers:
        triggers = [{'type': 'full_image', 'conf': 1.0, 'box': [0, 0, W, H]}]

    # ── Deduplicate triggers by localised part ────────────────────────────────
    # If main.pt fires doorouter-dent twice (two detections of same class),
    # keep only the highest-confidence one per localised part type.
    # Generic triggers are kept all (different spatial regions).
    _seen_localised = {}
    _deduped = []
    for t in triggers:
        tp = TRIGGER_TO_PART_EARLY.get(t['type'].lower())
        if tp:
            # Localised — keep highest conf per part
            if tp not in _seen_localised or t['conf'] > _seen_localised[tp]['conf']:
                _seen_localised[tp] = t
        else:
            _deduped.append(t)
    _deduped.extend(_seen_localised.values())
    triggers = _deduped

    # ── Localised vs generic trigger classification ───────────────────────────
    # Maps localised main.pt class → known part name (car_part.pt namespace)
    # When main.pt names the part directly, we skip vehide+car_part inference
    TRIGGER_TO_PART = {
        'doorouter-dent':         'front_door',
        'damaged-door':           'front_door',
        'front-bumper-dent':      'front_bumper',
        'damaged-front-bumper':   'front_bumper',
        'rear-bumper-dent':       'back_bumper',
        'major-rear-bumper-dent': 'back_bumper',
        'damaged-rear-bumper':    'back_bumper',
        'bonnet-dent':            'hood',
        'damaged-hood':           'hood',
        'damaged-trunk':          'trunk',
        'fender-dent':            'front_fender',
        'quaterpanel-dent':       'rear_fender',
        'roof-dent':              'roof',
        'runningboard-dent':      'sill',
        'sidemirror-damage':      'left_mirror',
        'damaged-head-light':     'front_left_light',
        'damaged-tail-light':     'back_left_light',
        'headlight-damage':       'front_left_light',
        'taillight-damage':       'back_left_light',
        'sidemirror-damage':      'left_mirror',
    }

    # car_part.pt runs once on the full image — always.
    # Needed for both localised regions (extra damage types) and generic regions.
    all_parts = []
    pb = dedup(parts_model(img_proc, conf=0.15, iou=0.4, verbose=False)[0].boxes)
    if pb is not None:
        for i, b in enumerate(pb):
            cls  = parts_model.names[int(b.cls[0])].lower().strip()
            conf = round(float(b.conf[0]), 3)
            box  = b.xyxy[0].cpu().numpy().astype(int).tolist()
            all_parts.append({'idx': i+1, 'name': cls, 'conf': conf, 'box': box})

    # ── Stage 2: per-trigger crop ─────────────────────────────────────────────
    stage2 = []

    for trig in triggers:
        crop_bgr, (ox, oy) = padded_crop(img_bgr, trig['box'])

        # Severity from the main.pt trigger crop — best available signal for
        # this damage region. Larger crop than any individual vehide box,
        # so ResNet has enough context to assess structural deformation.
        # Take worst of trigger-box severity vs full-image severity.
        trig_crop, _  = padded_crop(img_bgr, trig['box'], pad=20)
        trig_severity = classify_severity(trig_crop)
        if SEV_RANK[s1_severity['class']] > SEV_RANK[trig_severity['class']]:
            trig_severity = s1_severity

        trigger_type = trig['type'].lower()
        trigger_part = TRIGGER_TO_PART.get(trigger_type)
        is_localised = trigger_part is not None

        # ── Run vehide.pt + car_part.pt on every region ──────────────────────
        # Always run both models to catch damage types main.pt missed.
        # For localised triggers, we pre-seed the known (type, part) from
        # main.pt so vehide/car_part results only add NEW damage types.
        crop_proc  = preprocess(crop_bgr)
        vb         = dedup(vehide_model(crop_proc, conf=0.08, iou=0.4,
                                        verbose=False)[0].boxes)
        vehide_raw = yolo_to_list(vb, vehide_model.names, offset=(ox, oy))

        # Filter car_part.pt results to this trigger region
        tx1, ty1, tx2, ty2 = trig['box']
        region_parts = [
            p for p in all_parts
            if box_iod(p['box'], [tx1,ty1,tx2,ty2]) > 0.10
            or box_iod([tx1,ty1,tx2,ty2], p['box']) > 0.10
        ] or all_parts

        # Deduplicate parts by name
        seen_names, unique_parts = set(), []
        for p in region_parts:
            if p['name'] not in seen_names:
                seen_names.add(p['name'])
                unique_parts.append(p)

        # Start best_per dict — pre-seed with the localised detection if present
        # This prevents vehide from overwriting it with lower-confidence entry
        best_per = {}  # (type, on_part) → detection dict

        if is_localised:
            # Infer damage type from trigger class name
            if 'scratch' in trigger_type:
                dmg_type = 'scratch'
            elif 'light' in trigger_type or 'window' in trigger_type or 'glass' in trigger_type:
                dmg_type = 'broken_light'
            else:
                dmg_type = 'dent'

            # Seed the known (type, part) — will NOT be overwritten by vehide
            # Severity already computed from main.pt trigger box above
            localised_key = (dmg_type, trigger_part)
            best_per[localised_key] = {
                'type':        dmg_type,
                'conf':        trig['conf'],
                'box':         trig['box'],
                'on_part':     trigger_part,
                'overlap_pct': 100,
                'severity':    trig_severity,
            }

            # Ensure the trigger part appears in unique_parts
            if not any(p['name'] == trigger_part for p in unique_parts):
                unique_parts.insert(0, {
                    'idx': 0, 'name': trigger_part,
                    'conf': trig['conf'], 'box': trig['box'],
                })

        # Add vehide detections — skip any (type, part) already in best_per
        for vdet in vehide_raw:
            matches = find_all_parts(vdet['box'], all_parts)

            if is_localised:
                # For localised triggers: only accept vehide detections that
                # genuinely overlap the TRIGGER PART (IoD > 0).
                # Discard any centroid-fallback matches — these are noise from
                # vehide seeing a random texture in the crop and landing on
                # a part that isn't actually damaged (e.g. broken_glass on
                # front_bumper when the trigger is doorouter-dent).
                real_matches = [(p, o) for p, o in matches if o > 0 and p == trigger_part]
                if not real_matches:
                    # No real overlap with trigger part — skip this vehide box
                    continue
                matches = real_matches

            for part_name, overlap in matches:
                key = (vdet['type'], part_name)
                # Skip (type, part) already seeded from main.pt localised trigger
                if key in best_per and is_localised:
                    continue
                if key not in best_per or vdet['conf'] > best_per[key]['conf']:
                    best_per[key] = {
                        **vdet,
                        'on_part':     part_name,
                        'overlap_pct': overlap,
                        'severity':    trig_severity,
                    }

        vehide_dets = list(best_per.values())

        if not vehide_dets:
            continue

        # Region severity = worst severity across all individual damage boxes
        region_severity = s1_severity
        for d in vehide_dets:
            d_sev = d.get('severity', s1_severity)
            if SEV_RANK[d_sev['class']] > SEV_RANK[region_severity['class']]:
                region_severity = d_sev

        stage2.append({
            'triggered_by': trig,
            'severity':     region_severity,
            'damages':      vehide_dets,
            'parts':        unique_parts,
        })

    return {
        'image_size': {'width': W, 'height': H},
        'stage1':     {'severity': s1_severity, 'detections': s1_detections},
        'stage2':     stage2,
        'all_parts':  all_parts,
    }