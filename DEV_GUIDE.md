# 단말대여봇 개발 가이드

## 프로젝트 개요

Next.js 16 기반 Slack 단말 대여 관리 봇. Socket Mode로 동작하며 Google Sheets를 DB로 사용.

## 배포 정보

- **플랫폼**: Backyard (`labs.wntd.co/projects/device-rental-bot`)
- **레지스트리**: `oci.wntd.co/backyard/device-rental-bot`
- **배포 명령어**:
  ```bash
  docker build -t oci.wntd.co/backyard/device-rental-bot .
  docker push oci.wntd.co/backyard/device-rental-bot
  ```
- **배포 전 반드시 로컬 테스트 후 진행** (오피스 네트워크에서 테스트할 것 — 집 네트워크는 WebSocket 차단될 수 있음)

## 환경변수 (Backyard 대시보드에서 설정)

| 변수명 | 설명 |
|---|---|
| `SLACK_APP_TOKEN` | xapp-... (Socket Mode용 앱 레벨 토큰) |
| `SLACK_BOT_TOKEN` | xoxb-... (봇 토큰) |
| `SLACK_SIGNING_SECRET` | 요청 서명 검증용 |
| `ADMIN_USER_ID` | 관리자 Slack User ID (현재: U07SRDNADGB) |
| `GOOGLE_SHEET_ID` | 구글 스프레드시트 ID |
| `GOOGLE_CREDENTIALS_JSON` | 서비스 계정 JSON 전체 |
| `CRON_SECRET` | (현재 미사용, 추후 외부 cron 연동 시 사용) |

## 파일 구조

```
src/
├── instrumentation.ts   # Next.js 서버 시작 시 봇 자동 실행
├── bot.ts               # 봇 메인 로직 (모든 Slack 이벤트/액션/모달 핸들러)
├── lib/
│   ├── sheets.ts        # Google Sheets API 연동
│   ├── blocks.ts        # 단말 목록 Block Kit 컴포넌트
│   └── slack.ts         # Slack Web API 클라이언트 (현재 미사용)
└── app/
    └── page.tsx         # 빈 페이지 (봇 전용 앱)
vacation.json            # 관리자 휴가 기간 목록 (배열, 비어있으면 휴가 모드 비활성)
```

## 관리자 휴가 설정

휴가 기간은 프로젝트 루트 `vacation.json`에서 관리합니다.

```json
[
  { "from": "2026-07-14", "to": "2026-07-18" }
]
```

- 날짜 형식: `YYYY-MM-DD`
- 여러 기간 등록 가능
- 빈 배열 `[]` = 휴가 없음
- 추후 Slack 커맨드(`연차 추가 / 연차 확인 / 연차 삭제`)로 관리 예정 — 그 전까지는 파일 직접 수정

## Google Sheets 구조

### 대여 가능 단말 확인 (A:E)
대여 가능한 단말 목록. 봇이 목록 조회 시 사용.
- 헤더: 자산번호, 모델명, 제조사, OS 버전, ...

### 대여이력 (A:H)
| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| 자산번호 | 모델명 | 대여자 | 대여일 | 반납예정일 | 대여시각 | 반납시각 | Slack_ID |

- 반납시각(G)이 비어있으면 = 현재 대여중
- 대여 승인 시 행 추가, 반납 시 G열에 반납시각 기록

### 전체_단말리스트
- 자산번호: **E열**
- 대여자: **L열**, 대여일: **M열**, 반납예정일: **N열**
- 대여 시 L/M/N 업데이트, 반납 시 초기화

### 사용중_단말리스트
- 현재 미사용 (getDueToday는 대여이력 기준으로 변경됨)

## 봇 시작 방식

`src/instrumentation.ts`의 `register()` 함수가 Next.js 서버 시작 시 자동 호출됨.
모듈 변수(`botStarted`)로 중복 실행 방지. 락 파일 방식은 좀비 프로세스 문제로 제거.

## 반납 알림 스케줄러

- 매일 **오전 10:45** (Asia/Seoul) 실행
- `대여이력` 시트에서 반납예정일=오늘 AND 반납시각 비어있는 행 조회
- 관리자에게 요약, 대여자에게 개별 알림 발송

## 로컬 개발

```bash
npm run dev
```

- 이전 프로세스가 살아있으면 `kill -9 <PID>` 후 재실행
- `/tmp/slackbot.lock` 파일이 남아있으면 `rm /tmp/slackbot.lock` 후 재실행

## Slack 앱 설정 (api.slack.com)

- **Socket Mode**: ON
- **Event Subscriptions**: ON
  - Bot Events: `message.im`, `app_mention`
- **Interactivity**: ON (모달, 버튼 액션 처리)
