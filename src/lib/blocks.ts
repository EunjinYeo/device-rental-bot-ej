// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function deviceListBlocks(devices: Record<string, string>[]): any[] {
  if (!devices.length) {
    return [{
      type: "section",
      text: { type: "mrkdwn", text: "😔 현재 대여 가능한 단말이 없습니다." },
    }];
  }

  const blocks: object[] = [
    { type: "header", text: { type: "plain_text", text: "대여 가능한 단말 목록" } },
    { type: "divider" },
  ];

  for (const d of devices) {
    const icon = d["제조사"] === "Apple" ? "🍎" : "🤖";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${icon} *${d["모델명"]}*  |  OS ${d["OS 버전"] ?? ""}  |  ${d["자산번호"]}`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "대여 신청" },
        value: JSON.stringify({ asset_no: d["자산번호"], model_name: d["모델명"], os_ver: d["OS 버전"] ?? "" }),
        action_id: `borrow_${d["자산번호"]}`,
      },
    });
  }
  return blocks;
}
