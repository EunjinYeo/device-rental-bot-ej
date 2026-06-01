import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEET_ID!;

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON!);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

function getKSTNow(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).replace(" ", "T");
}

export async function getAvailableDevices(): Promise<Record<string, string>[]> {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "대여 가능 단말 확인!A:E",
  });
  const rows = res.data.values ?? [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) =>
    Object.fromEntries(headers.map((h: string, i: number) => [h, row[i] ?? ""]))
  );
}

export async function getOverdueOnDate(date: string): Promise<Record<string, string>[]> {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "대여이력!A:H",
  });
  const rows = res.data.values ?? [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows
    .slice(1)
    .map((row) =>
      Object.fromEntries(headers.map((h: string, i: number) => [h, row[i] ?? ""]))
    )
    .filter((r) => r["반납예정일"] === date && !r["반납시각"]);
}

export async function getDueToday(): Promise<Record<string, string>[]> {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "대여이력!A:H",
  });
  const rows = res.data.values ?? [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  const today = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 10);
  return rows
    .slice(1)
    .map((row) =>
      Object.fromEntries(headers.map((h: string, i: number) => [h, row[i] ?? ""]))
    )
    .filter((r) => r["반납예정일"] === today && !r["반납시각"]);
}

// 대여이력 컬럼: A자산번호 B모델명 C대여자 D대여일 E반납예정일 F대여시각 G반납시각 H Slack_ID

export async function recordRental(params: {
  assetNo: string;
  modelName: string;
  userId: string;
  userName: string;
  startDate: string;
  endDate: string;
}) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "대여이력!A:H",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        params.assetNo,
        params.modelName,
        params.userName,
        params.startDate,
        params.endDate,
        getKSTNow(),
        "",
        params.userId,
      ]],
    },
  });
  await updateDeviceListRental(params.assetNo, params.userName, params.startDate, params.endDate);
}

export async function markReturned(assetNo: string): Promise<boolean> {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "대여이력!A:H",
  });
  const rows = res.data.values ?? [];
  // 자산번호 일치 & 반납시각(G, index 6) 비어있는 행 = 현재 대여중
  const rowIndex = rows.findIndex((r) => r[0] === assetNo && !r[6]);
  if (rowIndex < 0) return false;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `대여이력!G${rowIndex + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[getKSTNow()]] },
  });
  await updateDeviceListReturn(assetNo);
  return true;
}

export async function extendRental(assetNo: string, newEndDate: string) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "대여이력!A:H",
  });
  const rows = res.data.values ?? [];
  const rowIndex = rows.findIndex((r) => r[0] === assetNo && !r[6]);
  if (rowIndex < 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `대여이력!E${rowIndex + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newEndDate]] },
  });
  await updateDeviceListExtend(assetNo, newEndDate);
}

// 전체_단말리스트 헬퍼: 자산번호로 행 찾아서 대여자/대여일/반납예정일 컬럼 업데이트

async function getDeviceListRow(sheets: ReturnType<typeof getSheetsClient>, assetNo: string) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "전체_단말리스트!A:Z",
  });
  const rows = res.data.values ?? [];
  if (rows.length < 2) return null;
  const headers: string[] = rows[0];
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[4] === assetNo); // E열 = index 4
  if (rowIndex < 0) return null;
  return { headers, rowIndex };
}

// 전체_단말리스트: 대여자=L, 대여일=M, 반납예정일=N
const DEVICE_LIST_COLS = { 대여자: "L", 대여일: "M", 반납예정일: "N" };

async function updateDeviceListRental(assetNo: string, userName: string, startDate: string, endDate: string) {
  const sheets = getSheetsClient();
  const found = await getDeviceListRow(sheets, assetNo);
  if (!found) return;
  const { rowIndex } = found;

  const entries: [string, string][] = [
    [DEVICE_LIST_COLS.대여자, userName],
    [DEVICE_LIST_COLS.대여일, startDate],
    [DEVICE_LIST_COLS.반납예정일, endDate],
  ];
  for (const [col, value] of entries) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `전체_단말리스트!${col}${rowIndex + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[value]] },
    });
  }
}

async function updateDeviceListReturn(assetNo: string) {
  const sheets = getSheetsClient();
  const found = await getDeviceListRow(sheets, assetNo);
  if (!found) return;
  const { rowIndex } = found;

  for (const col of Object.values(DEVICE_LIST_COLS)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `전체_단말리스트!${col}${rowIndex + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[""]] },
    });
  }
}

export async function appendNetworkAccessList(today: string): Promise<number> {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "대여 가능 단말 확인!A:D",
  });
  const rows = res.data.values ?? [];
  // 헤더: 제조사, 모델명, 자산번호, OS 버전
  const devices = rows
    .slice(1)
    .filter((r) => r[2])
    .map((r) => [today, r[1], r[2], ""]); // [날짜, 모델명, 자산번호, 확인]

  if (devices.length === 0) return 0;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "내부망접속관리!A:D",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: devices },
  });
  return devices.length;
}

export async function getLastNetworkCheckDate(): Promise<string | null> {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "내부망접속관리!A:A",
  });
  const rows = res.data.values ?? [];
  const dates = rows.slice(1).map((r) => r[0]).filter(Boolean);
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a > b ? a : b));
}

async function updateDeviceListExtend(assetNo: string, newEndDate: string) {
  const sheets = getSheetsClient();
  const found = await getDeviceListRow(sheets, assetNo);
  if (!found) return;
  const { rowIndex } = found;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `전체_단말리스트!${DEVICE_LIST_COLS.반납예정일}${rowIndex + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newEndDate]] },
  });
}
