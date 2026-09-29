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
  const toolNames = Array.isArray(context?.toolNames) ? context.toolNames.filter((name) => typeof name === "string" && name) : [];
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
    "你是叙界创作助手。当前处于远端 Server 离线状态。",
    "只能依据下方本机离线副本和函数工具的返回提供建议；不得声称已读取远端 AI 设置、远端最新数据或工具未返回的资料。",
    "工具返回 ok:false、degraded 或明确说明副本未包含某模块时，必须把限制告诉作者，不能把缺失资料编造成查询结果。",
    toolNames.length ? `当前可用工具：${toolNames.join("、")}。` : "当前没有可用工具。",
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
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .slice(-39)
    .flatMap((message) => {
      const content = typeof message.modelContent === "string" && message.modelContent.length > 0
        ? message.modelContent
        : message.content;
      if (typeof content !== "string" || content.length === 0) return [];
      return [{ role: message.role, content }];
    });
  return [...normalizedHistory, { role: "user", content: String(instruction) }];
}

const OFFLINE_TOOL_RESULT_MAX_CHARS = 10_000;
const DEFAULT_CHAT_TOOL_IDS = [
  "story_index",
  "read_chapters",
  "grep",
  "search_story_entities",
  "semantic_search_story",
  "read_character_sections",
  "search_drafts",
  "image",
  "calculate_time"
];

const TOOL_READ_MODULES = {
  story_index: ["prose"],
  read_chapters: ["prose"],
  grep: ["prose"],
  read_character_sections: ["characters"],
  search_drafts: ["drafts"],
  image: ["settings", "characters", "races", "organizations", "timeline", "relationships", "outlines"],
  calculate_time: []
};

const ENTITY_CATEGORY_MODULES = {
  setting: "settings",
  character: "characters",
  race: "races",
  organization: "organizations",
  timeline: "timeline",
  relationship: "relationships",
  outline: "outlines",
  foreshadow: "outlines"
};

const CORPUS_MODULE_TYPES = {
  character: "characters",
  race: "races",
  organization: "organizations",
  "timeline-track": "timeline",
  "timeline-event": "timeline",
  relationship: "relationships",
  "chapter-outline": "outlines",
  foreshadow: "outlines",
  draft: "drafts"
};

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value, maximum = 20_000) {
  const normalized = String(value ?? "");
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum)}…[已截断]`;
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function canReadModule(permissions, module) {
  if (!permissions) return true;
  const access = permissions[module];
  return access === "read" || access === "write";
}

function moduleReadable(permissions, modules) {
  if (!modules.length) return true;
  return modules.some((module) => canReadModule(permissions, module));
}

export function desktopOfflineChatToolDefinitions(corpus) {
  const permissions = record(corpus?.permissions);
  const enabled = new Set(DEFAULT_CHAT_TOOL_IDS.filter((toolId) => {
    if (toolId === "search_story_entities" || toolId === "semantic_search_story") {
      return moduleReadable(permissions, ["prose", ...Object.values(ENTITY_CATEGORY_MODULES)]);
    }
    return moduleReadable(permissions, TOOL_READ_MODULES[toolId] ?? []);
  }));
  return desktopOfflineChatToolCatalog().filter((tool) => enabled.has(tool.function.name));
}

function toolDefinition(name, description, parameters, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: parameters,
        ...(required.length ? { required } : {}),
        additionalProperties: false
      }
    }
  };
}

function desktopOfflineChatToolCatalog() {
  const cursor = { type: "integer", minimum: 0, maximum: 10_000, default: 0, description: "结果续读起点。pagination.nextCursor 非空时原样传回。" };
  return [
    toolDefinition("story_index", "读取当前作品的基本信息，并按分卷剧情顺序分页列出卷章、章节概要和顺序元数据。latestChaptersByStructure 始终独立返回结构上最新的正文章节，不受当前章节分页影响；nextChapterOffset 非空时表示还有后续章节页。回答作品简介、最新剧情、情节先后、整体结构或定位章节时优先使用；不会返回正文。", {
      chapterOffset: { type: "integer", minimum: 0, maximum: 10_000, default: 0, description: "章节页起点。" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "每个章节页最多读取的章节数。" },
      cursor
    }),
    toolDefinition("read_chapters", "读取指定章节的当前正文、章节概要和剧情顺序元数据。仅在需要原文证据或精确措辞时使用；每次最多 3 章。", {
      chapterIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
      include: { type: "string", enum: ["summary", "content", "both"] },
      cursor
    }, ["chapterIds"]),
    toolDefinition("grep", "在当前作品的章节正文中查询关键字，返回结构位置优先的段落、章节标题、ID 和顺序元数据。latestOccurrences.byStructure 给出结构顺序最后出现位置。默认返回 20 条证据。", {
      keyword: { type: "string", minLength: 1, maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      cursor
    }, ["keyword"]),
    toolDefinition("search_story_entities", "按短关键词在离线副本已有的结构化实体中检索：设定、人物、种族、组织、时间线、关系、大纲和伏笔。人物结果的 gender 与 isDead、种族 isExtinct、组织 isDissolved 是权威状态。不是语义问答；请传入实体名、别名、标题或短关键词。副本未包含的模块会明确返回，不得当成空结果编造。", {
      query: { type: "string", minLength: 1, maxLength: 200 },
      categories: { type: "array", items: { type: "string", enum: Object.keys(ENTITY_CATEGORY_MODULES) }, maxItems: 8 },
      limit: { type: "integer", minimum: 1, maximum: 30, default: 30 },
      cursor
    }, ["query"]),
    toolDefinition("semantic_search_story", "只读检索当前作品原文。离线副本没有语义索引，本工具会明确降级为关键词检索，并保留 keyword 匹配标记；不要把结果伪装成 semantic 命中。", {
      query: { type: "string", minLength: 1, maxLength: 2_000 },
      modules: { type: "array", items: { type: "string", enum: ["prose", "settings", "characters", "races", "organizations", "timeline", "relationships", "outlines"] }, maxItems: 8 },
      limit: { type: "integer", minimum: 1, maximum: 30, default: 12 },
      cursor
    }, ["query"]),
    toolDefinition("read_character_sections", "读取指定人物 Markdown 档案章节的摘要或原文，并返回该人物的权威 gender 与 isDead。每次最多 3 个章节。", {
      sectionIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
      include: { type: "string", enum: ["summary", "content", "both"] },
      cursor
    }, ["sectionIds"]),
    toolDefinition("search_drafts", "搜索当前作品的作者想法。想法不是已确认的故事事实，不能当作正文或设定依据。query 为空时返回最近更新的想法。", {
      query: { type: "string", maxLength: 200, default: "" },
      draftType: { type: "string", enum: ["all", "prose", "setting"], default: "all" },
      limit: { type: "integer", minimum: 1, maximum: 30, default: 20 },
      cursor
    }),
    toolDefinition("image", "读取离线副本里、当前消息尚未直接附带的一张图片附件引用。只能传入设定库正文中的 attachmentId。离线副本通常没有图片字节，此时必须告知作者无法查看图片。", {
      attachmentId: { type: "string", minLength: 1, maxLength: 300 }
    }, ["attachmentId"]),
    toolDefinition("calculate_time", "纯计算工具，用于计算两个 YYYY-MM-DD 日期之间的天数差。不访问作品数据。返回总天数差、方向、日历分解和中间经过的闰年。", {
      startDate: { type: "string", description: "起始日期，格式 YYYY-MM-DD" },
      endDate: { type: "string", description: "结束日期，格式 YYYY-MM-DD" }
    }, ["startDate", "endDate"])
  ];
}

function sortByOrder(items) {
  return [...items].sort((left, right) => (
    Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0)
    || String(left.title ?? left.name ?? left.id).localeCompare(String(right.title ?? right.name ?? right.id), "zh-CN")
  ));
}

function snapshotOf(entity) {
  return record(entity?.snapshot) ?? record(entity) ?? {};
}

export function buildDesktopOfflineAgentCorpus({ work = null, entities = [], permissions = null } = {}) {
  const summary = record(work?.summary) ?? record(work) ?? {};
  const grouped = new Map();
  for (const entity of Array.isArray(entities) ? entities : []) {
    const entityType = String(entity?.entityType ?? "");
    const snapshot = snapshotOf(entity);
    const items = grouped.get(entityType) ?? [];
    items.push(snapshot);
    grouped.set(entityType, items);
  }
  const volumes = sortByOrder(grouped.get("volume") ?? []).map((volume, index) => ({
    ...volume,
    id: String(volume.id ?? ""),
    title: String(volume.title ?? "未命名分卷"),
    storyOrder: index + 1
  }));
  const volumeById = new Map(volumes.map((volume) => [volume.id, volume]));
  const chapters = [];
  for (const volume of volumes) {
    const inVolume = sortByOrder((grouped.get("chapter") ?? []).filter((chapter) => String(chapter.volumeId ?? "") === volume.id));
    for (const chapter of inVolume) chapters.push(chapter);
  }
  const unassigned = sortByOrder((grouped.get("chapter") ?? []).filter((chapter) => !volumeById.has(String(chapter.volumeId ?? ""))));
  let storyOrder = 0;
  const normalizedChapters = [...chapters, ...unassigned].map((chapter) => {
    const authorNote = chapter.chapterType === "作者的话";
    if (!authorNote) storyOrder += 1;
    const volume = volumeById.get(String(chapter.volumeId ?? ""));
    return {
      ...chapter,
      id: String(chapter.id ?? ""),
      title: String(chapter.title ?? "未命名章节"),
      content: String(chapter.content ?? ""),
      summary: String(chapter.summary ?? chapter.outline ?? ""),
      chapterType: String(chapter.chapterType ?? "正文"),
      volumeId: String(chapter.volumeId ?? ""),
      volumeTitle: volume?.title ?? "",
      volumeStoryOrder: volume?.storyOrder ?? null,
      storyOrder: authorNote ? null : storyOrder,
      wordCount: Array.from(String(chapter.content ?? "").replace(/\s/gu, "")).length
    };
  });
  const status = record((grouped.get("agent-corpus") ?? []).find((item) => String(item.id ?? "") === "status"));
  return {
    work: {
      id: String(summary.id ?? work?.workId ?? ""),
      title: String(summary.title ?? work?.title ?? "未命名作品"),
      author: String(summary.author ?? ""),
      description: String(summary.description ?? ""),
      language: String(summary.language ?? ""),
      tags: Array.isArray(summary.tags) ? summary.tags : [],
      chapterCount: normalizedChapters.filter((chapter) => chapter.chapterType !== "作者的话").length,
      wordCount: normalizedChapters.reduce((total, chapter) => total + chapter.wordCount, 0)
    },
    permissions,
    corpusStatus: status,
    volumes,
    chapters: normalizedChapters,
    settings: (grouped.get("setting") ?? []).map((setting) => ({ ...setting, id: String(setting.id ?? ""), title: String(setting.title ?? "设定"), content: String(setting.content ?? "") })),
    characters: (grouped.get("character") ?? []).map((character) => ({ ...character, id: String(character.id ?? ""), name: String(character.name ?? "") })),
    races: grouped.get("race") ?? [],
    organizations: (grouped.get("organization") ?? []).map((item) => ({ ...item, id: String(item.id ?? ""), name: String(item.name ?? "") })),
    timelineTracks: grouped.get("timeline-track") ?? [],
    timelineEvents: grouped.get("timeline-event") ?? [],
    relationships: grouped.get("relationship") ?? [],
    outlines: grouped.get("chapter-outline") ?? [],
    foreshadows: grouped.get("foreshadow") ?? [],
    drafts: grouped.get("draft") ?? []
  };
}

function corpusHasRecords(corpus, entityType) {
  if (entityType === "character") return (corpus?.characters ?? []).length > 0;
  if (entityType === "race") return (corpus?.races ?? []).length > 0;
  if (entityType === "organization") return (corpus?.organizations ?? []).length > 0;
  if (entityType === "timeline-track") return (corpus?.timelineTracks ?? []).length > 0;
  if (entityType === "timeline-event") return (corpus?.timelineEvents ?? []).length > 0;
  if (entityType === "relationship") return (corpus?.relationships ?? []).length > 0;
  if (entityType === "chapter-outline") return (corpus?.outlines ?? []).length > 0;
  if (entityType === "foreshadow") return (corpus?.foreshadows ?? []).length > 0;
  if (entityType === "draft") return (corpus?.drafts ?? []).length > 0;
  return false;
}

function corpusModuleState(corpus, entityType) {
  const moduleName = CORPUS_MODULE_TYPES[entityType];
  if (moduleName && !canReadModule(corpus?.permissions, moduleName)) return "denied";
  const modules = record(corpus?.corpusStatus)?.modules;
  const state = record(modules)?.[entityType];
  if (state === "denied") return "denied";
  if (state === "ready" || corpusHasRecords(corpus, entityType)) return "ready";
  return "missing";
}

function unavailable(code, message) {
  return { ok: false, error: { code, message } };
}

function slicePage(items, cursor, limit) {
  const start = integer(cursor, 0, 0, 10_000);
  const size = integer(limit, items.length, 1, 100);
  const page = items.slice(start, start + size);
  const nextCursor = start + page.length < items.length ? start + page.length : null;
  return { page, nextCursor, total: items.length, cursor: start };
}

function fitResult(data, maximum = OFFLINE_TOOL_RESULT_MAX_CHARS) {
  const payload = { ok: true, data };
  if (JSON.stringify(payload).length <= maximum) return payload;
  return {
    ok: true,
    data: {
      ...data,
      truncated: true,
      hint: "结果已按 10000 字符上限截断，请缩小范围或使用 cursor 续读。"
    }
  };
}

function proseChapters(corpus) {
  return (corpus?.chapters ?? []).filter((chapter) => chapter.chapterType !== "作者的话");
}

function storyIndex(corpus, args) {
  const chapters = proseChapters(corpus);
  const offset = integer(args.chapterOffset, 0, 0, 10_000);
  const limit = integer(args.limit, 20, 1, 50);
  const page = chapters.slice(offset, offset + limit).map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    volumeId: chapter.volumeId,
    volumeTitle: chapter.volumeTitle,
    volumeStoryOrder: chapter.volumeStoryOrder,
    storyOrder: chapter.storyOrder,
    chapterType: chapter.chapterType,
    summary: text(chapter.summary, 1_000),
    wordCount: chapter.wordCount
  }));
  const latest = [...chapters].slice(-3).map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    volumeTitle: chapter.volumeTitle,
    storyOrder: chapter.storyOrder
  }));
  return fitResult({
    work: corpus.work,
    storyOrdering: { priority: ["volume.storyOrder", "chapter.storyOrder"], rule: "directoryOrder 非剧情顺序。" },
    latestChaptersByStructure: latest,
    totalChapters: chapters.length,
    chapterOffset: offset,
    chapters: page,
    nextChapterOffset: offset + limit < chapters.length ? offset + limit : null,
    continuationRule: offset + limit < chapters.length ? "使用 nextChapterOffset 作为下一次 chapterOffset。" : "章节目录已全部读完。"
  });
}

function readChapters(corpus, args) {
  const ids = Array.isArray(args.chapterIds) ? args.chapterIds.map((id) => String(id)).slice(0, 3) : [];
  if (!ids.length) return unavailable("TOOL_ARGUMENTS_INVALID", "Invalid arguments for read_chapters: chapterIds is required.");
  const include = ["summary", "content", "both"].includes(args.include) ? args.include : "both";
  const chapters = ids.map((chapterId) => {
    const chapter = (corpus.chapters ?? []).find((item) => item.id === chapterId);
    if (!chapter) return { chapterId, error: { code: "CHAPTER_NOT_FOUND", message: "离线副本中不存在该章节。" } };
    if (chapter.chapterType === "作者的话") return { chapterId, error: { code: "CHAPTER_AUTHOR_NOTE_EXCLUDED", message: "Author notes are excluded from AI context." } };
    return {
      id: chapter.id,
      title: chapter.title,
      volumeTitle: chapter.volumeTitle,
      storyOrder: chapter.storyOrder,
      ...(include !== "content" ? { summary: text(chapter.summary, 2_000) } : {}),
      ...(include !== "summary" ? { content: text(chapter.content, 20_000) } : {})
    };
  });
  return fitResult({ chapters });
}

function paragraphsOf(content) {
  const textValue = String(content ?? "").replace(/\r\n?/gu, "\n");
  const parts = textValue.split(/\n\s*\n/u);
  let line = 1;
  return parts.map((part) => {
    const startLine = line;
    const consumed = part.split("\n").length;
    line += consumed + 1;
    return { text: part.trim(), startLine, endLine: startLine + consumed - 1 };
  }).filter((part) => part.text);
}

function grepChapters(corpus, args) {
  const keyword = String(args.keyword ?? "").trim();
  if (!keyword || keyword.length > 200) return unavailable("TOOL_ARGUMENTS_INVALID", "Invalid arguments for grep: keyword is required.");
  const limit = integer(args.limit, 20, 1, 100);
  const cursor = integer(args.cursor, 0, 0, 10_000);
  const needle = keyword.toLocaleLowerCase("zh-CN");
  const matches = [];
  for (const chapter of proseChapters(corpus)) {
    for (const paragraph of paragraphsOf(chapter.content)) {
      if (!paragraph.text.toLocaleLowerCase("zh-CN").includes(needle)) continue;
      matches.push({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        volumeTitle: chapter.volumeTitle,
        storyOrder: chapter.storyOrder,
        startLine: paragraph.startLine,
        endLine: paragraph.endLine,
        paragraph: text(paragraph.text, 1_000)
      });
    }
  }
  const { page, nextCursor, total } = slicePage(matches, cursor, limit);
  const latest = matches.length ? matches[matches.length - 1] : null;
  return fitResult({
    keyword,
    total,
    matches: page,
    latestOccurrences: { byStructure: latest },
    ...(nextCursor !== null ? { pagination: { nextCursor } } : {})
  });
}

function searchableText(value) {
  return JSON.stringify(value ?? "").toLocaleLowerCase("zh-CN");
}

function categoryRecords(corpus, category) {
  if (category === "setting") return corpus.settings ?? [];
  if (category === "character") return corpus.characters ?? [];
  if (category === "race") return corpus.races ?? [];
  if (category === "organization") return corpus.organizations ?? [];
  if (category === "timeline") return [...(corpus.timelineTracks ?? []), ...(corpus.timelineEvents ?? [])];
  if (category === "relationship") return corpus.relationships ?? [];
  if (category === "outline") return corpus.outlines ?? [];
  if (category === "foreshadow") return corpus.foreshadows ?? [];
  return [];
}

function categoryEntityType(category) {
  if (category === "timeline") return "timeline-event";
  if (category === "outline") return "chapter-outline";
  if (category === "setting") return null;
  return category;
}

function searchEntities(corpus, args) {
  const query = String(args.query ?? "").trim();
  if (!query || query.length > 200) return unavailable("TOOL_ARGUMENTS_INVALID", "Invalid arguments for search_story_entities: query is required.");
  const requested = Array.isArray(args.categories) && args.categories.length
    ? args.categories.filter((category) => Object.hasOwn(ENTITY_CATEGORY_MODULES, category))
    : Object.keys(ENTITY_CATEGORY_MODULES);
  const needle = query.toLocaleLowerCase("zh-CN");
  const matches = [];
  const unavailableCategories = [];
  for (const category of requested) {
    const moduleName = ENTITY_CATEGORY_MODULES[category];
    if (!canReadModule(corpus.permissions, moduleName)) {
      unavailableCategories.push({ category, code: "WORK_MODULE_READ_DENIED" });
      continue;
    }
    const entityType = categoryEntityType(category);
    if (entityType && corpusModuleState(corpus, entityType) === "missing") {
      unavailableCategories.push({ category, code: "OFFLINE_CORPUS_MISSING" });
      continue;
    }
    if (entityType && corpusModuleState(corpus, entityType) === "denied") {
      unavailableCategories.push({ category, code: "WORK_MODULE_READ_DENIED" });
      continue;
    }
    for (const item of categoryRecords(corpus, category)) {
      if (!searchableText(item).includes(needle)) continue;
      matches.push({
        category,
        id: String(item.id ?? ""),
        title: String(item.title ?? item.name ?? ""),
        name: String(item.name ?? item.title ?? ""),
        ...(item.gender !== undefined ? { gender: item.gender } : {}),
        ...(item.isDead !== undefined ? { isDead: item.isDead === true } : {}),
        ...(item.isExtinct !== undefined ? { isExtinct: item.isExtinct === true } : {}),
        ...(item.isDissolved !== undefined ? { isDissolved: item.isDissolved === true } : {}),
        ...(item.sectionId ? { sectionId: String(item.sectionId) } : {}),
        ...(Array.isArray(record(item.profile)?.sections)
          ? { sectionIds: record(item.profile).sections.map((section) => String(section?.id ?? "")).filter(Boolean).slice(0, 20) }
          : {}),
        summary: text(item.summary ?? item.description ?? item.content ?? "", 500)
      });
    }
  }
  const { page, nextCursor, total } = slicePage(matches, args.cursor, integer(args.limit, 30, 1, 30));
  return fitResult({
    query,
    total,
    matches: page,
    ...(unavailableCategories.length ? {
      unavailableCategories,
      hint: "标记为 OFFLINE_CORPUS_MISSING 的模块不在当前离线副本中，不能据此判断该模块没有资料。"
    } : {}),
    ...(nextCursor !== null ? { pagination: { nextCursor } } : {})
  });
}

function semanticSearch(corpus, args) {
  const query = String(args.query ?? "").trim();
  if (!query) return unavailable("TOOL_ARGUMENTS_INVALID", "Invalid arguments for semantic_search_story: query is required.");
  const keyword = query.slice(0, 40);
  const searched = searchEntities(corpus, { query: keyword, categories: ["setting", "character", "race", "organization", "timeline", "relationship", "outline", "foreshadow"], limit: args.limit, cursor: args.cursor });
  const prose = grepChapters(corpus, { keyword, limit: integer(args.limit, 12, 1, 30), cursor: 0 });
  return fitResult({
    degraded: true,
    matchType: "keyword",
    hint: "离线副本没有语义索引，以下结果只是关键词降级，不是 semantic 命中。",
    query,
    prose: prose.ok ? prose.data.matches : [],
    entities: searched.ok ? searched.data.matches : []
  });
}

function characterSections(corpus) {
  const sections = [];
  for (const character of corpus.characters ?? []) {
    const profile = record(character.profile);
    const nested = Array.isArray(character.sections)
      ? character.sections
      : Array.isArray(character.profileSections)
        ? character.profileSections
        : Array.isArray(profile?.sections)
          ? profile.sections
          : [];
    for (const section of nested) {
      sections.push({ ...section, characterId: String(section.characterId ?? character.id), character });
    }
  }
  return sections;
}

function readCharacterSections(corpus, args) {
  if (corpusModuleState(corpus, "character") === "missing") {
    return unavailable("OFFLINE_CORPUS_MISSING", "离线副本尚未包含人物档案。联网同步作品后再试。");
  }
  const ids = Array.isArray(args.sectionIds) ? args.sectionIds.map((id) => String(id)).slice(0, 3) : [];
  if (!ids.length) return unavailable("TOOL_ARGUMENTS_INVALID", "Invalid arguments for read_character_sections: sectionIds is required.");
  const include = ["summary", "content", "both"].includes(args.include) ? args.include : "both";
  const sections = ids.map((sectionId) => {
    const section = characterSections(corpus).find((item) => String(item.id) === sectionId);
    if (!section) return { sectionId, error: { code: "SECTION_NOT_FOUND", message: "离线副本中不存在该人物档案章节。" } };
    return {
      id: String(section.id),
      characterId: section.characterId,
      title: String(section.title ?? ""),
      gender: section.character?.gender,
      isDead: section.character?.isDead === true,
      ...(include !== "content" ? { summary: text(section.summary, 2_000) } : {}),
      ...(include !== "summary" ? { content: text(section.contentMarkdown ?? section.content ?? "", 20_000) } : {})
    };
  });
  return fitResult({ sections });
}

function searchDrafts(corpus, args) {
  if (corpusModuleState(corpus, "draft") === "missing") {
    return unavailable("OFFLINE_CORPUS_MISSING", "离线副本尚未包含作者想法。联网同步作品后再试。");
  }
  const query = String(args.query ?? "").trim().toLocaleLowerCase("zh-CN");
  const draftType = ["prose", "setting"].includes(args.draftType) ? args.draftType : "all";
  const drafts = (corpus.drafts ?? []).filter((draft) => {
    if (draftType !== "all" && draft.draftType !== draftType && draft.type !== draftType) return false;
    return !query || searchableText(draft).includes(query);
  });
  const { page, nextCursor, total } = slicePage(drafts.map((draft) => ({
    id: String(draft.id ?? ""),
    title: String(draft.title ?? ""),
    draftType: String(draft.draftType ?? draft.type ?? ""),
    content: text(draft.content ?? "", 1_000),
    updatedAt: draft.updatedAt ?? null
  })), args.cursor, integer(args.limit, 20, 1, 30));
  return fitResult({
    total,
    drafts: page,
    hint: "想法不是已确认的故事事实。",
    ...(nextCursor !== null ? { pagination: { nextCursor } } : {})
  });
}

function findAttachment(corpus, attachmentId) {
  const marker = `attachment://${attachmentId}`;
  const pools = [
    ...(corpus.settings ?? []).map((item) => ({ module: "setting", id: item.id, content: item.content })),
    ...(corpus.characters ?? []).map((item) => ({ module: "character", id: item.id, content: JSON.stringify(item) }))
  ];
  return pools.find((item) => String(item.content ?? "").includes(marker)) ?? null;
}

function readImage(corpus, args) {
  const attachmentId = String(args.attachmentId ?? "").trim();
  if (!attachmentId || attachmentId.length > 300) return unavailable("TOOL_ARGUMENTS_INVALID", "Invalid arguments for image: attachmentId is required.");
  const found = findAttachment(corpus, attachmentId);
  if (!found) return unavailable("IMAGE_NOT_FOUND", "离线副本的设定库正文中没有这个 attachmentId。");
  return unavailable("OFFLINE_IMAGE_BYTES_UNAVAILABLE", "离线副本只保存了图片引用，没有图片字节，不能查看图片内容。");
}

function parseDateParts(value) {
  const match = String(value ?? "").trim().match(/^(-?\d{1,6})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, date };
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function calculateTime(args) {
  const start = parseDateParts(args.startDate);
  const end = parseDateParts(args.endDate);
  if (!start || !end) return unavailable("TOOL_ARGUMENTS_INVALID", "Invalid arguments for calculate_time: expected YYYY-MM-DD dates.");
  const totalDays = Math.round((end.date.getTime() - start.date.getTime()) / 86_400_000);
  const [from, to] = start.date <= end.date ? [start, end] : [end, start];
  let years = to.year - from.year;
  let months = to.month - from.month;
  let days = to.day - from.day;
  if (days < 0) {
    months -= 1;
    const previous = new Date(Date.UTC(to.year, to.month - 1, 1));
    previous.setUTCFullYear(to.year, to.month - 1, 0);
    days += previous.getUTCDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  const leapYears = [];
  for (let year = from.year; year <= to.year; year += 1) {
    if (!isLeapYear(year)) continue;
    const leapDay = parseDateParts(`${year}-02-29`);
    if (!leapDay) continue;
    if (leapDay.date >= from.date && leapDay.date < to.date) leapYears.push(year);
  }
  return {
    ok: true,
    data: {
      startDate: args.startDate,
      endDate: args.endDate,
      totalDays,
      direction: totalDays >= 0 ? "forward" : "backward",
      absoluteDays: Math.abs(totalDays),
      ymdBreakdown: { years, months, days },
      ...(leapYears.length ? { leapYears } : {})
    }
  };
}

function parseToolArguments(value) {
  if (record(value)) return value;
  if (typeof value !== "string") return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

export function executeDesktopOfflineChatTool(corpus, name, rawArguments) {
  const args = parseToolArguments(rawArguments) ?? {};
  if (name === "story_index") return storyIndex(corpus, args);
  if (name === "read_chapters") return readChapters(corpus, args);
  if (name === "grep") return grepChapters(corpus, args);
  if (name === "search_story_entities") return searchEntities(corpus, args);
  if (name === "semantic_search_story") return semanticSearch(corpus, args);
  if (name === "read_character_sections") return readCharacterSections(corpus, args);
  if (name === "search_drafts") return searchDrafts(corpus, args);
  if (name === "image") return readImage(corpus, args);
  if (name === "calculate_time") return calculateTime(args);
  return unavailable("TOOL_NOT_AVAILABLE", `Tool '${name}' is not available in offline chat.`);
}

export function desktopOfflineUserTurn({ markup, text: plainText, citations = [], scope = {} } = {}) {
  const content = String(markup ?? plainText ?? "").trim();
  const normalizedCitations = (Array.isArray(citations) ? citations : []).map((citation) => ({
    chapterId: citation.chapterId,
    chapterTitle: citation.chapterTitle,
    startLine: citation.startLine,
    endLine: citation.endLine,
    text: citation.text
  }));
  const citationBlock = normalizedCitations
    .map((citation) => `[${citation.chapterTitle ?? ""} ${citation.startLine ?? ""}-${citation.endLine ?? ""}]\n${citation.text ?? ""}`)
    .join("\n\n");
  const metadata = {
    ...(Array.isArray(scope.characterIds) && scope.characterIds.length ? { mentionCharacterIds: scope.characterIds } : {}),
    ...(Array.isArray(scope.settingIds) && scope.settingIds.length ? { mentionSettingIds: scope.settingIds } : {}),
    ...(Array.isArray(scope.chapterIds) && scope.chapterIds.length ? { mentionChapterIds: scope.chapterIds } : {}),
    ...(Array.isArray(scope.raceIds) && scope.raceIds.length ? { mentionRaceIds: scope.raceIds } : {}),
    ...(Array.isArray(scope.organizationIds) && scope.organizationIds.length ? { mentionOrganizationIds: scope.organizationIds } : {}),
    ...(scope.includeSettingInfo === true ? { mentionContextSettingIds: ["include-setting-info"] } : {})
  };
  return {
    role: "user",
    content,
    modelContent: citationBlock ? `${content}\n\n<cited_passages>\n${citationBlock}\n</cited_passages>` : content,
    citations: normalizedCitations,
    metadata
  };
}

export function desktopOfflineAssistantTurn({ content, processSteps = [], toolCalls = [], processDurationMs = null, modelDisplayName = "", outputTokens = null }) {
  return {
    role: "assistant",
    content: String(content ?? ""),
    modelContent: String(content ?? ""),
    citations: [],
    metadata: {
      ...(modelDisplayName ? { modelDisplayName } : {}),
      ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
      ...(Array.isArray(toolCalls) && toolCalls.length ? { toolCalls } : {}),
      ...(Array.isArray(processSteps) && processSteps.length ? { processSteps } : {}),
      ...(Number.isFinite(processDurationMs) ? { processDurationMs } : {})
    }
  };
}

function protocolShape(protocol) {
  if (protocol === "openai-responses") return "responses";
  if (protocol === "anthropic-messages") return "anthropic";
  return "chat";
}

function serializedArguments(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

export function buildDesktopOfflineAgentBody({ protocol, modelId, messages, tools, temperature = 0, maxTokens = 32_000 }) {
  const safeTools = Array.isArray(tools) ? tools : [];
  const safeMessages = Array.isArray(messages) ? messages : [];
  if (protocolShape(protocol) === "responses") {
    const input = [];
    for (const message of safeMessages) {
      if (message.role === "tool") {
        input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
        continue;
      }
      if (message.role === "system" || message.role === "user" || (message.role === "assistant" && message.content)) {
        input.push({
          type: "message",
          role: message.role === "assistant" ? "assistant" : message.role,
          content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }]
        });
      }
      if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
        for (const toolCall of message.toolCalls) {
          input.push({ type: "function_call", call_id: toolCall.id, name: toolCall.name, arguments: serializedArguments(toolCall.arguments) });
        }
      }
    }
    return {
      model: modelId,
      input,
      temperature,
      max_output_tokens: maxTokens,
      ...(safeTools.length ? {
        tools: safeTools.map((tool) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        })),
        tool_choice: "auto"
      } : {})
    };
  }
  if (protocolShape(protocol) === "anthropic") {
    const system = safeMessages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messagesForModel = [];
    for (const message of safeMessages) {
      if (message.role === "system") continue;
      if (message.role === "tool") {
        const block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content };
        const previous = messagesForModel.at(-1);
        if (previous?.role === "user" && Array.isArray(previous.content)) previous.content.push(block);
        else messagesForModel.push({ role: "user", content: [block] });
        continue;
      }
      if (message.role === "assistant") {
        const content = [];
        if (message.content) content.push({ type: "text", text: message.content });
        for (const toolCall of message.toolCalls ?? []) {
          content.push({ type: "tool_use", id: toolCall.id, name: toolCall.name, input: parseToolArguments(toolCall.arguments) ?? {} });
        }
        if (content.length) messagesForModel.push({ role: "assistant", content });
        continue;
      }
      messagesForModel.push({ role: "user", content: [{ type: "text", text: message.content }] });
    }
    return {
      model: modelId,
      ...(system ? { system } : {}),
      messages: messagesForModel,
      temperature,
      max_tokens: maxTokens,
      ...(safeTools.length ? {
        tools: safeTools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters
        })),
        tool_choice: { type: "auto" }
      } : {})
    };
  }
  return {
    model: modelId,
    messages: safeMessages.map((message) => {
      if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
      if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length) {
        return {
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: { name: toolCall.name, arguments: serializedArguments(toolCall.arguments) }
          }))
        };
      }
      return { role: message.role, content: message.content };
    }),
    temperature,
    max_tokens: maxTokens,
    ...(safeTools.length ? { tools: safeTools, tool_choice: "auto" } : {})
  };
}

export function parseDesktopOfflineAgentTurn(protocol, payload) {
  const body = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (protocolShape(protocol) === "anthropic") {
    const blocks = Array.isArray(body?.content) ? body.content : [];
    const content = blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
    const reasoning = blocks.filter((block) => block?.type === "thinking" && typeof block.thinking === "string").map((block) => block.thinking).join("");
    const toolCalls = blocks.flatMap((block) => (
      block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string"
        ? [{ id: block.id, name: block.name, arguments: block.input ?? {} }]
        : []
    ));
    return { content, reasoning, toolCalls };
  }
  if (protocolShape(protocol) === "responses") {
    const output = Array.isArray(body?.output) ? body.output : [];
    let content = typeof body?.output_text === "string" ? body.output_text : "";
    let reasoning = "";
    const toolCalls = [];
    for (const item of output) {
      if (item?.type === "message" && !content) {
        content = (Array.isArray(item.content) ? item.content : []).flatMap((part) => part?.type === "output_text" && typeof part.text === "string" ? [part.text] : []).join("");
      } else if (item?.type === "reasoning") {
        const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])];
        reasoning += parts.flatMap((part) => typeof part?.text === "string" ? [part.text] : []).join("");
      } else if (item?.type === "function_call" && typeof item.name === "string") {
        toolCalls.push({ id: String(item.call_id ?? item.id ?? ""), name: item.name, arguments: item.arguments ?? {} });
      }
    }
    return { content, reasoning, toolCalls: toolCalls.filter((toolCall) => toolCall.id && toolCall.name) };
  }
  const message = body?.choices?.[0]?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.flatMap((toolCall) => {
    const name = toolCall?.function?.name;
    const id = toolCall?.id;
    if (typeof name !== "string" || typeof id !== "string" || !name || !id) return [];
    return [{ id, name, arguments: toolCall.function.arguments ?? {} }];
  }) : [];
  return {
    content: typeof message.content === "string" ? message.content : "",
    reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
    toolCalls
  };
}

export async function runDesktopOfflineAgentLoop({
  protocol,
  modelId,
  messages,
  tools,
  corpus,
  completeRound,
  onEvent = () => {},
  temperature = 0,
  maxTokens = 32_000,
  maxRounds = 8,
  now = () => new Date().toISOString()
}) {
  const conversation = (Array.isArray(messages) ? messages : []).map((message) => ({ ...message }));
  const processSteps = [];
  const completedToolCalls = [];
  let content = "";
  for (let round = 1; round <= maxRounds; round += 1) {
    const body = buildDesktopOfflineAgentBody({ protocol, modelId, messages: conversation, tools, temperature, maxTokens });
    let reasoning = "";
    const contentDeltas = [];
    const response = await completeRound(body, (event) => {
      if (event?.type === "reasoning-delta" && typeof event.delta === "string" && event.delta) {
        reasoning += event.delta;
        onEvent({ type: "reasoning-delta", round, delta: event.delta });
      } else if (event?.type === "content-delta" && typeof event.delta === "string" && event.delta) {
        contentDeltas.push(event.delta);
      }
    });
    if (!response || Number(response.status) >= 400) {
      let message = "AI 供应商调用失败";
      try {
        const parsed = JSON.parse(String(response?.body ?? ""));
        if (typeof parsed?.error?.message === "string" && parsed.error.message) message = parsed.error.message;
      } catch { /* 保留默认错误 */ }
      throw Object.assign(new Error(message), { code: "AI_CALL_FAILED" });
    }
    const turn = parseDesktopOfflineAgentTurn(protocol, response.body);
    if (!reasoning && turn.reasoning) {
      reasoning = turn.reasoning;
      onEvent({ type: "reasoning-delta", round, delta: turn.reasoning });
    }
    if (reasoning) {
      processSteps.push({ id: `provider-thinking-${round}`, type: "thinking", round, content: reasoning, createdAt: now() });
    }
    const roundText = contentDeltas.join("") || turn.content;
    if (turn.toolCalls.length) {
      if (roundText) {
        const step = { id: `provider-intermediate-${round}`, type: "intermediate", round, content: roundText, createdAt: now() };
        processSteps.push(step);
        onEvent({ type: "process-step", step });
      }
      conversation.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
      for (const toolCall of turn.toolCalls) {
        const result = executeDesktopOfflineChatTool(corpus, toolCall.name, toolCall.arguments);
        const completed = {
          id: toolCall.id,
          name: toolCall.name,
          arguments: parseToolArguments(toolCall.arguments) ?? {},
          calledAt: now(),
          status: result.ok === false ? "failed" : "completed",
          result
        };
        completedToolCalls.push(completed);
        processSteps.push({
          id: `tool-${toolCall.id}`,
          type: "tool",
          round,
          toolCall: completed,
          createdAt: completed.calledAt
        });
        onEvent({ type: "tool-call", round, toolCall: completed });
        conversation.push({ role: "tool", toolCallId: toolCall.id, name: toolCall.name, content: JSON.stringify(result) });
      }
      continue;
    }
    content = roundText;
    if (contentDeltas.length) {
      for (const delta of contentDeltas) onEvent({ type: "content-delta", delta });
    } else if (content) {
      onEvent({ type: "content-delta", delta: content });
    }
    break;
  }
  if (!content) throw new Error("AI 供应商未返回内容");
  return { content, processSteps, toolCalls: completedToolCalls };
}

export const DESKTOP_OFFLINE_CORPUS_SOURCES = [
  { entityType: "character", path: (workId) => `/api/works/${encodeURIComponent(workId)}/characters?includeSections=true` },
  { entityType: "race", path: (workId) => `/api/works/${encodeURIComponent(workId)}/races` },
  { entityType: "organization", path: (workId) => `/api/works/${encodeURIComponent(workId)}/organizations` },
  { entityType: "timeline-track", path: (workId) => `/api/works/${encodeURIComponent(workId)}/timeline-tracks` },
  { entityType: "timeline-event", path: (workId) => `/api/works/${encodeURIComponent(workId)}/timeline` },
  { entityType: "relationship", path: (workId) => `/api/works/${encodeURIComponent(workId)}/relationships` },
  { entityType: "chapter-outline", path: (workId) => `/api/works/${encodeURIComponent(workId)}/outlines` },
  { entityType: "foreshadow", path: (workId) => `/api/works/${encodeURIComponent(workId)}/foreshadows` },
  { entityType: "draft", path: (workId) => `/api/works/${encodeURIComponent(workId)}/drafts?includeContent=true` }
];

function pageRecords(result) {
  if (Array.isArray(result)) return { items: result, hasMore: false, nextPage: null };
  if (Array.isArray(result?.items)) {
    return { items: result.items, hasMore: result.hasMore === true, nextPage: Number.isInteger(result.nextPage) ? result.nextPage : null };
  }
  return { items: [], hasMore: false, nextPage: null };
}

export async function collectDesktopOfflineCorpus(workId, request) {
  const modules = {};
  const groups = [];
  for (const source of DESKTOP_OFFLINE_CORPUS_SOURCES) {
    try {
      const items = [];
      let page = 1;
      let guard = 0;
      while (guard < 200) {
        guard += 1;
        const separator = source.path(workId).includes("?") ? "&" : "?";
        const result = await request(`${source.path(workId)}${separator}page=${page}&limit=100`);
        const parsed = pageRecords(result);
        items.push(...parsed.items.filter((item) => item && typeof item === "object" && !Array.isArray(item) && item.id));
        if (!parsed.hasMore || !parsed.nextPage || parsed.nextPage <= page) break;
        page = parsed.nextPage;
      }
      modules[source.entityType] = "ready";
      groups.push({ entityType: source.entityType, records: items });
    } catch (error) {
      const denied = error?.status === 403 || error?.code === "WORK_MODULE_READ_DENIED";
      if (!denied) continue;
      modules[source.entityType] = "denied";
      groups.push({ entityType: source.entityType, records: [] });
    }
  }
  groups.push({
    entityType: "agent-corpus",
    records: [{ id: "status", modules, updatedAt: new Date().toISOString() }]
  });
  return groups;
}
