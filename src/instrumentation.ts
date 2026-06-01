let botStarted = false;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (botStarted) return;
  botStarted = true;

  try {
    const { startSlackBot } = await import("./bot");
    await startSlackBot();
  } catch (e) {
    console.error("[봇 시작 오류]", e);
    botStarted = false;
  }
}
