import { findOpenPause, formatDuration, getActiveAwayWindow, getEffectiveStatus, getStatusEmoji, getStatusLabel, isWeekendInSeoul, summarizeShift } from "./domain.js";
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
    timeZone: "Asia/Seoul",
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
    "• /lunch 또는 /bab 식사 중",
    "• /meeting 회의 중",
    "• /focus 집중 작업 중",
    "• /outside 외근 중",
    "• /manual 시간대를 입력해서 부재 안내",
    "• /edit 날짜별 근무 시간 수정",
    "• /status 내 현재 상태 확인",
    "• /team 방 안의 현재 상태 보기",
    "• /end 현재 근무 종료",
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
    "• /lunch 또는 /bab",
    "점심이나 식사 시간을 기록해요. 일반 텍스트 <code>밥</code>도 인식해요.",
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
    "• /edit",
    "날짜를 고른 뒤 출근/퇴근/휴게 시간을 직접 수정해요.",
    "",
    "• /status",
    "내 현재 근무 상태, 누적 근무 시간, 이번 주 근무 시간을 보여줘요.",
    "",
    "• /team",
    "이 방에서 봇을 쓰는 팀원 상태를 한 번에 보여줘요.",
    "",
    "• /end",
    "현재 진행 중인 근무를 종료하고 총 근무 시간을 계산해요.",
    "",
    "추가 팁:",
    "텔레그램은 사용자가 대신 자동으로 채팅을 치게 할 수 없어서, 봇이 직접 멘션해서 안내해요."
  ].join("\n");
}

export function buildDeploymentNoticeMessage(versionLabel: string | undefined, summaryLines: string[]): string {
  const normalizedSummary = summaryLines
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter(Boolean);

  return [
    "📦 <b>Buykery 근태 봇이 업데이트됐어요.</b>",
    versionLabel ? `• 배포 버전: <code>${escapeHtml(versionLabel)}</code>` : undefined,
    "• 저장된 근무 시간과 완료 기록은 업데이트 뒤에도 그대로 유지돼요.",
    "",
    "<b>이번 업데이트</b>",
    ...(normalizedSummary.length > 0
      ? normalizedSummary.map((line) => `• ${escapeHtml(line)}`)
      : ["• 이번 배포 요약은 아직 등록되지 않았어요."])
  ]
    .filter(Boolean)
    .join("\n");
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

  const weekendTone = isWeekendInSeoul(now) ? "\n주말에 출근이라니? Buykery는 대박나겠는걸요?" : "";
  return `🟢 ${formatDateTime(now)} ${mention} 근무 시작! 지금 일하고 있어요.${weekendTone}`;
}

export function buildPauseMessage(mention: string, status: Exclude<WorkStatus, "working">, mode: "paused" | "switched" | "noop"): string {
  if (mode === "noop") {
    return `${getStatusEmoji(status)} ${mention} 현재 상태가 이미 <b>${getStatusLabel(status)}</b>이에요.`;
  }

  return `${getStatusEmoji(status)} ${mention} 현재 상태는 <b>${getStatusLabel(status)}</b>이에요. ${statusTone(status)}`;
}

export function buildEndMessage(mention: string, summary: ShiftSummary, now: Date): string {
  return [
    `🏁 ${mention} 근무 종료!`,
    `• 총 경과 시간: ${formatDuration(summary.totalElapsedMs)}`,
    `• 쉬는 시간: ${formatDuration(summary.totalPausedMs)}`,
    `• 실제 근무 시간: <b>${formatDuration(summary.workedMs)}</b>`,
    isWeekendInSeoul(now) ? "고생하셨어요. 남은 주말 알차게, 행복하게 보내세요." : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildStatusMessage(mention: string, shift: ShiftState, now: Date, weeklyWorkedMs: number): string {
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
    `• 누적 쉬는 시간: ${formatDuration(summary.totalPausedMs)}`,
    `• 이번 주 누적 근무 시간: <b>${formatDuration(weeklyWorkedMs)}</b>`
  ];

  if (noteLine) {
    lines.push(noteLine);
  }

  return lines.join("\n");
}

export function buildNoShiftMessage(mention: string): string {
  return `🌙 ${mention} 아직 시작된 근무가 없어요. /start 로 근무를 시작해 주세요.`;
}

export function buildIdleStatusMessage(mention: string, weeklyWorkedMs: number): string {
  return [
    `🌙 ${mention} 현재 진행 중인 근무는 없어요.`,
    `• 이번 주 누적 근무 시간: <b>${formatDuration(weeklyWorkedMs)}</b>`
  ].join("\n");
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

export function buildEditDatePrompt(mention: string): string {
  return [
    `🛠️ ${mention} 수정할 날짜를 골라 주세요.`,
    "",
    "버튼이 없으면 이 메시지에 답장으로 <code>2026-04-02</code> 또는 <code>04-02</code> 형식으로 입력해도 돼요."
  ].join("\n");
}

export function buildEditStartPrompt(mention: string, dateKey: string): string {
  return [
    `🕘 ${mention} <b>${dateKey}</b>의 출근 시간을 입력해 주세요.`,
    "예: <code>09:00</code>"
  ].join("\n");
}

export function buildEditWorkedPrompt(mention: string, dateKey: string): string {
  return [
    `🧾 ${mention} <b>${dateKey}</b> 근무 시간을 수정할게요.`,
    "출퇴근 체크를 잊어버리셨군요! 몇 시간이나 일했어요? 휴식 시간 제외하고 말씀해 주세요.",
    "예: <code>8</code>, <code>8.5</code>, <code>8:30</code>"
  ].join("\n");
}

export function buildEditEndPrompt(mention: string, dateKey: string, startTime: string): string {
  return [
    `🕕 ${mention} <b>${dateKey}</b>의 퇴근 시간을 입력해 주세요.`,
    `현재 출근 시간: <code>${startTime}</code>`,
    "예: <code>18:30</code>",
    "자정을 넘긴 퇴근은 <code>08:00</code>처럼 입력하면 다음 날로 처리돼요.",
    "오늘 날짜라면 아래 버튼으로 <b>현재 근무 중</b> 상태로 저장할 수도 있어요."
  ].join("\n");
}

export function buildEditBreakPrompt(mention: string, dateKey: string, startTime: string, endLabel: string): string {
  return [
    `☕ ${mention} <b>${dateKey}</b>의 총 휴게 시간을 입력해 주세요.`,
    `• 출근: ${startTime}`,
    `• 퇴근: ${endLabel}`,
    "",
    "버튼으로 빠르게 고르거나 <code>30</code>, <code>90</code>, <code>1:30</code> 형식으로 답장할 수 있어요."
  ].join("\n");
}

export function buildEditSavedMessage(
  mention: string,
  dateKey: string,
  startTime: string,
  endLabel: string,
  breakLabel: string,
  workedLabel: string
): string {
  return [
    `✅ ${mention} <b>${dateKey}</b> 근무 시간을 수정했어요.`,
    `• 출근: ${startTime}`,
    `• 퇴근: ${endLabel}`,
    `• 휴게: ${breakLabel}`,
    `• 총 근무 시간: <b>${workedLabel}</b>`,
    "이 수동 수정은 시작 날짜 기준 기록으로 다시 계산해요."
  ].join("\n");
}

export function buildEditWorkedSavedMessage(mention: string, dateKey: string, workedLabel: string): string {
  return [
    `✅ ${mention} <b>${dateKey}</b> 근무 시간을 수정했어요.`,
    `• 총 근무 시간: <b>${workedLabel}</b>`,
    "이 기록은 출퇴근 시각 대신 총 근무 시간 기준으로 저장했어요."
  ].join("\n");
}

export function buildEditOngoingSavedMessage(mention: string, dateKey: string, startTime: string): string {
  return [
    `✅ ${mention} <b>${dateKey}</b> 근무를 현재 진행 중으로 수정했어요.`,
    `• 출근: ${startTime}`,
    "• 상태: <b>현재 근무 중</b>",
    "퇴근 시간은 나중에 /end 하거나 다시 /edit 로 수정하면 돼요."
  ].join("\n");
}

export function buildEditParseError(mention: string, mode: "date" | "time" | "worked"): string {
  if (mode === "date") {
    return `⚠️ ${mention} 날짜를 이해하지 못했어요. <code>2026-04-02</code> 또는 <code>04-02</code> 형식으로 다시 입력해 주세요.`;
  }

  if (mode === "worked") {
    return `⚠️ ${mention} 근무 시간을 이해하지 못했어요. <code>8</code>, <code>8.5</code>, <code>8:30</code> 같은 형식으로 다시 입력해 주세요.`;
  }

  return `⚠️ ${mention} 시간을 이해하지 못했어요. <code>09:00</code> 같은 형식으로 다시 입력해 주세요.`;
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
      "지난 주에 집계된 근무 기록이 아직 없어요."
    ].join("\n");
  }

  const lines = members.map((member, index) => {
    const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "•";
    const name = createMention(member.userId, member.displayName);
    return `${medal} ${name} : <b>${formatDuration(member.workedMs)}</b>`;
  });

  return [
    `📊 <b>${weekLabel} 주간 근무 리포트</b>`,
    "KST 기준 지난 월요일 00:00부터 일요일 24:00까지의 총 근무시간이에요.",
    ...lines
  ].join("\n");
}
