# 네트워크와 서버 설정

[README](../README.md) · [사용 매뉴얼](USER_GUIDE.md) · [기술 스택](TECH_STACK.md)

## 주소 선택

| 목적 | 주소 | 기본 동작 |
| --- | --- | --- |
| 서버 PC에서 공유 | `http://localhost:3000` | 일반 모드 |
| 같은 PC의 두 브라우저 | 두 창 모두 localhost | 양방향 송수신 가능 |
| 스마트폰·노트북 등 다른 기기에서 보기 | `http://서버PC의내부IP:3000` | HTTP 보기 모드 |
| 다른 기기에서 캡처 송신 | 기기가 신뢰하는 HTTPS 서버 주소 | API 지원·권한 필요 |

`0.0.0.0`은 서버의 수신 인터페이스 설정입니다. 브라우저에는 localhost 또는 실제 서버 IP를 입력합니다.

## 서버 PC의 내부 IP 확인

Windows 터미널에서 실행합니다.

```powershell
ipconfig
```

실제로 사용하는 **이더넷 또는 Wi-Fi 어댑터의 IPv4 주소**를 확인합니다. VPN·가상머신·호스트 전용 어댑터 주소와 구분합니다.

예를 들어 실제 IP가 `192.168.1.50`이면 다른 기기는 다음으로 접속합니다. 각자의 PC 주소로 바꿉니다.

```text
http://192.168.1.50:3000
```

서버 PC는 유선 LAN, 수신 기기는 같은 공유기의 Wi-Fi 또는 LAN에 연결해도 됩니다. 게스트 Wi-Fi·기기 간 격리·PC 방화벽에 따라 접근이 제한될 수 있습니다. 서버 터미널 → IP → 같은 공유기 → 기기 간 접근 설정 순서로 확인합니다. 실행 스크립트는 방화벽을 자동 변경하지 않습니다.

## 보기 모드

일반 HTTP 내부 IP 주소는 카메라·마이크·화면 캡처가 제한되어 앱이 보기 모드를 선택합니다. 수신 영상과 채팅·포인터·주석은 별도 사용합니다.

- `?view=1`: localhost·HTTPS에서도 보기 모드 선택
- `?view=0` 또는 생략: 일반 접속. HTTP 내부 IP의 캡처 제한은 유지
- 서버 PC가 HTTP 보기 모드에 들어간 경우: **localhost로 화면 공유 열기** 링크로 이동. 방 코드 유지
- localhost 보기 모드: **내 화면 공유**로 일반 모드 전환 및 화면 선택

서버 PC에서 복사한 초대 링크가 localhost를 포함하면 다른 기기에서는 서버 PC의 내부 IP로 바꿉니다. 각자 올바른 서버 주소에서 같은 방 코드로 입장해도 됩니다.

## 다른 기기에서 카메라와 마이크 보내기

해당 기기가 신뢰하는 HTTPS가 필요합니다. 인증서 이름·주소가 접속 주소와 일치하고 인증서 체인도 신뢰되어야 합니다. HTTPS에서도 기기·브라우저의 API 지원과 사용자 권한에 따라 캡처 가능 여부가 달라집니다.

프로젝트는 기존 인증서로 HTTPS/WSS를 실행하는 설정을 지원합니다. 인증서 발급이나 OS 신뢰 저장소 설치는 자동으로 하지 않습니다.

1. `config.example.toml`을 `config.toml`로 복사합니다.
2. 실제 인증서·개인 키 경로를 설정합니다.

```toml
host = "0.0.0.0"
port = 3000
stun_urls = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]
tls_cert = "certs/server.pem"
tls_key = "certs/server-key.pem"
allowed_origins = []
```

3. 서버를 재시작하고 인증서에 맞는 HTTPS 주소로 접속합니다. 같은 포트가 HTTPS/WSS로 바뀌며 HTTP·HTTPS 동시 수신 구성은 아닙니다.

경로는 프로젝트 폴더 기준 또는 절대 경로입니다. HTTPS 리버스 프록시는 WebSocket Upgrade 전달이 필요하며 Host를 바꾸면 외부 origin을 `allowed_origins`에 명시합니다.

스마트폰·노트북 등 다른 기기의 캡처 송신과 실제 인증서 배포는 추가 검증 대상입니다. 기기별 실기기 확인과 미검증 범위는 [검증 기록](VALIDATION.md)에 구분했습니다.

## STUN과 외부망

같은 LAN에서는 host 후보만으로 연결될 수 있고 외부망에서는 STUN에서 탐색한 후보도 시험합니다. 다른 회선에서는 두 기기 모두 신호 서버에 접근할 수 있어야 하며 브라우저 사이의 미디어 경로도 연결 가능해야 합니다.

웹페이지 접속 성공만으로 P2P 미디어 연결이 보장되지는 않습니다. 현재 TURN·SFU를 사용하지 않아 대칭 NAT·UDP 차단망에서는 실패할 수 있습니다. LTE/5G·회사망·서로 다른 공유기 조합은 추가 시험 대상입니다.

## 설정 우선순위

**명령행 인자 → 환경변수 → config.toml → 기본값** 순서입니다.

| 항목 | 기본값 | 환경변수 |
| --- | --- | --- |
| host | `0.0.0.0` | `HOST` |
| port | `3000` | `PORT` |
| stun_urls | Google STUN 2개 | `STUN_URLS` |
| tls_cert / tls_key | 비어 있음 · HTTP | `TLS_CERT` / `TLS_KEY` |
| allowed_origins | 비어 있음 · 동일 origin 허용 | `ALLOWED_ORIGINS` |

환경변수의 STUN·origin 목록은 쉼표로 구분합니다.

```powershell
.\start.cmd --port 3001
.\start.cmd --host 127.0.0.1 --port 3001 --stun-urls ""
```

두 번째는 loopback 접속만 받고 STUN을 비워 같은 PC에서 시험합니다. CLI 전체 옵션은 `python run.py --help`에서 확인합니다.

방은 메모리에 저장하며 빈 방은 기본 5분 뒤 정리합니다. 서버 재시작 시 새 세션이 필요합니다.
