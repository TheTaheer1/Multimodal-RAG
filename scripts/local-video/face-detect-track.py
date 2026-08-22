#!/usr/bin/env python3
import json
import sys
from pathlib import Path

try:
    import cv2
except Exception as exc:
    print(f"OpenCV is required. Install with: python3 -m pip install opencv-python. {exc}", file=sys.stderr)
    sys.exit(1)


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    denom = area_a + area_b - inter
    return inter / denom if denom else 0


def main():
    if len(sys.argv) < 2:
        print("Usage: face-detect-track.py <frames-manifest.json>", file=sys.stderr)
        sys.exit(1)

    manifest = json.loads(Path(sys.argv[-1]).read_text())
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    detector = cv2.CascadeClassifier(cascade_path)
    if detector.empty():
        print("Failed to load OpenCV Haar face cascade.", file=sys.stderr)
        sys.exit(1)

    tracks = []
    next_track = 1
    output = []

    for frame in manifest:
        frame_path = frame["frame_path"]
        timestamp = float(frame["timestamp"])
        image = cv2.imread(frame_path)
        if image is None:
            continue
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(32, 32))
        current_boxes = []
        for (x, y, w, h) in faces:
            box = (int(x), int(y), int(x + w), int(y + h))
            best = None
            best_score = 0
            for track in tracks:
                score = iou(box, track["box"])
                if score > best_score:
                    best = track
                    best_score = score
            if best and best_score >= 0.2:
                track_id = best["track_id"]
                best["box"] = box
                best["last_seen"] = timestamp
            else:
                track_id = f"TRACK_{next_track:03d}"
                next_track += 1
                tracks.append({"track_id": track_id, "box": box, "last_seen": timestamp})
            current_boxes.append(box)
            output.append({
                "frame_path": frame_path,
                "timestamp": timestamp,
                "bounding_box": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
                "track_id": track_id,
                "confidence": 0.65
            })
        tracks[:] = [track for track in tracks if timestamp - track["last_seen"] <= 15]

    print(json.dumps(output))


if __name__ == "__main__":
    main()
