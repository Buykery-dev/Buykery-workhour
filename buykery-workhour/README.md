# Buykery Workhour

슬랙 상태 변경창 느낌으로, 텔레그램 그룹 채팅 안에서 팀원들의 근무 상태를 남기고 확인할 수 있는 근태 봇입니다.

## 핵심 기능

- 그룹 채팅 초대형 구조
- `/start`, `/stop`, `/lunch` 또는 `/bab`, `/meeting`, `/focus`, `/focusout`, `/outside`, `/manual`, `/status`, `/team`, `/end`, `/help`
- 명령어를 입력한 사람을 봇이 자동 멘션해서 상태를 안내
- 쉬는 시간 자동 누적 후 `/end` 시 오늘 근무 시간 계산
- `/manual` 답장 입력으로 시간대 기반 부재 공지
- 매주 월요일 00:00 이후(KST) 지난 주 그룹별 총 근무시간 자동 리포트
- 업데이트 배포 시 그룹 채팅에 변경사항 자동 안내
- 영속 저장소에 기록을 남겨 봇 재시작 후에도 상태 유지

## 추천 스택

- Node.js 20+
- TypeScript
- [Telegraf](https://telegraf.js.org/)

Google Apps Script 대신 일반 서버나 VPS, Render, Railway, Fly.io 같은 환경에 올리기 쉬운 구조로 잡았습니다.

## 빠른 시작

```bash
cd /Users/han/Documents/New\ project/buykery-workhour
npm install
cp .env.example .env
```

`.env`에 BotFather에서 발급받은 토큰을 넣습니다.

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
BOT_NAME=Buykery 근태 텔레그램 봇
BOT_USERNAME=whereIamnow_bot
```

현재 연결할 봇 계정:

- Username: `@whereIamnow_bot`

개발 실행:

```bash
npm run dev
```

배포 실행:

```bash
npm run build
npm start
```

## 배포

이 봇은 웹훅 없이 <b>polling</b>으로 동작합니다. 그래서 HTTP 서버 설정 없이, 프로세스가 계속 살아 있는 worker 형태로 배포하면 됩니다.

### Render

이 프로젝트에는 [render.yaml](/Users/han/Documents/New%20project/buykery-workhour/render.yaml)이 포함되어 있어서 바로 worker로 올릴 수 있습니다.

1. GitHub에 이 폴더를 푸시
2. Render에서 `Blueprint` 또는 새 `Worker` 생성
3. 루트 디렉터리를 `buykery-workhour`로 지정
4. 환경 변수 `TELEGRAM_BOT_TOKEN` 입력
5. 배포 후 그룹 채팅에 `@whereIamnow_bot` 초대

참고:

- [render.yaml](/Users/han/Documents/New%20project/buykery-workhour/render.yaml)에 `/data` persistent disk가 포함되어 있습니다.
- 업데이트 공지 내용은 [update-summary.txt](/Users/han/Documents/New%20project/buykery-workhour/update-summary.txt)를 수정해 반영할 수 있습니다.

### Railway

별도 웹서버 없이도 잘 맞습니다.

1. GitHub 레포 연결
2. Root Directory를 `buykery-workhour`로 설정
3. 환경 변수 `TELEGRAM_BOT_TOKEN`, `BOT_NAME`, `BOT_USERNAME` 입력
4. Start Command는 `npm start`

### VPS 또는 Lightsail

직접 서버에 올릴 때는 polling 프로세스만 띄우면 됩니다.

```bash
cd /Users/han/Documents/New\ project/buykery-workhour
npm install
npm run build
npm start
```

`pm2`, `systemd`, `supervisor` 같은 프로세스 매니저를 붙이면 안정적으로 운영할 수 있습니다.

### Docker

컨테이너 배포용 [Dockerfile](/Users/han/Documents/New%20project/buykery-workhour/Dockerfile)도 추가해 두었습니다.

```bash
docker build -t buykery-workhour .
docker run -e TELEGRAM_BOT_TOKEN=123456:ABC... -e BOT_NAME="Buykery 근태 텔레그램 봇" -e BOT_USERNAME="whereIamnow_bot" buykery-workhour
```

## BotFather 설정

1. BotFather에서 새 봇 생성
2. `/setprivacy`를 켜둬도 명령어와 봇 메시지에 대한 답장은 정상 처리 가능
3. 봇을 그룹 채팅에 초대
4. 필요하면 관리자 권한 없이도 사용 가능
5. 그룹에서 슬래시 명령어가 잘 보이도록 BotFather의 `/setcommands`는 코드에서 자동 등록됩니다

## 명령어 동작

### `/start`

- 오늘 첫 근무 시작
- 쉬는 상태에서 다시 복귀

예시:

```txt
3월 30일 09:02 @han 근무 시작! 지금 일하고 있어요.
```

### `/stop`

- 잠깐 쉬는 중
- 외근 준비, 짧은 이탈, 개인 용무 등에 사용

### `/lunch` 또는 `/bab`

- 식사 시간 시작

### `/meeting`

- 회의 중 상태로 변경
- `/back`으로 복귀
- 회의 중 시간은 근무시간 계산에서 제외

### `/outside`

- 외근 또는 이동 중 상태로 변경
- `/back`으로 복귀
- 외근 중 시간은 근무시간 계산에서 제외

### `/focus`

- 집중 근무 시간 기록 시작
- `/back` 또는 `/focusout`으로 집중 근무를 종료하고 일반 근무 중 상태로 복귀
- 집중 근무 시간은 총 근무시간에 포함
- `/status`와 주간 리포트에서는 총 근무시간과 별도로 표시
- 집중 근무 시간은 나중에 수정할 수 없으니 정확하게 시작/종료해야 합니다
- 집중 근무가 1시간 지날 때마다 칭찬 메시지를 보내고, 이전 칭찬 메시지는 자동으로 지웁니다
- 칭찬 메시지는 최대 24시간까지 표시하며, 오래 이어질수록 건강을 챙기라는 말투로 바뀝니다
- 식사 중, 회의 중, 외근 중, 부재 중에는 먼저 `/back`으로 근무 중 상태로 돌아와야 시작 가능

### `/manual`

- 봇이 답장 입력창을 띄웁니다
- 아래처럼 적으면 팀에 공지합니다

```txt
15:00-16:30 병원 다녀올게요
2026-03-30 15:00 - 2026-03-30 17:00 외근
```

참고:

- 텔레그램 봇은 사용자를 대신해 자동으로 채팅을 입력하게 만들 수는 없습니다
- 대신 봇이 해당 사용자를 멘션해서 자연스럽게 안내합니다
- `/manual`은 현재 시점부터 부재 상태로 전환하고, 입력한 시간대는 공지 문구와 상태 확인에 반영됩니다

### `/status`

- 내 현재 상태
- 오늘 누적 근무 시간
- 오늘 집중 근무 시간
- 누적 쉬는 시간
- 이번 주 누적 근무 시간
- 이번 주 집중 근무 시간

### `/team`

- 현재 방에서 봇을 사용 중인 사람들의 상태 보드

### `/end`

- 오늘 근무 종료
- 총 경과 시간, 쉬는 시간, 실제 근무 시간을 계산

## 저장 방식

상태 파일은 아래 경로에 저장됩니다.

```txt
/data/events.csv
```

Render에서는 persistent disk에 저장되고, 로컬 실행에서는 `buykery-workhour/data/events.csv`를 사용합니다.

## 업데이트 알림

- 새 버전이 배포되면 봇이 기존 그룹 채팅에 업데이트 알림을 한 번씩 보냅니다.
- 같은 버전으로 재시작할 때는 중복 발송하지 않습니다.
- 알림 문구는 [update-summary.txt](/Users/han/Documents/New%20project/buykery-workhour/update-summary.txt) 또는 `BOT_UPDATE_SUMMARY` 환경 변수로 관리할 수 있습니다.
- 알림 기능은 `BOT_UPDATE_NOTIFICATIONS_ENABLED=true`일 때 활성화됩니다.

나중에 확장하려면 SQLite 또는 Postgres로 바꾸기 쉬운 구조로 나눠 두었습니다.

## 다음 단계 제안

- `/back`, `/meeting`, `/focus` 같은 추가 상태
- 관리자 전용 `/reset`
- 출퇴근 로그를 Notion / Google Sheets / Supabase에 동기화
- 웹 대시보드 추가
