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

const SHEET_ID = env.GOOGLE_SHEET_ID;
const credentials = JSON.parse(env.GOOGLE_CREDENTIALS_JSON);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

async function run() {
  // 기존 시트 삭제
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === "내부망접속관리"
  );
  if (existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ deleteSheet: { sheetId: existing.properties?.sheetId } }],
      },
    });
  }

  // 새 시트 생성
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: "내부망접속관리" } } }],
    },
  });

  // 헤더만 세팅 (로그 구조 — 데이터는 Slack 명령어로 추가)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "내부망접속관리!A1:D1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [["날짜", "모델명", "자산번호", "확인"]],
    },
  });

  console.log("✅ 내부망접속관리 시트 생성 완료 (헤더만 세팅)");
}

run().catch(console.error);
