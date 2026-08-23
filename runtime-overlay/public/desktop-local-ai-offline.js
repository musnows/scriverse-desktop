function escapeXmlText(value, maximum = Number.POSITIVE_INFINITY) {
  const escaped = String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
  if (escaped.length <= maximum) return escaped;
  const marker = "…[本机上下文已截断]";
  return `${escaped.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}

function xmlElement(name, value, maximum) {
  return `<${name}>${escapeXmlText(value, maximum)}</${name}>`;
}

export function desktopOfflineLocalAiSystemPrompt(context) {
  const entityLabel = context?.entityType === "setting" ? "设定" : "章节";
  const lockedSettings = Array.isArray(context?.lockedSettings) ? context.lockedSettings : [];
  let lockedSettingsBudget = 80_000;
  const lockedSettingsXml = [];
  for (const setting of lockedSettings.slice(0, 100)) {
    if (lockedSettingsBudget <= 0) break;
    const contentBudget = Math.min(20_000, lockedSettingsBudget);
    lockedSettingsXml.push([
      "    <setting>",
      `      ${xmlElement("title", setting?.title, 500)}`,
      `      ${xmlElement("content", setting?.content, contentBudget)}`,
      "    </setting>"
    ].join("\n"));
    lockedSettingsBudget -= contentBudget;
  }
  return [
    "你是叙界 Desktop 的本地创作助手。当前处于远端 Server 离线状态。",
    "只能依据下方本机离线副本提供建议；不得声称已读取远端 AI 设置、远端最新数据或未提供的设定。",
    "输出应直接回应作者要求。续写或润色时只返回建议正文，不要自动修改作品。",
    "",
    '<desktop_offline_context remote_ai_settings_included="false">',
    `  ${xmlElement("work_title", context?.workTitle, 500)}`,
    `  ${xmlElement("entity_type", entityLabel, 20)}`,
    `  ${xmlElement("entity_title", context?.title, 500)}`,
    `  ${xmlElement("entity_content", context?.content, 180_000)}`,
    "  <locked_settings>",
    lockedSettingsXml.join("\n") || "    <none />",
    "  </locked_settings>",
    "</desktop_offline_context>"
  ].join("\n");
}

export function desktopOfflineLocalAiMessages(history, instruction) {
  const normalizedHistory = (Array.isArray(history) ? history : [])
    .filter((message) => message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.length > 0)
    .slice(-39)
    .map(({ role, content }) => ({ role, content }));
  return [...normalizedHistory, { role: "user", content: String(instruction) }];
}
