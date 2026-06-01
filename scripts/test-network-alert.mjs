import { WebClient } from "@slack/web-api";
import { google } from "googleapis";
import { readFileSync } from "fs";

const envFile = readFileSync(".env.local", "utf-8");
const env = Object.fromEntries(
  envFile.split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [key, ...vals] = line.split("=");
      return [key.trim(), vals.join("=").trim()];
    })
);

const slack = new WebClient(env.SLACK_BOT_TOKEN);
const ADMIN_USER_ID = env.ADMIN_USER_ID;
const SHEET_ID = env.GOOGLE_SHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(env.GOOGLE_CREDENTIALS_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// 현재 대여 가능 단말 목록 가져오기
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: "대여 가능 단말 확인!A:D",
});
const rows = res.data.values ?? [];
const devices = rows.slice(1).filter((r) => r[2]).map((r) => r[1]); // 모델명

console.log(`대여 가능 단말 ${devices.length}개:`, devices);

const list = devices.map((d) => `• ${d}`).join("\n");

await slack.chat.postMessage({
  channel: ADMIN_USER_ID,
  blocks: [
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
  ],
  text: `내부망 접속 점검 알림: ${devices.length}대`,
});

console.log("✅ DM 발송 완료");
