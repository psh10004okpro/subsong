"""작업(job) 레지스트리 — 진행률·취소의 공통 토대.

긴 작업(렌더 등)을 백그라운드 스레드로 돌리고, 상태/진행률을 들고 있다가
SSE로 흘려보낸다. 취소는 등록된 subprocess(ffmpeg)를 종료한다.
인메모리(프로세스 재시작 시 사라짐) — 단일 인스턴스 로컬 도구 기준.
"""
import threading
import uuid

_jobs = {}
_lock = threading.Lock()


class Job:
    def __init__(self, jtype):
        self.id = uuid.uuid4().hex
        self.type = jtype
        self.status = "running"  # running | done | error | cancelled
        self.progress = 0.0
        self.message = ""
        self.result = None
        self.error = None
        self.proc = None         # 취소용 subprocess 핸들
        self.cancelled = False


def create(jtype: str) -> Job:
    j = Job(jtype)
    with _lock:
        _jobs[j.id] = j
    return j


def get(jid: str):
    with _lock:
        return _jobs.get(jid)


def snapshot(j: Job) -> dict:
    return {
        "id": j.id,
        "type": j.type,
        "status": j.status,
        "progress": round(j.progress, 3),
        "message": j.message,
        "result": j.result,
        "error": j.error,
    }


def cancel(jid: str) -> bool:
    j = get(jid)
    if not j:
        return False
    j.cancelled = True
    if j.proc and j.proc.poll() is None:
        try:
            j.proc.terminate()
        except Exception:
            pass
    return True
