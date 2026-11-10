# Python aiohttp 버전 검증 기록

Python 전환 검증: 2026-11-09 / HTTP 식별자·화면 보기 모드 검증: 2026-11-10 (Asia/Seoul)

## 현재 기술 구성

- 백엔드: Python 3.13.2 + aiohttp 3.14.5 (프로젝트 최소 Python 3.11)
- 프론트엔드: HTML + CSS + JavaScript ES Modules
- 통신: aiohttp WebSocket 신호 교환 + 브라우저 WebRTC P2P
- 백엔드 검증: Python unittest + aiohttp TestClient/TestServer
- 브라우저 검증: Python Playwright 1.58.0
- 실제 브라우저: Windows의 Chrome 156.0.8078.80, Edge 157.0.4341.42

## 결과

| 구분 | 결과 | 근거 |
| --- | --- | --- |
| Python HTTP/WebSocket·설정 테스트 | 16개 통과 | tests/test_server.py |
| 실제 Chrome·Edge 통합 확인 | 23개 통과 | [validation/browser-report.json](validation/browser-report.json) |
| HTTP·randomUUID 미지원 회귀 검증 | 7개 통과 | [validation/http-compat-report.json](validation/http-compat-report.json) |
| 데스크톱 화면 → HTTP 모바일 보기 | 15개 통과 | [validation/viewer-report.json](validation/viewer-report.json) |
| 페이지·크기별 레이아웃 | 15개 통과 | [validation/layout-report.json](validation/layout-report.json) |
| 미처리 브라우저 예외·콘솔 오류 | 없음 | [validation/browser-report.json](validation/browser-report.json) |
| 새 ZIP 최초 설치·실행 | 통과 | [validation/package-report.json](validation/package-report.json) |

서버 테스트는 정적 자원·설정·상태 확인, 서버 소스와 경로 이탈 차단, 방 생성·2인 제한·퇴장·재입장, 동시 입장 경합, SDP/ICE 중계·송신자 위조 방지, 타 방·자기 자신 대상으로의 신호 차단, 잘못된 JSON·NaN·바이너리·메시지·신호 검증, 중복 입장 차단, 이름 길이 제한, 소켓 종료 알림, origin 거부와 allowlist, 메시지 빈도·크기 상한, 빈 방 만료·방 상한을 검증합니다.

브라우저 통합 확인은 aiohttp 서버의 `/health`에서 Python 백엔드임을 확인한 뒤 다음 동작을 검증합니다.

1. Python + aiohttp 자원·신호 서버 확인
2. Chrome↔Edge RTCPeerConnection 및 RTCDataChannel 연결
3. 직접 host candidate 경로 확인 (relay 없음)
4. P2P 채팅 전달과 HTML 문자열의 텍스트 표시
5. 카메라 영상과 마이크 RTP bytes 실제 수신
6. 정규화 주석의 상대 캔버스 표시
7. 원격 포인터 전달
8. 영상·주석 합성 PNG 다운로드
9. 주석 지우기 동기화
10. Chrome 카메라→화면 공유 전환
11. 공유 중지와 상대 영상 상태 해제
12. Edge 화면 공유를 Chrome에서 수신
13. 양방향 영상과 미리보기 전환
14. 실제 getStats와 sender maxBitrate 350000 적용
15. ICE restart 이후 메시지 전달
16. 진단 JSON 다운로드
17. 동일 방 퇴장·재입장
18. 신호 소켓 단절 뒤 방·P2P 자동 복구
19. 종료 시 로컬 미디어 트랙 해제
20. 390px 화면 가로 넘침 없음
21. 사용 안내 열기·Escape 닫기
22. 브라우저 예외·콘솔 오류 없음
23. native randomUUID가 없는 브라우저에서 방 요청과 그리기 동작

레이아웃 검증은 360, 390, 768, 1024, 1440px에서 로비·세션·아키텍처 페이지를 확인합니다. 주요 스크린샷을 별도로 열어 배치와 텍스트도 확인합니다.

배포 ZIP은 별도 폴더에 압축을 풀고 `.venv`가 없는 상태에서 `start.cmd --help`로 실행했습니다. 가상환경 생성과 실행 의존성 설치, Python CLI 호출이 성공했습니다. 이어서 해당 환경의 aiohttp만으로 화면 제공, 방 생성·입장, WebSocket SDP 중계를 확인했습니다. 이 환경에는 Playwright를 설치하지 않아 검증 도구가 앱 실행에 필요하지 않음을 확인했습니다.

HTTP 호환 검증은 격리된 Chrome·Edge의 DNS 매핑으로 `http://fieldlink.test`에 접속했습니다. 실제 `isSecureContext === false`, `crypto.randomUUID === undefined`, `crypto.getRandomValues` 사용 가능 상태를 확인했습니다. 방 생성·코드 표시·입장·P2P 채팅, UUID v4 형식과 샘플 내 중복 없음, HTTP 자동 보기 모드·미디어 캡처 버튼 숨김, 브라우저 오류 없음을 검증했습니다. 기존 영상·음성 통합 검증에서는 Edge의 native randomUUID를 비활성화해 주석도 fallback ID로 전달되는지 확인했습니다. 실제 아이폰에서의 검증은 아닙니다.

HTTP 화면 보기 검증은 Chrome 송신→Edge 수신, Edge 송신→Chrome 수신 두 조합으로 실행했습니다. 송신 페이지는 신뢰되는 loopback HTTP, 수신 페이지는 실제 비보안 HTTP origin과 모바일·터치 설정입니다. 테스트 탭 화면 캡처를 수신해 inbound-rtp의 framesDecoded 증가와 video 재생 상태를 확인했습니다. 자동 재생 제한을 해제하는 플래그 없이 수동 영상 재생, 마이크 RTP 수신·소리 토글, 채팅·터치 포인터·터치 점 주석, 로컬 미디어 트랙 0개, 360·390·844px 배치, 공유 중지·퇴장 뒤 보기 모드 유지도 검증했습니다. 터치 점의 시작·종료 좌표가 같을 때 주석이 사라지던 문제는 연속 중복 좌표를 제거해 수정했습니다. localhost의 보기 모드에서 내 화면 공유로 전환하고, 모바일 형태의 수신 기기가 입장하기 전에 화면 캡처를 시작할 수 있는지 Chrome·Edge 두 방향에서 확인했습니다. HTTP 서버 PC용 localhost 링크의 방 코드 유지와 영상 대기 안내도 확인했습니다. iOS Safari 실기기 검증은 포함하지 않았습니다.

## 사용자 실기기 확인

2026-11-10 사용자가 같은 공유기에서 데스크톱 화면을 아이폰으로 수신하는 데 성공했다고 확인했습니다. 이는 사용자의 수동 확인이며 자동 검증의 iPhone 실기기 테스트를 뜻하지 않습니다. 아이폰 카메라 송신, 서로 다른 회선, 아이폰의 모든 오디오·주석 기능까지 확인한 결과로 확장하지 않습니다.

저장소의 `docs/validation/`은 통과한 자동 검증 기록의 사본입니다. 테스트 재실행 결과는 로컬 `test-results/`에 생성되며 Git에는 포함하지 않습니다. ZIP 최초 설치 기록은 문서 정리 이전 Python 실행 파일·의존성 구성에 대한 검증입니다.

## 검증 범위

실제 Chrome·Edge 프로세스를 headless로 실행했고 가상 카메라·마이크와 테스트용 화면 선택 기능을 사용했습니다. 두 브라우저는 같은 PC의 임의 포트에 실행된 Python aiohttp 서버에 접속합니다. 통합 테스트에서는 STUN을 비워 host candidate만으로 직접 P2P가 되는지 확인합니다.

실제 USB 장치 품질, 사용자의 수동 화면 선택, macOS·iPhone 실기기, 서로 다른 회선의 NAT·STUN, 회사 방화벽, 패킷 손실 주입 환경, 실제 HTTPS 인증서 배포는 이번 자동 검증에 포함하지 않았습니다. 따라서 모든 기기·외부망에서의 성공을 보장하는 결과는 아닙니다.

## 다시 실행

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v
.\.venv\Scripts\python.exe tests/browser.py
.\.venv\Scripts\python.exe tests/layout.py
.\.venv\Scripts\python.exe tests/http_compat.py
.\.venv\Scripts\python.exe tests/viewer.py
```
