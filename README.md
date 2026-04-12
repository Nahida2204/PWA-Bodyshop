# Leal Bodyshop PWA — Setup and Usage Guide

---

## Requirements

- Python 3.10 or higher
- The host PC and mobile devices must be on the same WiFi network
- Model files must be present in the `models/` folder

---

## Install Dependencies

```bash
pip install fastapi uvicorn pillow easyocr ultralytics torch torchvision
```

---

## Start the Server

Open a terminal in the project root folder, navigate into the backend folder, and run:

```bash
cd backend
python app.py
```

Or equivalently:

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

> **Important:** The `--host 0.0.0.0` flag is critical — it makes the server reachable from other devices on the network. Do not use `127.0.0.1` for mobile access.

---

## Find the Host IP Address

**On Windows:**
```bash
ipconfig
```
Look for **IPv4 Address** under your active WiFi adapter.
Example: `192.168.1.45`

**On macOS / Linux:**
```bash
ifconfig
# or
ip addr
```
Look for the `inet` address on your WiFi interface (`en0` or `wlan0`).
Example: `192.168.1.45`

> The `app.py` CONFIG block already handles this automatically:
> ```js
> const API_URL = `http://${hostname}:8000`
> ```
> As long as the browser URL uses the server IP, API calls will work correctly.

---

## Verify the Server is Running

Open a browser on the host PC and navigate to:

```
http://localhost:8000
```

You should see the PWA interface load.

Also check the health endpoint:

```
http://localhost:8000/health
```

Expected response: `{"status":"ok"}`

---

## Accessing the App on Mobile

### Step 1 — Connect to the same WiFi
Make sure your phone or tablet is connected to the **same WiFi network** as the PC running the server. This will not work over mobile data.

### Step 2 — Find the server IP address
On the host PC, run `ipconfig` (Windows) or `ifconfig` (Mac/Linux) and note the IPv4 address of the WiFi adapter.
Example: `192.168.1.45`

### Step 3 — Open in mobile browser
On your phone, open **Chrome** (Android) or **Safari** (iOS) and navigate to:

```
http://192.168.1.45:8000
```

Replace with your actual server IP. The full PWA interface will load. All photo capture, analysis, and results work directly in the mobile browser — no app installation needed.

### Step 4 — Install as a home screen app *(optional)*

Installing gives the app a full-screen experience without the browser toolbar.

**On Android (Chrome):**
1. Open the URL in Chrome
2. Tap the three-dot menu in the top right
3. Tap **Add to Home screen**
4. Tap **Add** to confirm
5. The app icon will appear on your home screen

**On iPhone / iPad (Safari):**
1. Open the URL in Safari *(must be Safari, not Chrome)*
2. Tap the Share button (box with arrow pointing up)
3. Scroll down and tap **Add to Home Screen**
4. Tap **Add** in the top right
5. The app icon will appear on your home screen

Once installed, opening the app from the home screen launches it full-screen without any browser UI.

### Step 5 — Using the camera on mobile
Tap the camera icon in the damage upload section. This opens the native camera app directly — photos are taken and sent for analysis without leaving the app.

> Images are automatically resized to 640px before uploading (`MAX_DIM = 640`) to keep upload times fast over WiFi.

---

## Troubleshooting

### "Site can't be reached" or connection refused
- Confirm the server is running — check the terminal for errors
- Confirm both devices are on the same WiFi network
- Confirm you are using the correct IP address, not `localhost`
- Check Windows Firewall — add a rule to allow inbound TCP on port 8000:

  ```
  Control Panel → Windows Defender Firewall → Advanced Settings
  → Inbound Rules → New Rule → Port → TCP 8000 → Allow
  ```

### Analysis takes very long on mobile
- This is expected — the pipeline runs on the server PC, not the phone
- Analysis time is typically 10–30 seconds depending on server hardware
- The timeout is set to 180,000 ms (3 minutes) in `app.js`

### Vignette scan button does nothing
- Some mobile browsers block camera file upload without HTTPS
- If this occurs, use the VIN entry tab as a fallback instead

### App does not install to home screen
- iOS requires **Safari** — Chrome on iPhone cannot install PWAs
- Android requires **Chrome** or **Edge**
- The `manifest.json` and `sw.js` files must be served correctly — they are, when using the FastAPI static file server