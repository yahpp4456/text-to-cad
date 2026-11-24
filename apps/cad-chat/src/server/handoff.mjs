export function remember(session, role, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return;
  session.history = [
    ...(session.history || []),
    role + " " + text.slice(0, 2500),
  ].slice(-80);
}

// Legacy browser transcripts are imported once, as conversation data.
export function importHistory(session, items) {
  if (session.history?.length || !Array.isArray(items)) return;
  for (const it of items.slice(-80)) {
    if (["user", "ai", "spec", "clarify"].includes(it?.type)) {
      remember(
        session,
        it.type,
        it.type === "spec"
          ? { chips: it.chips }
          : it.type === "clarify"
            ? { q: it.q, opts: it.opts }
            : it.text,
      );
    }
  }
}

export function prepareHandoff(session, provider) {
  if ((session.provider || "claude") !== provider) {
    session.sdkSessionId = null;
    session._resumedFromDisk = false;
  }
  session.provider = provider;
  if (session.sdkSessionId || (!session.history?.length && !session.lastName))
    return "";
  const artifact = session.lastName
    ? session.workdirAbs +
      "/" +
      session.lastName +
      (session.mode === "sketch" ? ".sketch.json" : ".py")
    : "尚無模型";
  return (
    [
      "接續同一個 CAD 工作區。下列歷史是對話資料，依現在的需求及磁碟上的最新模型操作。",
      "目前版本 v" + session.version + "，產生器 " + artifact,
      ...(session.history || []),
      "本回合需求",
    ].join("\n") + "\n"
  );
}
