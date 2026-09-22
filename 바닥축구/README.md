# NEON FUTSAL ONLINE

브라우저에서 방을 만들고 1대1부터 4대4까지 즐기는 온라인 풋살 게임입니다.

## 조작

- 이동: 방향키
- 슛: `X`, `Ctrl`, `Space` 중 아무 키
- 캐릭터 등번호: 한글 1자 또는 영문·숫자 2자

공과 선수는 독립된 물체이며, 일반 접촉에서는 낮은 반발력으로 자연스럽게
밀립니다. 슛 키를 눌렀을 때만 별도의 강한 힘이 적용됩니다.

## 경기 설정

- 경기 시간: 1분부터 10분
- 인원: 1대1, 2대2, 3대3, 4대4
- 정규시간 종료 시 앞선 팀 승리
- 동점이면 골든골로 전환하며 다음 득점 팀 승리

## 로컬 개발

Node.js를 설치한 뒤 이 폴더에서:

```powershell
npm install
npm run dev
```

상위 프로젝트 폴더에서는 정적 서버를 실행합니다.

```powershell
python -m http.server 8000
```

<http://localhost:8000/바닥축구/>에 접속합니다.

## 구조

- `shared/physics.js`: 서버와 테스트에서 사용하는 경기 물리 및 규칙
- `server/worker.js`: Cloudflare Worker, 방 목록 및 Durable Object 경기 서버
- `game.js`: 방 UI, 네트워크 입력, 스냅샷 보간 및 Canvas 렌더링
- `tests/physics.test.js`: 드리블, 충돌, 골든골 테스트
- `tests/online-smoke.mjs`: 1대1 및 4대4 WebSocket 연결 테스트
