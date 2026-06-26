# subsong 실행 — 브라우저에서 http://127.0.0.1:8765 열기
#   포트 변경:   ./run.ps1 -Port 8000
#   파이썬 지정: ./run.ps1 -Py "C:\path\to\python.exe"
param(
  [int]$Port = 8765,
  [string]$Py = ""
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# 패키지가 설치된 파이썬을 우선 사용 (miniconda 등 다른 파이썬으로 잡히는 문제 방지)
if (-not $Py) {
  $cand = Join-Path $env:LOCALAPPDATA "Programs\Python\Python310\python.exe"
  $Py = if (Test-Path $cand) { $cand } else { "python" }
}

# 의존성 확인
& $Py -c "import stable_whisper, fastapi, torch" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[!] 현재 파이썬에 필요한 패키지가 없습니다: $Py" -ForegroundColor Yellow
  Write-Host "    아래를 실행해 설치하세요:" -ForegroundColor Yellow
  Write-Host "      & `"$Py`" -m pip install torch --index-url https://download.pytorch.org/whl/cu121"
  Write-Host "      & `"$Py`" -m pip install -r requirements.txt"
  exit 1
}

Write-Host "subsong 서버 시작 → http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "  (python: $Py)" -ForegroundColor DarkGray
& $Py -m uvicorn backend.main:app --host 127.0.0.1 --port $Port
