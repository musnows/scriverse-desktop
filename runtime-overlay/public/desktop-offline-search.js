const searchFields = Object.freeze({
  character: ["aliases", "code", "species", "race", "attributes", "profile", "currentState"],
  setting: ["content", "category", "tags", "authorNote", "evidence", "scope"],
  race: ["description", "settings", "settingsMarkdown", "settingsSections", "lineage", "effectiveSettings"],
  organization: ["description", "settings", "settingsMarkdown", "settingsSections"],
  "timeline-track": ["description"],
  "timeline-event": ["description", "eventType", "timeLabel", "location", "causes", "impactScope", "evidence"],
  relationship: ["category", "subtype", "keywords", "currentStatus", "timeRange", "evidence"],
  "chapter-outline": ["goal", "conflict", "turningPoint", "notes"],
  foreshadow: ["description", "resolutionNote", "occurrences"],
  review: ["description", "suggestion", "resolutionNote", "entityRefs", "evidence"],
  chapter: ["content"]
});

export const DESKTOP_OFFLINE_SEARCH_TYPES = Object.freeze(Object.keys(searchFields));

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function textValues(value) {
  if (typeof value === "string") return [value];
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => (
    key === "id" || /Ids?$/u.test(key) || ["versionNo", "createdAt", "updatedAt", "sortOrder"].includes(key)
      ? [] : textValues(nested)
  ));
}

function snippet(value, needle) {
  const text = String(value ?? "").normalize("NFKC");
  const index = text.toLocaleLowerCase("zh-CN").indexOf(needle);
  const start = Math.max(0, index - 40);
  return text.slice(start, start + 180);
}

function chapterLines(content, needle) {
  const text = normalize(content);
  const index = text.indexOf(needle);
  if (index < 0) return {};
  const lineAt = (offset) => text.slice(0, offset).split(/\r\n|\r|\n/u).length;
  return { startLine: lineAt(index), endLine: lineAt(index + needle.length - 1) };
}

export function prioritizeDesktopOfflineSearchResults(results) {
  return [...results].sort((left, right) => (
    Number(left.type === "chapter") - Number(right.type === "chapter")
    || Number(right.score ?? 0) - Number(left.score ?? 0)
  ));
}

export function buildDesktopOfflineSearchResults(recordsByType, query) {
  const needle = normalize(query).trim();
  if (!needle) return [];
  const characters = new Map((recordsByType.character ?? []).map((item) => [String(item.id), String(item.name ?? "")]));
  const chapters = new Map((recordsByType.chapter ?? []).map((item) => [String(item.id), String(item.title ?? "")]));
  return DESKTOP_OFFLINE_SEARCH_TYPES.flatMap((type) => (recordsByType[type] ?? []).flatMap((record) => {
    if (!record.id || record.deleted === true || record.deletedAt || record.mergedIntoCharacterId) return [];
    const id = String(type === "chapter-outline" ? record.chapterId ?? record.id : record.id);
    let title = String(record.title ?? record.name ?? "");
    if (type === "chapter-outline") title = String(record.chapterTitle ?? chapters.get(id) ?? title);
    const relatedNames = type === "relationship"
      ? [characters.get(String(record.fromCharacterId)), characters.get(String(record.toCharacterId))].filter(Boolean)
      : [];
    if (type === "relationship" && !title) title = [...relatedNames, record.subtype || record.category].filter(Boolean).join(" · ");
    const content = [title, ...relatedNames, ...searchFields[type].flatMap((field) => textValues(record[field]))].filter(Boolean).join("\n");
    if (!normalize(content).includes(needle)) return [];
    return [{
      type,
      id,
      title: title || "未命名资料",
      snippet: snippet(content, needle),
      matchKind: "exact",
      matchKinds: ["exact"],
      score: normalize(title).includes(needle) ? 2 : 1,
      ...(type === "chapter" ? chapterLines(record.content, needle) : {}),
      ...(type === "character" ? { gender: record.gender, isDead: record.isDead === true } : {}),
      ...(type === "race" ? { isExtinct: record.isExtinct === true } : {}),
      ...(type === "organization" ? { isDissolved: record.isDissolved === true } : {})
    }];
  }));
}
