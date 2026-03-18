import torch, torch.nn as nn
from torchvision import models
from ultralytics import YOLO
from PIL import Image
import numpy as np
import albumentations as A
from albumentations.pytorch import ToTensorV2

PARTS_PATH    = r"C:\Users\23052\OneDrive - Middlesex University\Desktop\PWATest\models\car_part.pt"
DAMAGE_PATH   = r"C:\Users\23052\OneDrive - Middlesex University\Desktop\PWATest\models\best.pt"
SEVERITY_PATH = r"C:\Users\23052\OneDrive - Middlesex University\Desktop\PWATest\models\resnet50_severity_best.pth"
CLASS_NAMES   = ['minor', 'moderate', 'severe']
IMG_SIZE      = 224
DEVICE        = torch.device('cpu')

print("Loading models...")
parts_model  = YOLO(PARTS_PATH)
damage_model = YOLO(DAMAGE_PATH)

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
print("✅ All models loaded")

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

def classify_severity(img):
    arr = np.array(img.convert('RGB'))
    t = severity_tf(image=arr)['image'].unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        p = torch.softmax(severity_model(t), dim=1)[0].cpu().numpy()
    return CLASS_NAMES[p.argmax()], float(p.max()), p.tolist()

def run_pipeline(img: Image.Image) -> dict:
    img_np = np.array(img.convert('RGB'))
    W, H   = img.size
    sev_class, sev_conf, sev_probs = classify_severity(img)
    pb = dedup(parts_model(img_np, conf=0.25, iou=0.4, verbose=False)[0].boxes)
    parts = []
    if pb is not None:
        for i, b in enumerate(pb):
            parts.append({'idx': i+1, 'name': parts_model.names[int(b.cls[0])],
                          'conf': round(float(b.conf[0]),3),
                          'box': b.xyxy[0].cpu().numpy().astype(int).tolist()})
    db = dedup(damage_model(img_np, conf=0.15, iou=0.4, verbose=False)[0].boxes)
    damages = []
    if db is not None:
        for b in db:
            box = b.xyxy[0].cpu().numpy().astype(int).tolist()
            part_name, overlap = find_part(box, parts)
            damages.append({'type': damage_model.names[int(b.cls[0])],
                            'conf': round(float(b.conf[0]),3), 'box': box,
                            'on_part': part_name, 'overlap_pct': overlap})
    return {
        'severity': {'class': sev_class, 'confidence': round(sev_conf,3),
                     'probabilities': {CLASS_NAMES[i]: round(sev_probs[i],3) for i in range(3)}},
        'damages': damages, 'parts': parts,
        'image_size': {'width': W, 'height': H}
    }