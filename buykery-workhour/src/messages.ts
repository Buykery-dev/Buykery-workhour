import { findOpenPause, formatDuration, getActiveAwayWindow, getEffectiveStatus, getStatusEmoji, getStatusLabel, summarizeShift } from "./domain.js";
import type { ParsedManualInput, ShiftSummary, WeeklyMemberSummary } from "./domain.js";
import type { ShiftState, UserSession, WorkStatus } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

export function createMention(userId: number, displayName: string): string {
  return `<a href="tg://user?id=${userId}">${escapeHtml(displayName)}</a>`;
}

export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function buildWelcomeMessage(mention: string): string {
  return [
    `👋 ${mention} 반가워요!`,
    "",
    "여기는 <b>Buykery 근태 텔레그램 봇</b>이에요.",
    "그룹 채팅에서 아래 명령어로 근무 상태를 남길 수 있어요.",
    "",
    "• /start 근무 시작 또는 복귀",
    "• /back 쉬는 상태에서 업무 복귀",
    "• /stop 잠깐 쉬는 중",
    "• /lunch 식사 중",
    "• /meeting 회의 중",
    "• /focus 집중 작업 중",
    "• /outside 외근 중",
    "• /manual 시간대를 입력해서 부재 안내",
    "• /status 내 현재 상태 확인",
    "• /team 방 안의 현재 상태 보기",
    "• /end 오늘 근무 종료",
    "• /help 사용법 보기"
  ].join("\n");
}

export function buildHelpMessage(): string {
  return [
    "🧾 <b>사용 가능한 명령어</b>",
    "",
    "• /start",
    "근무 시작 또는 쉬는 상태에서 복귀해요.",
    "",
    "• /back",
    "쉬는 상태에서 복귀할 때 바로 쓰는 빠른 복귀 명령이에요.",
    "",
    "• /stop",
    "짧은 휴식, 외근 준비, 잠깐 자리 비움 상태로 바꿔요.",
    "",
    "• /lunch",
    "점심이나 식사 시간을 기록해요.",
    "",
    "• /meeting",
    "회의 중이라 바로 응답이 어려운 상태를 남겨요.",
    "",
    "• /focus",
    "집중 작업 중이라 알림 확인이 늦을 수 있을 때 써요.",
    "",
    "• /outside",
    "외근, 이동, 현장 대응처럼 자리 밖 업무일 때 써요.",
    "",
    "• /manual",
    "예: <code>15:00-16:30 병원 다녀올게요</code>",
    "봇이 답장 입력창을 띄우면 시간대를 적어 주세요.",
    "",
    "• /status",
    "내 현재 근무 상태와 누적 근무 시간을 보여줘요.",
    "",
    "• /team",
    "이 방에서 봇을 쓰는 팀원 상태를 한 번에 보여줘요.",
    "",
    "• /end",
    "오늘 근무를 종료하고 총 근무 시간을 계산해요.",
    "",
    "추가 팁:",
    "텔레그램은 사용자가 대신 자동으로 채팅을 치게 할 수 없어서, 봇이 직접 멘션해서 안내해요."
  ].join("\n");
}

function statusTone(status: WorkStatus): string {
  switch (status) {
    case "working":
      return "집중해서 일하고 있어요.";
    case "break":
      return "잠깐 쉬고 곧 돌아올게요.";
    case "lunch":
      return "든든하게 먹고 다시 달릴게요.";
    case "manual":
      return "일정이 있어 잠시 자리를 비워요.";
    case "meeting":
      return "회의 중이라 답장이 조금 늦을 수 있어요.";
    case "focus":
      return "집중 작업 중이라 확인이 늦을 수 있어요.";
    case "outside":
      return "외부 일정 중이라 급한 용건은 전화가 좋아요.";
    default:
      return "상태를 업데이트했어요.";
  }
}

export function buildStartMessage(mention: string, now: Date, mode: "started" | "resumed" | "noop"): string {
  if (mode === "noop") {
    return `🟢 ${mention} 이미 근무 중이에요. 오늘도 흐름 좋습니다!`;
  }

  if (mode === "resumed") {
    return `🟢 ${formatDateTime(now)} ${mention} 잘 쉬고 왔어요. 다시 근무 시작!`;
  }

  return `🟢 ${formatDateTime(now)} ${mention} 근무 시작! 지금 일하고 있어요.`;
}

export function buildPauseMessage(mention: string, status: Exclude<WorkStatus, "working">, mode: "paused" | "switched" | "noop"): string {
  if (mode === "noop") {
    return `${getStatusEmoji(status)} ${mention} 현재 상태가 이미 <b>${getStatusLabel(status)}</b>이에요.`;
  }

  return `${getStatusEmoji(status)} ${mention} <b>${getStatusLabel(status)}</b>로 변경됐어요. ${statusTone(status)}`;
}

export function buildEndMessage(mention: string, summary: ShiftSummary): string {
  return [
    `🏁 ${mention} 오늘 근무 끝!`,
    `• 총 경과 시간: ${formatDuration(summary.totalElapsedMs)}`,
    `• 쉬는 시간: ${formatDuration(summary.totalPausedMs)}`,
    `• 오늘의 근무 시간: <b>${formatDuration(summary.workedMs)}</b>`
  ].join("\n");
}

export function buildStatusMessage(mention: string, shift: ShiftState, now: Date): string {
  const summary = summarizeShift(shift, now);
  const openPause = findOpenPause(shift);
  const effectiveStatus = getEffectiveStatus(shift, now);
  const activeAwayWindow = getActiveAwayWindow(shift, now);
  const noteLine =
    activeAwayWindow
      ? `• 부재 안내: ${formatDateTime(new Date(activeAwayWindow.from))} ~ ${formatDateTime(new Date(activeAwayWindow.to))}${activeAwayWindow.note ? ` (${escapeHtml(activeAwayWindow.note)})` : ""}`
      : shift.manualAwayNote
        ? `• 다음 부재: ${formatDateTime(new Date(shift.manualAwayNote.from))} ~ ${formatDateTime(new Date(shift.manualAwayNote.to))}${shift.manualAwayNote.note ? ` (${escapeHtml(shift.manualAwayNote.note)})` : ""}`
      : openPause?.note
        ? `• 메모: ${escapeHtml(openPause.note)}`
        : undefined;

  const lines = [
    `${getStatusEmoji(effectiveStatus)} ${mention} 현재 상태는 <b>${getStatusLabel(effectiveStatus)}</b>이에요.`,
    `• 시작 시각: ${formatDateTime(new Date(shift.startedAt))}`,
    `• 누적 근무 시간: <b>${formatDuration(summary.workedMs)}</b>`,
    `• 누적 쉬는 시간: ${formatDuration(summary.totalPausedMs)}`
  ];

  if (noteLine) {
    lines.push(noteLine);
  }

  return lines.join("\n");
}

export function buildNoShiftMessage(mention: string): string {
  return `🌙 ${mention} 아직 시작된 근무가 없어요. /start 로 오늘 근무를 시작해 주세요.`;
}

export function buildManualPrompt(mention: string): string {
  return [
    `📅 ${mention} 부재 시간을 입력해 주세요.`,
    "",
    "버튼으로 빠르게 고르거나, 아래 형식 중 하나로 답장하면 돼요.",
    "• <code>15:00-16:30 병원 다녀올게요</code>",
    "• <code>2026-03-30 15:00 - 2026-03-30 17:00 외근</code>",
    "",
    "입력한 시간대는 근무시간 계산에서 자동으로 제외돼요."
  ].join("\n");
}

export function buildManualSavedMessage(mention: string, parsed: ParsedManualInput): string {
  const noteSuffix = parsed.note ? `\n• 메모: ${escapeHtml(parsed.note)}` : "";
  const tone = parsed.from.getTime() <= Date.now() ? "이 시간대는 근무시간에서 자동 제외할게요." : "예정된 부재 시간으로 저장해 둘게요.";
  return [
    `📅 ${mention} ${formatDateTime(parsed.from)}부터 ${formatDateTime(parsed.to)}까지 부재중입니다.`,
    tone,
    "긴급한 경우 전화로 부탁드려요.",
    noteSuffix
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildManualParseError(mention: string): string {
  return [
    `⚠️ ${mention} 시간을 이해하지 못했어요.`,
    "예시처럼 다시 답장해 주세요: <code>15:00-16:30 외근</code>"
  ].join("\n");
}

export function buildTeamStatusMessage(sessions: UserSession[], now: Date): string {
  if (sessions.length === 0) {
    return "👥 아직 이 방에서 상태를 기록한 팀원이 없어요.";
  }

  const body = sessions.map((session) => {
    const mention = createMention(session.userId, session.displayName);
    if (!session.shift) {
      return `• ${mention} : 아직 시작 전`;
    }

    const summary = summarizeShift(session.shift, now);
    const effectiveStatus = getEffectiveStatus(session.shift, now);
    return `• ${getStatusEmoji(effectiveStatus)} ${mention} : ${getStatusLabel(effectiveStatus)} / ${formatDuration(summary.workedMs)}`;
  });

  return ["👥 <b>Buykery 팀 상태 보드</b>", ...body].join("\n");
}

export function buildWeeklySummaryMessage(weekLabel: string, members: WeeklyMemberSummary[]): string {
  if (members.length === 0) {
    return [
      `📊 <b>${weekLabel} 주간 근무 리포트</b>`,
      "이번 주에 집계된 근무 기록이 아직 없어요."
    ].join("\n");
  }

  const lines = members.map((member, index) => {
    const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "•";
    const name = createMention(member.userId, member.displayName);
    return `${medal} ${name} : <b>${formatDuration(member.workedMs)}</b>`;
  });

  return [
    `📊 <b>${weekLabel} 주간 근무 리포트</b>`,
    "일요일 23:59 기준, 이번 주 총 근무시간이에요.",
    ...lines
  ].join("\n");
}
