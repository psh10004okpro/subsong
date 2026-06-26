"""이미지에 (정면) 얼굴이 있는지 판별 — 인물/컨셉 참조 분류에 사용.

OpenCV Haar cascade(정면 얼굴). 완벽하진 않지만 '인물 사진인지'를
가르는 용도로 충분하다.
"""
import cv2

_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)


def has_face(image_path: str) -> bool:
    img = cv2.imread(image_path)
    if img is None:
        return False
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h = img.shape[0]
    min_side = max(60, h // 12)  # 너무 작은 오검출 제외
    faces = _cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=6, minSize=(min_side, min_side)
    )
    return len(faces) > 0
