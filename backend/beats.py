"""음원 비트 검출 — 구간 경계를 박자에 스냅하는 데 쓴다(librosa).

librosa가 없거나 분석이 실패하면 빈 리스트를 반환한다(호출 측에서 안내).
"""


def detect_beats(audio_path: str):
    """오디오의 비트 시각(초) 리스트. 실패/미설치 시 []."""
    try:
        import librosa
    except Exception:
        return []
    try:
        y, sr = librosa.load(audio_path, sr=22050, mono=True)
        _, frames = librosa.beat.beat_track(y=y, sr=sr)
        times = librosa.frames_to_time(frames, sr=sr)
        return [round(float(t), 3) for t in times]
    except Exception:
        return []
