import torch, torch.nn as nn
from torchvision import models
from ultralytics import YOLO
from PIL import Image
import numpy as np
import albumentations as A
from albumentations.pytorch import ToTensorV2

# ── CONFIG ────────────────────────────────────────────────────────────────────

BASE = r"C:\Users\23052\OneDrive - Middlesex University\Desktop\PWA-Bodyshop\PWA-Bodyshop\models"

import os
MAIN_PATH     = os.path.join(BASE, "main.pt")
VEHIDE_PATH   = os.path.join(BASE, "vehide.pt")
PARTS_PATH    = os.path.join(BASE, "car_part.pt")
SEVERITY_PATH = os.path.join(BASE, "resnet50_severity_best.pth")

CLASS_NAMES     = ['minor', 'moderate', 'severe']
TRIGGER_CLASSES = {"damaged", "dent", "scratch","dent-or-scratch"}
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
    A.Normalize(mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225]),
    ToTensorV2(),
])

print("All models loaded")

# ── HELPERS ───────────────────────────────────────────────────────────────────

def dedup(boxes, thresh=0.5):
    if boxes is None or len(boxes) == 0: return boxes
    xyxy = boxes.xyxy.cpu().numpy()
    confs = boxes.conf.cpu().numpy()
    order = confs.argsort()[::-1]; keep = []
    while len(order):
        i = order[0]; keep.append(i)
        if len(order) == 1: break
        rest = order[1:]
        inter = (np.maximum(0, np.minimum(xyxy[i,2],xyxy[rest,2]) - np.maximum(xyxy[i,0],xyxy[rest,0])) *
                 np.maximum(0, np.minimum(xyxy[i,3],xyxy[rest,3]) - np.maximum(xyxy[i,1],xyxy[rest,1])))
        iou = inter / ((xyxy[i,2]-xyxy[i,0])*(xyxy[i,3]-xyxy[i,1]) +
                       (xyxy[rest,2]-xyxy[rest,0])*(xyxy[rest,3]-xyxy[rest,1]) - inter + 1e-6)
        order = rest[iou < thresh]
    return boxes[keep]


def find_part(dmg_box, parts):
    dx1,dy1,dx2,dy2 = dmg_box
    best, best_iod = 'unknown', 0
    for p in parts:
        px1,py1,px2,py2 = p['box']
        inter = max(0,min(dx2,px2)-max(dx1,px1)) * max(0,min(dy2,py2)-max(dy1,py1))
        iod = inter / max(1,(dx2-dx1)*(dy2-dy1))
        if iod > best_iod: best_iod = iod; best = p['name']
    if best == 'unknown' and parts:
        dcx,dcy = (dx1+dx2)/2,(dy1+dy2)/2
        best = min(parts, key=lambda p:
            ((dcx-(p['box'][0]+p['box'][2])/2)**2 +
             (dcy-(p['box'][1]+p['box'][3])/2)**2)**0.5)['name']
    return best, round(best_iod*100)


def classify_severity(img: Image.Image) -> dict:
    arr = np.array(img.convert('RGB'))
    t = severity_tf(image=arr)['image'].unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        p = torch.softmax(severity_model(t), dim=1)[0].cpu().numpy()
    return {
        'class': CLASS_NAMES[p.argmax()],
        'confidence': round(float(p.max()), 3),
        'probabilities': {CLASS_NAMES[i]: round(float(p[i]), 3) for i in range(3)}
    }


def padded_crop(img_np, box, pad=20):
    h, w = img_np.shape[:2]
    x1=max(0,box[0]-pad); y1=max(0,box[1]-pad)
    x2=min(w,box[2]+pad); y2=min(h,box[3]+pad)
    return img_np[y1:y2, x1:x2], (x1, y1)

# ── MAIN ENTRY POINT ──────────────────────────────────────────────────────────

def run_pipeline(img: Image.Image) -> dict:
    img_np = np.array(img.convert('RGB'))
    W, H   = img.size

    # Stage 1 — main.pt + severity on full image
    s1_severity = classify_severity(img)

    mb = dedup(main_model(img_np, conf=0.10, iou=0.4, verbose=False)[0].boxes)
    s1_detections = []
    triggers = []
    if mb is not None:
        for b in mb:
            cls  = main_model.names[int(b.cls[0])].lower().strip()
            conf = round(float(b.conf[0]), 3)
            box  = b.xyxy[0].cpu().numpy().astype(int).tolist()
            det  = {'type': cls, 'conf': conf, 'box': box}
            s1_detections.append(det)
            if cls in TRIGGER_CLASSES:
                triggers.append(det)

    # Stage 2 — vehide.pt + car_part.pt + severity on each trigger crop
    stage2 = []
    for trig in triggers:
        crop_np, (ox, oy) = padded_crop(img_np, trig['box'])
        crop_pil = Image.fromarray(crop_np)

        crop_severity = classify_severity(crop_pil)

        # vehide.pt on crop
        vb = dedup(vehide_model(crop_np, conf=0.10, iou=0.4, verbose=False)[0].boxes)
        vehide_dets = []
        if vb is not None:
            for b in vb:
                cls  = vehide_model.names[int(b.cls[0])].lower().strip()
                conf = round(float(b.conf[0]), 3)
                box  = b.xyxy[0].cpu().numpy().astype(int).tolist()
                vehide_dets.append({'type': cls, 'conf': conf,
                                    'box': [box[0]+ox, box[1]+oy, box[2]+ox, box[3]+oy]})

        # car_part.pt on crop
        pb = dedup(parts_model(crop_np, conf=0.25, iou=0.4, verbose=False)[0].boxes)
        parts = []
        if pb is not None:
            for i, b in enumerate(pb):
                cls  = parts_model.names[int(b.cls[0])].lower().strip()
                conf = round(float(b.conf[0]), 3)
                box  = b.xyxy[0].cpu().numpy().astype(int).tolist()
                parts.append({'idx': i+1, 'name': cls, 'conf': conf,
                              'box': [box[0]+ox, box[1]+oy, box[2]+ox, box[3]+oy]})

        # match each vehiDE damage to its part
        for vdet in vehide_dets:
            part_name, overlap = find_part(vdet['box'], parts)
            vdet['on_part']     = part_name
            vdet['overlap_pct'] = overlap

        stage2.append({
            'triggered_by': trig,
            'severity':     crop_severity,
            'damages':      vehide_dets,
            'parts':        parts,
        })

    return {
        'image_size': {'width': W, 'height': H},
        'stage1': {
            'severity':   s1_severity,
            'detections': s1_detections,
        },
        'stage2': stage2,
    }