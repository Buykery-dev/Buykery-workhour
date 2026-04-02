import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";
import {
  addAwayWindow,
  buildManualEditPayloadWithBreak,
  createSessionKey,
  endShift,
  formatDuration,
  getSeoulDateKey,
  isManualInputReply,
  parseBreakMinutesInput,
  parseClockTime,
  parseEditDateInput,
  parseManualInput,
  setPausedStatus,
  sortSessionsForTeamView,
  trimActiveAwayWindow,
  startOrResumeShift
} from "./domain.js";
import {
  buildEditBreakPrompt,
  buildEditDatePrompt,
  buildEditEndPrompt,
  buildEditOngoingSavedMessage,
  buildEditParseError,
  buildEditSavedMessage,
  buildEditStartPrompt,
  buildEndMessage,
  buildHelpMessage,
  buildManualParseError,
  buildManualPrompt,
  buildManualSavedMessage,
  buildNoShiftMessage,
  buildPauseMessage,
  buildStartMessage,
  buildStatusMessage,
  buildTeamStatusMessage,
  createMention
} from "./messages.js";
import { FileStateStore } from "./storage.js";
import type { AwayWindow, CompletedShiftRecord, ShiftState, UserSession, WorkStatus } from "./types.js";

function getDisplayName(ctx: Context): string {
  const firstName = ctx.from?.first_name ?? "팀원";
  const lastName = ctx.from?.last_name?.trim();
  return lastName ? `${firstName} ${lastName}` : firstName;
}

function getSessionFromContext(ctx: Context, store: FileStateStore): { key: string; session: UserSession; mention: string } | undefined {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;

  if (!chatId || !userId || !ctx.from) {
    return undefined;
  }

  const key = createSessionKey(chatId, userId);
  const existing = store.getSession(key);
  const displayName = getDisplayName(ctx);
  const mention = createMention(userId, displayName);

  return {
    key,
    mention,
    session: {
      chatId,
      userId,
      displayName,
      username: ctx.from.username,
      shift: existing?.shift,
      pendingManual: existing?.pendingManual,
      pendingEdit: existing?.pendingEdit,
      updatedAt: new Date().toISOString()
    }
  };
}

function recentDateOptions(now: Date): Array<{ label: string; value: string }> {
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    return {
      label: offset === 0 ? "오늘" : offset === 1 ? "어제" : `${date.getMonth() + 1}/${date.getDate()}`,
      value: getSeoulDateKey(date)
    };
  });
}

function isTodayDateKey(dateKey: string, now: Date): boolean {
  return dateKey === getSeoulDateKey(now);
}

function createActiveShiftFromEdit(startedAt: string): ShiftState {
  return {
    startedAt,
    currentStatus: "working",
    totalPausedMs: 0,
    pauses: [],
    awayWindows: []
  };
}

async function replyHtml(ctx: Context, html: string): Promise<void> {
  await ctx.reply(html, {
    parse_mode: "HTML",
    link_preview_options: {
      is_disabled: true
    }
  });
}

async function handlePause(
  ctx: Context,
  store: FileStateStore,
  status: Exclude<WorkStatus, "working">
): Promise<void> {
  const current = getSessionFromContext(ctx, store);
  if (!current) {
    return;
  }

  const now = new Date();
  const result = setPausedStatus(current.session.shift, status, now);
  if (result.mode === "missing" || !result.shift) {
    await replyHtml(ctx, buildNoShiftMessage(current.mention));
    return;
  }

  current.session.shift = result.shift;
  current.session.updatedAt = now.toISOString();
  await store.upsertSession(current.key, current.session);
  await replyHtml(ctx, buildPauseMessage(current.mention, status, result.mode));
}

export function createBot(token: string, store: FileStateStore): Telegraf {
  const bot = new Telegraf(token);

  bot.catch((error) => {
    console.error("Telegram bot error:", error);
  });

  bot.command("help", async (ctx) => {
    await replyHtml(ctx, buildHelpMessage());
  });

  bot.hears(/^help$/i, async (ctx) => {
    await replyHtml(ctx, buildHelpMessage());
  });

  bot.command("start", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return;
    }

    const now = new Date();
    const result = startOrResumeShift(current.session.shift ? trimActiveAwayWindow(current.session.shift, now) : undefined, now);
    current.session.shift = result.shift;
    delete current.session.pendingManual;
    current.session.updatedAt = now.toISOString();

    await store.upsertSession(current.key, current.session);
    await replyHtml(ctx, buildStartMessage(current.mention, now, result.mode));
  });

  bot.command("back", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return;
    }

    const now = new Date();
    const result = startOrResumeShift(current.session.shift ? trimActiveAwayWindow(current.session.shift, now) : undefined, now);
    current.session.shift = result.shift;
    delete current.session.pendingManual;
    current.session.updatedAt = now.toISOString();

    await store.upsertSession(current.key, current.session);
    await replyHtml(ctx, buildStartMessage(current.mention, now, result.mode));
  });

  bot.command("stop", async (ctx) => {
    await handlePause(ctx, store, "break");
  });

  bot.command("lunch", async (ctx) => {
    await handlePause(ctx, store, "lunch");
  });

  bot.command("meeting", async (ctx) => {
    await handlePause(ctx, store, "meeting");
  });

  bot.command("focus", async (ctx) => {
    await handlePause(ctx, store, "focus");
  });

  bot.command("outside", async (ctx) => {
    await handlePause(ctx, store, "outside");
  });

  bot.command("manual", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return;
    }

    if (!current.session.shift) {
      await replyHtml(ctx, buildNoShiftMessage(current.mention));
      return;
    }

    const prompt = await ctx.reply(buildManualPrompt(current.mention), {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("30분", "manual:30"),
          Markup.button.callback("1시간", "manual:60"),
          Markup.button.callback("2시간", "manual:120")
        ],
        [
          Markup.button.callback("3시간", "manual:180"),
          Markup.button.callback("직접 입력", "manual:custom"),
          Markup.button.callback("취소", "manual:cancel")
        ]
      ])
    });

    current.session.pendingManual = {
      promptMessageId: prompt.message_id,
      createdAt: new Date().toISOString()
    };
    current.session.updatedAt = new Date().toISOString();

    await store.upsertSession(current.key, current.session);
  });

  bot.command("edit", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return;
    }

    const dateButtons = recentDateOptions(new Date());
    const prompt = await ctx.reply(buildEditDatePrompt(current.mention), {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        dateButtons.slice(0, 4).map((option) => Markup.button.callback(option.label, `edit:date:${option.value}`)),
        dateButtons.slice(4).map((option) => Markup.button.callback(option.label, `edit:date:${option.value}`)),
        [Markup.button.callback("직접 입력", "edit:date:custom"), Markup.button.callback("취소", "edit:cancel")]
      ])
    });

    current.session.pendingEdit = {
      step: "date",
      promptMessageId: prompt.message_id,
      createdAt: new Date().toISOString()
    };
    current.session.updatedAt = new Date().toISOString();
    await store.upsertSession(current.key, current.session);
  });

  bot.command("status", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return;
    }

    if (!current.session.shift) {
      await replyHtml(ctx, buildNoShiftMessage(current.mention));
      return;
    }

    await replyHtml(ctx, buildStatusMessage(current.mention, current.session.shift, new Date()));
  });

  bot.command("team", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const sessions = sortSessionsForTeamView(store.getSessionsByChat(chatId));
    await replyHtml(ctx, buildTeamStatusMessage(sessions, new Date()));
  });

  bot.command("end", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return;
    }

    const now = new Date();
    const result = endShift(current.session.shift, now);

    if (!result.summary) {
      await replyHtml(ctx, buildNoShiftMessage(current.mention));
      return;
    }

    delete current.session.shift;
    delete current.session.pendingManual;
    current.session.updatedAt = now.toISOString();

    await store.appendCompletedShift({
      chatId: current.session.chatId,
      userId: current.session.userId,
      displayName: current.session.displayName,
      username: current.session.username,
      startedAt: result.shift?.startedAt ?? now.toISOString(),
      endedAt: now.toISOString(),
      workedMs: result.summary.workedMs,
      pausedMs: result.summary.totalPausedMs,
      pauses: result.shift?.pauses ?? [],
      awayWindows: result.shift?.awayWindows ?? []
    });
    await store.upsertSession(current.key, current.session);
    await replyHtml(ctx, buildEndMessage(current.mention, result.summary));
  });

  bot.action(/^manual:(30|60|120|180)$/, async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current || !current.session.shift) {
      await ctx.answerCbQuery("먼저 /start 로 근무를 시작해 주세요.");
      return;
    }

    const now = new Date();
    const minutes = Number(ctx.match[1]);
    const to = new Date(now.getTime() + minutes * 60_000);
    const awayWindow: AwayWindow = {
      from: now.toISOString(),
      to: to.toISOString(),
      note: `${minutes}분 부재`,
      createdAt: now.toISOString()
    };

    current.session.shift = addAwayWindow(current.session.shift, awayWindow);
    current.session.updatedAt = now.toISOString();
    await store.upsertSession(current.key, current.session);
    await ctx.answerCbQuery(`${minutes}분 부재로 저장했어요.`);
    await ctx.reply(buildManualSavedMessage(current.mention, { from: now, to, note: awayWindow.note }), {
      parse_mode: "HTML"
    });
  });

  bot.action("manual:custom", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current || !current.session.shift) {
      await ctx.answerCbQuery("먼저 /start 로 근무를 시작해 주세요.");
      return;
    }

    const prompt = await ctx.reply(buildManualPrompt(current.mention), {
      parse_mode: "HTML",
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "예: 15:00-16:30 외근"
      }
    });

    current.session.pendingManual = {
      promptMessageId: prompt.message_id,
      createdAt: new Date().toISOString()
    };
    current.session.updatedAt = new Date().toISOString();
    await store.upsertSession(current.key, current.session);
    await ctx.answerCbQuery("답장 입력칸을 열어뒀어요.");
  });

  bot.action("manual:cancel", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (current) {
      delete current.session.pendingManual;
      current.session.updatedAt = new Date().toISOString();
      await store.upsertSession(current.key, current.session);
    }

    await ctx.answerCbQuery("취소했어요.");
  });

  bot.action(/^edit:date:(.+)$/, async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      await ctx.answerCbQuery("세션을 찾지 못했어요.");
      return;
    }

    const value = ctx.match[1];
    if (value === "custom") {
      const prompt = await ctx.reply(buildEditDatePrompt(current.mention), {
        parse_mode: "HTML",
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "예: 2026-04-02"
        }
      });

      current.session.pendingEdit = {
        step: "date",
        promptMessageId: prompt.message_id,
        createdAt: new Date().toISOString()
      };
      current.session.updatedAt = new Date().toISOString();
      await store.upsertSession(current.key, current.session);
      await ctx.answerCbQuery("날짜 입력칸을 열어뒀어요.");
      return;
    }

    const prompt = await ctx.reply(buildEditStartPrompt(current.mention, value), {
      parse_mode: "HTML",
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "예: 09:00"
      }
    });

    current.session.pendingEdit = {
      step: "start",
      promptMessageId: prompt.message_id,
      createdAt: new Date().toISOString(),
      selectedDate: value
    };
    current.session.updatedAt = new Date().toISOString();
    await store.upsertSession(current.key, current.session);
    await ctx.answerCbQuery(`${value} 선택 완료`);
  });

  bot.action("edit:cancel", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (current) {
      delete current.session.pendingEdit;
      current.session.updatedAt = new Date().toISOString();
      await store.upsertSession(current.key, current.session);
    }
    await ctx.answerCbQuery("수정을 취소했어요.");
  });

  bot.action("edit:end:ongoing", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current || !current.session.pendingEdit?.selectedDate || !current.session.pendingEdit.startTime) {
      await ctx.answerCbQuery("수정 흐름을 다시 시작해 주세요.");
      return;
    }

    const { selectedDate, startTime } = current.session.pendingEdit;
    if (!selectedDate || !startTime) {
      await ctx.answerCbQuery("수정 흐름을 다시 시작해 주세요.");
      return;
    }

    if (!isTodayDateKey(selectedDate, new Date())) {
      await ctx.answerCbQuery("오늘 날짜에서만 사용할 수 있어요.");
      return;
    }

    const startedAt = `${selectedDate}T${startTime}:00+09:00`;
    current.session.shift = createActiveShiftFromEdit(startedAt);
    delete current.session.pendingEdit;
    current.session.updatedAt = new Date().toISOString();

    await store.deleteCompletedShifts(
      (record) =>
        record.chatId === current.session.chatId &&
        record.userId === current.session.userId &&
        getSeoulDateKey(new Date(record.startedAt)) === selectedDate
    );
    await store.upsertSession(current.key, current.session);
    await ctx.answerCbQuery("현재 근무 중 상태로 저장했어요.");
    await replyHtml(ctx, buildEditOngoingSavedMessage(current.mention, selectedDate, startTime));
  });

  bot.action(/^edit:break:(0|30|60|90)$/, async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current || !current.session.pendingEdit?.selectedDate || !current.session.pendingEdit.startTime || !current.session.pendingEdit.endTime) {
      await ctx.answerCbQuery("수정 흐름을 다시 시작해 주세요.");
      return;
    }

    const breakMinutes = Number(ctx.match[1]);
    const payload = buildManualEditPayloadWithBreak(
      current.session.pendingEdit.selectedDate,
      current.session.pendingEdit.startTime,
      current.session.pendingEdit.endTime,
      breakMinutes
    );

    if (!payload) {
      await ctx.answerCbQuery("휴게 시간이 너무 길어요.");
      return;
    }

    const nextRecord: CompletedShiftRecord = {
      chatId: current.session.chatId,
      userId: current.session.userId,
      displayName: current.session.displayName,
      username: current.session.username,
      startedAt: payload.startedAt,
      endedAt: payload.endedAt,
      workedMs: payload.workedMs,
      pausedMs: payload.pausedMs,
      pauses: [],
      awayWindows: []
    };

    await store.upsertCompletedShift(
      (record) =>
        record.chatId === current.session.chatId &&
        record.userId === current.session.userId &&
        getSeoulDateKey(new Date(record.startedAt)) === payload.dateKey,
      nextRecord
    );

    delete current.session.pendingEdit;
    current.session.updatedAt = new Date().toISOString();
    await store.upsertSession(current.key, current.session);
    await ctx.answerCbQuery("휴게 시간까지 반영했어요.");
    await replyHtml(
      ctx,
      buildEditSavedMessage(
        current.mention,
        payload.dateKey,
        nextRecord.startedAt.slice(11, 16),
        nextRecord.endedAt.slice(11, 16),
        formatDuration(payload.pausedMs),
        formatDuration(payload.workedMs)
      )
    );
  });

  bot.action("edit:break:custom", async (ctx) => {
    const current = getSessionFromContext(ctx, store);
    if (!current || !current.session.pendingEdit?.selectedDate || !current.session.pendingEdit.startTime || !current.session.pendingEdit.endTime) {
      await ctx.answerCbQuery("수정 흐름을 다시 시작해 주세요.");
      return;
    }

    const prompt = await ctx.reply(
      buildEditBreakPrompt(
        current.mention,
        current.session.pendingEdit.selectedDate,
        current.session.pendingEdit.startTime,
        current.session.pendingEdit.endTime
      ),
      {
        parse_mode: "HTML",
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "예: 30 또는 1:30"
        }
      }
    );

    current.session.pendingEdit = {
      ...current.session.pendingEdit,
      step: "break",
      promptMessageId: prompt.message_id,
      createdAt: new Date().toISOString()
    };
    current.session.updatedAt = new Date().toISOString();
    await store.upsertSession(current.key, current.session);
    await ctx.answerCbQuery("휴게 시간 입력칸을 열어뒀어요.");
  });

  bot.on("text", async (ctx, next) => {
    const current = getSessionFromContext(ctx, store);
    if (!current) {
      return next();
    }

    const replyToMessageId = ctx.message.reply_to_message?.message_id;
    if (current.session.pendingEdit && replyToMessageId === current.session.pendingEdit.promptMessageId) {
      const pendingEdit = current.session.pendingEdit;
      const now = new Date();

      if (pendingEdit.step === "date") {
        const dateKey = parseEditDateInput(ctx.message.text, now);
        if (!dateKey) {
          await replyHtml(ctx, buildEditParseError(current.mention, "date"));
          return;
        }

        const prompt = await ctx.reply(buildEditStartPrompt(current.mention, dateKey), {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "예: 09:00"
          }
        });

        current.session.pendingEdit = {
          step: "start",
          promptMessageId: prompt.message_id,
          createdAt: now.toISOString(),
          selectedDate: dateKey
        };
        current.session.updatedAt = now.toISOString();
        await store.upsertSession(current.key, current.session);
        return;
      }

      if (pendingEdit.step === "start") {
        const startTime = parseClockTime(ctx.message.text);
        if (!startTime || !pendingEdit.selectedDate) {
          await replyHtml(ctx, buildEditParseError(current.mention, "time"));
          return;
        }

        const prompt = await ctx.reply(buildEditEndPrompt(current.mention, pendingEdit.selectedDate, startTime), {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "예: 18:30"
          }
        });

        if (isTodayDateKey(pendingEdit.selectedDate, now)) {
          await ctx.reply("퇴근 전이면 아래 버튼으로 현재 근무 중 상태로 저장할 수 있어요.", {
            ...Markup.inlineKeyboard([[Markup.button.callback("현재 근무 중", "edit:end:ongoing")]])
          });
        }

        current.session.pendingEdit = {
          step: "end",
          promptMessageId: prompt.message_id,
          createdAt: now.toISOString(),
          selectedDate: pendingEdit.selectedDate,
          startTime
        };
        current.session.updatedAt = now.toISOString();
        await store.upsertSession(current.key, current.session);
        return;
      }

      if (pendingEdit.step === "end") {
        const endTime = parseClockTime(ctx.message.text);
        if (!endTime || !pendingEdit.selectedDate || !pendingEdit.startTime) {
          await replyHtml(ctx, buildEditParseError(current.mention, "time"));
          return;
        }

        const payload = buildManualEditPayloadWithBreak(pendingEdit.selectedDate, pendingEdit.startTime, endTime, 0);
        if (!payload) {
          await replyHtml(ctx, `⚠️ ${current.mention} 퇴근 시간은 출근 시간보다 늦어야 해요.`);
          return;
        }

        const prompt = await ctx.reply(buildEditBreakPrompt(current.mention, pendingEdit.selectedDate, pendingEdit.startTime, endTime), {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback("0분", "edit:break:0"),
              Markup.button.callback("30분", "edit:break:30"),
              Markup.button.callback("1시간", "edit:break:60")
            ],
            [
              Markup.button.callback("1시간 30분", "edit:break:90"),
              Markup.button.callback("직접 입력", "edit:break:custom"),
              Markup.button.callback("취소", "edit:cancel")
            ]
          ])
        });

        current.session.pendingEdit = {
          step: "break",
          promptMessageId: prompt.message_id,
          createdAt: now.toISOString(),
          selectedDate: pendingEdit.selectedDate,
          startTime: pendingEdit.startTime,
          endTime
        };
        current.session.updatedAt = now.toISOString();
        await store.upsertSession(current.key, current.session);
        return;
      }

      const breakMinutes = parseBreakMinutesInput(ctx.message.text);
      if (breakMinutes === undefined || !pendingEdit.selectedDate || !pendingEdit.startTime || !pendingEdit.endTime) {
        await replyHtml(ctx, buildEditParseError(current.mention, "time"));
        return;
      }

      const payload = buildManualEditPayloadWithBreak(pendingEdit.selectedDate, pendingEdit.startTime, pendingEdit.endTime, breakMinutes);
      if (!payload) {
        await replyHtml(ctx, `⚠️ ${current.mention} 휴게 시간이 전체 근무시간보다 길 수는 없어요.`);
        return;
      }

      const nextRecord: CompletedShiftRecord = {
        chatId: current.session.chatId,
        userId: current.session.userId,
        displayName: current.session.displayName,
        username: current.session.username,
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
        workedMs: payload.workedMs,
        pausedMs: payload.pausedMs,
        pauses: [],
        awayWindows: []
      };

      await store.upsertCompletedShift(
        (record) =>
          record.chatId === current.session.chatId &&
          record.userId === current.session.userId &&
          getSeoulDateKey(new Date(record.startedAt)) === payload.dateKey,
        nextRecord
      );

      delete current.session.pendingEdit;
      current.session.updatedAt = now.toISOString();
      await store.upsertSession(current.key, current.session);
      await replyHtml(
        ctx,
        buildEditSavedMessage(
          current.mention,
          payload.dateKey,
          pendingEdit.startTime,
          pendingEdit.endTime,
          formatDuration(payload.pausedMs),
          formatDuration(payload.workedMs)
        )
      );
      return;
    }

    if (!isManualInputReply(current.session, replyToMessageId)) {
      return next();
    }

    const parsed = parseManualInput(ctx.message.text, new Date());
    if (!parsed) {
      await replyHtml(ctx, buildManualParseError(current.mention));
      return;
    }

    if (!current.session.shift) {
      await replyHtml(ctx, buildNoShiftMessage(current.mention));
      return;
    }

    const now = new Date();
    const awayWindow: AwayWindow = {
      from: parsed.from.toISOString(),
      to: parsed.to.toISOString(),
      note: parsed.note,
      createdAt: now.toISOString()
    };

    current.session.shift = addAwayWindow(current.session.shift, awayWindow);
    delete current.session.pendingManual;
    current.session.updatedAt = now.toISOString();

    await store.upsertSession(current.key, current.session);
    await replyHtml(ctx, buildManualSavedMessage(current.mention, parsed));
  });

  return bot;
}
