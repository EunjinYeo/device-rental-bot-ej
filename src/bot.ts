import { App } from "@slack/bolt";
import cron from "node-cron";
import { isHoliday } from "@hyunbinseo/holidays-kr";
import { getAvailableDevices, recordRental, markReturned, extendRental, getDueToday, getOverdueOnDate, appendNetworkAccessList, getLastNetworkCheckDate } from "@/lib/sheets";
import { deviceListBlocks } from "@/lib/blocks";

const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? "U07SRDNADGB";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getRealName(client: any, userId: string): Promise<string> {
  try {
    const res = await client.users.info({ user: userId });
    return res.user?.profile?.display_name || res.user?.profile?.real_name || res.user?.name || userId;
  } catch {
    return userId;
  }
}

export async function startSlackBot() {
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  app.error(async (error) => {
    console.error("[Bolt 오류]", error);
  });

  // ── 멘션 ──
  app.event("app_mention", async ({ event, say }) => {
    if (/빌려|대여|목록|리스트/.test(event.text ?? "")) {
      const devices = await getAvailableDevices();
      await say({ blocks: deviceListBlocks(devices), text: "대여 가능한 단말 목록입니다." });
    } else {
      await say("안녕하세요! 👋 `빌려줘` 또는 `목록`이라고 말씀해주시면 대여 가능한 단말을 보여드릴게요.");
    }
  });

  // ── DM ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.message(async ({ message, say }: any) => {
    if (message.bot_id || message.subtype) return;
    if (message.channel_type !== "im") return;
    const text: string = message.text ?? "";
    if (/빌려|대여|목록|리스트/.test(text)) {
      const devices = await getAvailableDevices();
      await say({ blocks: deviceListBlocks(devices), text: "대여 가능한 단말 목록입니다." });
    } else {
      await say({
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "안녕하세요! 👋 `빌려줘` 또는 `목록`이라고 보내주시면 대여 가능한 단말을 보여드릴게요." } }],
        text: "안녕하세요!",
      });
    }
  });

  // ── 대여 신청 버튼 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action(/^borrow_/, async ({ ack, body, client, action }: any) => {
    await ack();
    const btn = JSON.parse(action.value);
    await client.chat.update({ channel: body.container.channel_id, ts: body.container.message_ts, text: `${btn.model_name} 대여 신청 중...`, blocks: [] });
    await client.views.open({ trigger_id: body.trigger_id, view: borrowModal(btn.asset_no, btn.model_name, btn.os_ver, body.container.channel_id, body.container.message_ts) });
  });

  // ── 승인 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("approve_rental", async ({ ack, body, client, action }: any) => {
    await ack();
    const data = JSON.parse(action.value);
    await recordRental({ assetNo: data.asset_no, modelName: data.model_name, userId: data.user_id, userName: data.user_name, startDate: data.start_date, endDate: data.end_date });
    const rv = JSON.stringify({ asset_no: data.asset_no, model_name: data.model_name, user_id: data.user_id, user_name: data.user_name });
    await client.chat.postMessage({ channel: data.user_id, blocks: approvedBlocks(data.model_name, data.asset_no, data.end_date, rv), text: `${data.model_name} 대여가 승인됐어요.` });
    await client.chat.update({ channel: body.container.channel_id, ts: body.container.message_ts, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_check: *승인 완료!*\n• 대여자 : ${data.user_name}\n• 신청 단말 : ${data.model_name}(${data.asset_no})\n• 대여 기간 : ${data.start_date} ~ ${data.end_date}` } }], text: `승인 완료 — ${data.user_name} / ${data.model_name}` });
  });

  // ── 거절 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("reject_rental", async ({ ack, body, client, action }: any) => {
    await ack();
    const data = JSON.parse(action.value);
    await client.chat.postMessage({ channel: data.user_id, blocks: rejectedBlocks(data.model_name, data.asset_no), text: `*${data.model_name}(${data.asset_no})* 대여 신청이 거절됐어요.` });
    await client.chat.update({ channel: body.container.channel_id, ts: body.container.message_ts, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_check: *거절 완료*\n• 대여자 : ${data.user_name}\n• 단말 : ${data.model_name}(${data.asset_no})` } }], text: `거절 완료 — ${data.user_name} / ${data.model_name}` });
  });

  // ── 기기 변경 후 승인 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("change_device_rental", async ({ ack, body, client, action }: any) => {
    await ack();
    const data = JSON.parse(action.value);
    const devices = await getAvailableDevices();
    const options = devices.map((d) => ({ text: { type: "plain_text", text: `${d["모델명"]} (${d["자산번호"]})` }, value: JSON.stringify({ asset_no: d["자산번호"], model_name: d["모델명"] }) }));
    await client.views.open({ trigger_id: body.trigger_id, view: changeDeviceModal(action.value, body.container.message_ts, body.container.channel_id, data, options) });
  });

  // ── 다른 기기 선택 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("show_device_list", async ({ ack, body, client }: any) => {
    await ack();
    const devices = await getAvailableDevices();
    await client.chat.postMessage({ channel: body.user.id, blocks: deviceListBlocks(devices), text: "대여 가능한 단말 목록입니다." });
  });

  // ── 반납 요청 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("request_return", async ({ ack, body, client, action }: any) => {
    await ack();
    const data = JSON.parse(action.value);
    await client.chat.update({ channel: body.container.channel_id, ts: body.container.message_ts, text: `반납 요청 완료!`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_paperpencil: *반납 신청 완료!*\n반납 요청이 전달됐어요. 단말을 <@${ADMIN_USER_ID}> 자리로 가져다주세요!\n관리자 확인 후 반납이 완료돼요.\n• 반납 단말 : ${data.model_name}(${data.asset_no})` } }] });
    await client.chat.postMessage({ channel: ADMIN_USER_ID, blocks: returnRequestBlocks(body.user.id, data), text: `반납 확인 요청: ${data.user_name} / ${data.model_name}` });
  });

  // ── 반납 완료 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("return_device", async ({ ack, body, client, action }: any) => {
    await ack();
    const data = JSON.parse(action.value);
    const success = await markReturned(data.asset_no);
    if (success) {
      await client.chat.update({ channel: body.container.channel_id, ts: body.container.message_ts, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_check: *반납 완료!*\n• 반납자 : ${data.user_name}\n• 반납 단말 : ${data.model_name}(${data.asset_no})` } }], text: `반납 완료 — ${data.user_name} / ${data.model_name}` });
      await client.chat.postMessage({ channel: data.user_id, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_check: *반납 완료!*\n• 반납 단말 : ${data.model_name}(${data.asset_no})` } }], text: `반납이 완료됐어요.` });
    } else {
      await client.chat.postMessage({ channel: body.user.id, text: "이미 반납 처리됐거나 기록을 찾을 수 없어요." });
    }
  });

  // ── 반납 거절 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("reject_return", async ({ ack, body, client, action }: any) => {
    await ack();
    const data = JSON.parse(action.value);
    await client.chat.postMessage({ channel: data.user_id, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_warning: *반납 미확인*\n${data.model_name}(${data.asset_no}) 반납 확인이 되지 않았어요. 관리자에게 다시 문의해주세요.` } }], text: `반납 확인이 되지 않았어요.` });
    await client.chat.update({ channel: body.container.channel_id, ts: body.container.message_ts, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_check: *거절 완료*\n• 반납자 : ${data.user_name}\n• 단말 : ${data.model_name}(${data.asset_no})` } }], text: `거절 완료 — ${data.user_name} / ${data.model_name}` });
  });

  // ── 연장 신청 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("request_extension", async ({ ack, body, client, action }: any) => {
    await ack();
    const data = JSON.parse(action.value);
    await client.views.open({ trigger_id: body.trigger_id, view: extensionModal(data, body.container.message_ts, body.container.channel_id) });
  });

  // ── 연장 승인 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("approve_extension", async ({ ack, body, client, action }: any) => {
    await ack();
    const data = JSON.parse(action.value);
    await extendRental(data.asset_no, data.new_end_date);
    const rv = JSON.stringify({ asset_no: data.asset_no, model_name: data.model_name, user_id: data.user_id, user_name: data.user_name });
    await client.chat.postMessage({ channel: data.user_id, blocks: extensionApprovedBlocks(data.model_name, data.asset_no, data.new_end_date, rv), text: `${data.model_name} 반납일이 연장됐어요.` });
    await client.chat.update({ channel: body.container.channel_id, ts: body.container.message_ts, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_check: *연장 승인 완료!*\n• 대여자 : ${data.user_name}\n• 신청 단말 : ${data.model_name}(${data.asset_no})\n• 변경 반납일 : ${data.new_end_date}` } }], text: `연장 승인 완료 — ${data.user_name} / ${data.model_name}` });
  });

  // ── 연장 거절 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("reject_extension", async ({ ack, body, client, action }: any) => {
    await ack();
    const data = JSON.parse(action.value);
    await client.chat.postMessage({ channel: data.user_id, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_warning: *연장 신청 거절*\n${data.model_name}(${data.asset_no}) 반납일 연장이 거절됐어요. 문의사항은 <@${ADMIN_USER_ID}>에게 연락해주세요.` } }], text: `연장 신청이 거절됐어요.` });
    await client.chat.update({ channel: body.container.channel_id, ts: body.container.message_ts, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_check: *거절 완료*\n• 대여자 : ${data.user_name}\n• 단말 : ${data.model_name}(${data.asset_no})` } }], text: `거절 완료 — ${data.user_name} / ${data.model_name}` });
  });

  // ── 모달: 대여 신청 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.view("borrow_modal", async ({ ack, body, view, client }: any) => {
    const meta = JSON.parse(view.private_metadata);
    const values = view.state.values;
    const startDate = values.start_date_block.start_date.selected_date;
    const endDate = values.end_date_block.end_date.selected_date;
    const today = getKSTDate();
    const errors: Record<string, string> = {};
    if (startDate < today) errors.start_date_block = "지난 날짜는 선택할 수 없어요.";
    if (endDate < today) errors.end_date_block = "지난 날짜는 선택할 수 없어요.";
    if (Object.keys(errors).length > 0) { await ack({ response_action: "errors", errors }); return; }
    await ack();
    const userId = body.user.id;
    const userName = await getRealName(client, userId);
    const requestData = JSON.stringify({ asset_no: meta.asset_no, model_name: meta.model_name, user_id: userId, user_name: userName, start_date: startDate, end_date: endDate });
    if (meta.channel_id && meta.message_ts) {
      await client.chat.update({ channel: meta.channel_id, ts: meta.message_ts, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_paperpencil: *대여 신청 완료!*\n대여 신청이 접수됐어요. 관리자 확인 후 단말을 대여해드릴게요.\n• 신청 단말 : ${meta.model_name}(${meta.asset_no})\n• 대여 기간 : ${startDate} ~ ${endDate}` } }], text: `${meta.model_name}(${meta.asset_no}) 대여 신청이 접수됐어요.` });
    } else {
      await client.chat.postMessage({ channel: userId, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_paperpencil: *대여 신청 완료!*\n대여 신청이 접수됐어요. 관리자 확인 후 단말을 대여해드릴게요.\n• 신청 단말 : ${meta.model_name}(${meta.asset_no})\n• 대여 기간 : ${startDate} ~ ${endDate}` } }], text: `${meta.model_name}(${meta.asset_no}) 대여 신청이 접수됐어요.` });
    }
    await client.chat.postMessage({ channel: ADMIN_USER_ID, blocks: approvalRequestBlocks(userId, meta.model_name, meta.asset_no, startDate, endDate, requestData), text: `단말 대여 승인 요청: ${userName} → ${meta.model_name}` });
  });

  // ── 모달: 대여 신청 취소 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.view({ callback_id: "borrow_modal", type: "view_closed" }, async ({ ack, body, client }: any) => {
    await ack();
    await client.chat.postMessage({
      channel: body.user.id,
      text: "신청이 취소됐어요. `빌려줘` 또는 `목록`을 다시 입력해주세요.",
    });
  });

  // ── 모달: 기기 변경 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.view("change_device_modal", async ({ ack, body, view, client }: any) => {
    await ack();
    const meta = JSON.parse(view.private_metadata);
    const data = JSON.parse(meta.original_request);
    const selected = JSON.parse(view.state.values.new_device_block.new_device_select.selected_option.value);
    await recordRental({ assetNo: selected.asset_no, modelName: selected.model_name, userId: data.user_id, userName: data.user_name, startDate: data.start_date, endDate: data.end_date });
    const rv = JSON.stringify({ asset_no: selected.asset_no, model_name: selected.model_name, user_id: data.user_id, user_name: data.user_name });
    await client.chat.postMessage({ channel: data.user_id, blocks: approvedBlocks(selected.model_name, selected.asset_no, data.end_date, rv), text: `${selected.model_name} 대여가 승인됐어요.` });
    await client.chat.update({ channel: meta.channel_id, ts: meta.message_ts, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_check: *기기 변경 후 승인 완료!*\n• 대여자 : ${data.user_name}\n• 신청 단말 : ${selected.model_name}(${selected.asset_no})\n• 대여 기간 : ${data.start_date} ~ ${data.end_date}` } }], text: `기기 변경 후 승인 완료 — ${data.user_name} / ${selected.model_name}` });
  });

  // ── 모달: 연장 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.view("extension_modal", async ({ ack, body, view, client }: any) => {
    const meta = JSON.parse(view.private_metadata);
    const newEndDate = view.state.values.new_end_date_block.new_end_date.selected_date;
    if (newEndDate < getKSTDate()) { await ack({ response_action: "errors", errors: { new_end_date_block: "지난 날짜는 선택할 수 없어요." } }); return; }
    await ack();
    const approvalValue = JSON.stringify({ ...meta, new_end_date: newEndDate });
    await client.chat.postMessage({ channel: ADMIN_USER_ID, blocks: extensionRequestBlocks(meta, newEndDate, approvalValue), text: `반납일 연장 승인 요청: ${meta.user_name} / ${meta.model_name} → ${newEndDate}` });
    if (meta.message_ts && meta.channel_id) {
      await client.chat.update({ channel: meta.channel_id, ts: meta.message_ts, text: `연장 신청 완료!`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:action_paperpencil: *연장 신청 완료!*\n연장 신청이 접수됐어요. 관리자 승인 후 확정될 예정이에요!\n• 신청 단말 : ${meta.model_name}(${meta.asset_no})\n• 변경 반납일 : ${newEndDate}` } }] });
    }
  });

  // ── 내부망 접속 점검 알림 (매일 오전 10:30) ──
  cron.schedule("30 10 * * *", async () => {
    try {
      const today = getKSTDate();
      const lastCheckDate = await getLastNetworkCheckDate();

      if (lastCheckDate) {
        const alertDate = new Date(`${lastCheckDate}T00:00:00+0900`);
        alertDate.setDate(alertDate.getDate() + 25);
        const adjusted = await getPreviousBusinessDay(alertDate);
        const adjustedStr = adjusted.toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 10);
        if (adjustedStr !== today) return;
      }

      const devices = await getAvailableDevices();
      const deviceNames = devices.map((d) => d["모델명"]);
      if (deviceNames.length === 0) return;

      await app.client.chat.postMessage({
        channel: ADMIN_USER_ID,
        blocks: networkAccessBlocks(deviceNames),
        text: `내부망 접속 점검 알림: ${deviceNames.length}대`,
      });
    } catch (e) {
      console.error("[내부망 접속 알림 오류]", e);
    }
  }, { timezone: "Asia/Seoul" });

  // ── 연체 알림 스케줄러 (다음 영업일 오전 11시) ──
  cron.schedule("0 11 * * *", async () => {
    try {
      const today = getKSTDate();
      const todayDate = new Date(`${today}T00:00:00+0900`);
      const todayHoliday = await isHoliday(todayDate);
      if (todayDate.getDay() === 0 || todayDate.getDay() === 6 || todayHoliday) return;

      const yesterday = new Date(todayDate);
      yesterday.setDate(yesterday.getDate() - 1);
      const prevBizDay = await getPreviousBusinessDay(yesterday);
      const prevBizDayStr = prevBizDay.toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 10);

      const overdueList = await getOverdueOnDate(prevBizDayStr);
      for (const rental of overdueList) {
        const btnValue = JSON.stringify({ asset_no: rental["자산번호"], user_id: rental["Slack_ID"], user_name: rental["대여자"] ?? "", model_name: rental["모델명"] || rental["자산번호"] });
        await app.client.chat.postMessage({
          channel: rental["Slack_ID"],
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `:action_warning: *반납 예정일이 지났습니다.*\n지금 바로 확인해주세요.\n• 반납 필요 단말 : ${rental["모델명"]}(${rental["자산번호"]})` } },
            { type: "actions", elements: [
              { type: "button", text: { type: "plain_text", text: "반납하기" }, style: "primary", action_id: "request_return", value: btnValue },
              { type: "button", text: { type: "plain_text", text: "연장하기" }, action_id: "request_extension", value: btnValue },
            ]},
          ],
          text: `:action_warning: 단말이 아직 반납되지 않았어요.`,
        });
      }
    } catch (e) {
      console.error("[연체 알림 오류]", e);
    }
  }, { timezone: "Asia/Seoul" });

  // ── 반납 알림 스케줄러 (매일 오후 4시, 5시) ──
  cron.schedule("0 16,17 * * *", async () => {
    try {
      const dueList = await getDueToday();
      if (dueList.length > 0) {
        const lines = dueList.map((r: Record<string, string>) => `• <@${r["Slack_ID"]}> — ${r["모델명"]} (${r["자산번호"]})`);
        await app.client.chat.postMessage({ channel: ADMIN_USER_ID, text: `*오늘 반납 예정 ${dueList.length}건*\n` + lines.join("\n") });
      }
      const isReminder = new Date().getHours() >= 17;
      for (const rental of dueList) {
        const btnValue = JSON.stringify({ asset_no: rental["자산번호"], user_id: rental["Slack_ID"], user_name: rental["대여자"] ?? "", model_name: rental["모델명"] || rental["자산번호"] });
        const messageText = isReminder
          ? `:action_warning: *아직 반납/연장이 완료되지 않았어요.*\n퇴근 전에 꼭 처리해주세요!\n• 반납 필요 단말 : ${rental["모델명"]}(${rental["자산번호"]})`
          : `:action_calendar: *오늘 반납 예정일이에요!*\n단말을 반납해주세요.\n기간 연장이 필요하신 경우 연장 신청을 해주세요.\n• 반납 필요 단말 : ${rental["모델명"]}(${rental["자산번호"]})`;
        await app.client.chat.postMessage({
          channel: rental["Slack_ID"],
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: messageText } },
            { type: "actions", elements: [
              { type: "button", text: { type: "plain_text", text: "반납하기" }, style: "primary", action_id: "request_return", value: btnValue },
              { type: "button", text: { type: "plain_text", text: "연장하기" }, action_id: "request_extension", value: btnValue },
            ]},
          ],
          text: messageText,
        });
      }
    } catch (e) {
      console.error("[알림 오류]", e);
    }
  }, { timezone: "Asia/Seoul" });

  // ── 내부망 접속 목록 시트 추가 버튼 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action("generate_network_list", async ({ ack, respond }: any) => {
    await ack();
    const today = getKSTDate();
    const count = await appendNetworkAccessList(today);

    await respond({
      replace_original: true,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:action_check: ${count}대 목록이 시트에 추가됐어요!\n날짜: ${today}\n<https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}/edit?gid=734837816#gid=734837816|📋 시트 바로가기>`,
          },
        },
      ],
      text: `:action_check: ${count}대 목록 추가 완료`,
    });
  });

  await app.start();
  console.log(`⚡ 단말대여봇 시작! PID=${process.pid} TIME=${new Date().toISOString()}`);

  process.on('SIGTERM', async () => {
    console.log('[봇 종료] SIGTERM 수신, WebSocket 닫는 중...');
    await app.stop();
    process.exit(0);
  });

}

// ── 내부망 접속 유틸 ──

function getKSTDate(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 10);
}

async function getPreviousBusinessDay(date: Date): Promise<Date> {
  const d = new Date(date);
  while (true) {
    const dow = d.getDay();
    const holiday = await isHoliday(new Date(`${d.toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 10)}T00:00:00+0900`));
    if (dow !== 0 && dow !== 6 && !holiday) break;
    d.setDate(d.getDate() - 1);
  }
  return d;
}

function networkAccessBlocks(devices: string[]) {
  const list = devices.map((d) => `• ${d}`).join("\n");
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*📱 내부망 접속 점검 알림*\n\n다음 단말의 내부망 접속이 필요해요:\n${list}` },
    },
    {
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "📋 접속 목록 시트에 추가" },
        style: "primary",
        action_id: "generate_network_list",
      }],
    },
  ];
}

// ── Block 헬퍼 ──

function borrowModal(assetNo: string, modelName: string, osVer: string, channelId?: string, messageTs?: string) {
  return {
    type: "modal", callback_id: "borrow_modal", notify_on_close: true,
    title: { type: "plain_text", text: "단말 대여 신청" },
    submit: { type: "plain_text", text: "신청하기" },
    close: { type: "plain_text", text: "취소" },
    private_metadata: JSON.stringify({ asset_no: assetNo, model_name: modelName, channel_id: channelId, message_ts: messageTs }),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${modelName}*  |  ${osVer}  |  ${assetNo}` } },
      { type: "divider" },
      { type: "input", block_id: "start_date_block", label: { type: "plain_text", text: "대여 시작일" }, element: { type: "datepicker", action_id: "start_date", initial_date: getKSTDate(), placeholder: { type: "plain_text", text: "날짜 선택" } } },
      { type: "input", block_id: "end_date_block", label: { type: "plain_text", text: "반납 예정일" }, element: { type: "datepicker", action_id: "end_date", initial_date: getKSTDate(), placeholder: { type: "plain_text", text: "날짜 선택" } } },
    ],
  };
}

function changeDeviceModal(originalRequest: string, messageTs: string, channelId: string, data: Record<string, string>, options: object[]) {
  return {
    type: "modal", callback_id: "change_device_modal",
    title: { type: "plain_text", text: "기기 변경 후 승인" },
    submit: { type: "plain_text", text: "변경 후 승인" },
    close: { type: "plain_text", text: "취소" },
    private_metadata: JSON.stringify({ original_request: originalRequest, message_ts: messageTs, channel_id: channelId }),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*신청자*: <@${data.user_id}>\n*신청 기기*: ${data.model_name} (\`${data.asset_no}\`)\n*기간*: ${data.start_date} ~ ${data.end_date}` } },
      { type: "divider" },
      { type: "input", block_id: "new_device_block", label: { type: "plain_text", text: "변경할 기기 선택" }, element: { type: "static_select", action_id: "new_device_select", placeholder: { type: "plain_text", text: "기기 선택" }, options } },
    ],
  };
}

function extensionModal(data: Record<string, string>, messageTs: string, channelId: string) {
  return {
    type: "modal", callback_id: "extension_modal",
    title: { type: "plain_text", text: "반납일 연장 신청" },
    submit: { type: "plain_text", text: "신청하기" },
    close: { type: "plain_text", text: "취소" },
    private_metadata: JSON.stringify({ asset_no: data.asset_no, model_name: data.model_name, user_id: data.user_id, user_name: data.user_name, message_ts: messageTs, channel_id: channelId }),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${data.model_name}* (${data.asset_no}) 반납일 연장 신청입니다.` } },
      { type: "divider" },
      { type: "input", block_id: "new_end_date_block", label: { type: "plain_text", text: "연장 반납 예정일" }, element: { type: "datepicker", action_id: "new_end_date", initial_date: getKSTDate(), placeholder: { type: "plain_text", text: "날짜 선택" } } },
    ],
  };
}

function approvedBlocks(modelName: string, assetNo: string, endDate: string, returnValue: string) {
  return [
    { type: "section", text: { type: "mrkdwn", text: `:action_check: *대여 완료!*\n• 신청 단말 : ${modelName}(${assetNo})\n• 반납 예정일 : ${endDate}\n반납하시거나 연장하시려면 아래 버튼을 눌러주세요.` } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "반납하기" }, style: "primary", action_id: "request_return", value: returnValue },
      { type: "button", text: { type: "plain_text", text: "연장하기" }, action_id: "request_extension", value: returnValue },
    ]},
  ];
}

function rejectedBlocks(modelName: string, assetNo: string) {
  return [
    { type: "section", text: { type: "mrkdwn", text: `:action_warning: *대여 신청 거절*\n${modelName}(${assetNo}) 대여 신청이 거절됐어요. 다른 단말을 선택하거나 관리자에게 문의해주세요.` } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "다른 기기 선택하기" }, action_id: "show_device_list" }] },
  ];
}

function approvalRequestBlocks(userId: string, modelName: string, assetNo: string, startDate: string, endDate: string, requestData: string) {
  return [
    { type: "section", text: { type: "mrkdwn", text: `:action_paperpencil: *대여 승인 요청*\n• 신청자 : <@${userId}>\n• 신청 단말 : ${modelName}(${assetNo})\n• 대여 기간 : ${startDate} ~ ${endDate}\n<https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}/edit|📋 시트 바로가기>` } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "승인" }, style: "primary", action_id: "approve_rental", value: requestData },
      { type: "button", text: { type: "plain_text", text: "기기 변경 후 승인" }, action_id: "change_device_rental", value: requestData },
      { type: "button", text: { type: "plain_text", text: "거절" }, style: "danger", action_id: "reject_rental", value: requestData },
    ]},
  ];
}

function returnRequestBlocks(userId: string, data: Record<string, string>) {
  const value = JSON.stringify(data);
  return [
    { type: "section", text: { type: "mrkdwn", text: `:action_paperpencil: *반납 확인 요청*\n• 반납자 : <@${userId}>\n• 반납 단말 : ${data.model_name}(${data.asset_no})\n<https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}/edit|📋 시트 바로가기>` } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "반납 완료" }, style: "primary", action_id: "return_device", value },
    ]},
  ];
}

function extensionRequestBlocks(meta: Record<string, string>, newEndDate: string, approvalValue: string) {
  return [
    { type: "section", text: { type: "mrkdwn", text: `:action_paperpencil: *연장 승인 요청*\n• 신청자 : <@${meta.user_id}>\n• 신청 단말 : ${meta.model_name}(${meta.asset_no})\n• 변경 반납일 : ${newEndDate}\n<https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}/edit|📋 시트 바로가기>` } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "승인" }, style: "primary", action_id: "approve_extension", value: approvalValue },
      { type: "button", text: { type: "plain_text", text: "거절" }, style: "danger", action_id: "reject_extension", value: approvalValue },
    ]},
  ];
}

function extensionApprovedBlocks(modelName: string, assetNo: string, newEndDate: string, returnValue: string) {
  return [
    { type: "section", text: { type: "mrkdwn", text: `:action_check: *연장 완료!*\n• 신청 단말 : ${modelName}(${assetNo})\n• 변경 반납 예정일 : ${newEndDate}\n반납하시거나 연장하시려면 아래 버튼을 눌러주세요.` } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "반납하기" }, style: "primary", action_id: "request_return", value: returnValue },
      { type: "button", text: { type: "plain_text", text: "연장하기" }, action_id: "request_extension", value: returnValue },
    ]},
  ];
}
