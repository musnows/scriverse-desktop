const DEFAULT_MATRIX_CELL_LIMIT = 2_000_000;
const DEFAULT_CHARACTER_LIMIT = 2_000_000;
const DEFAULT_LINE_LIMIT = 20_000;
const DEFAULT_TIME_LIMIT_MS = 250;

export class ThreeWayMergeLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ThreeWayMergeLimitError";
  }
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n?/gu, "\n");
}

function lines(value) {
  return normalizeText(value).split("\n");
}

function equalValue(left, right) {
  return stableValue(left) === stableValue(right);
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function boundedLineHunks(baseLines, variantLines, options, startedAt) {
  const rows = baseLines.length + 1;
  const columns = variantLines.length + 1;
  if (rows * columns > options.matrixCellLimit) throw new ThreeWayMergeLimitError("文本差异矩阵超出上限");
  const matrix = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let baseIndex = baseLines.length - 1; baseIndex >= 0; baseIndex -= 1) {
    if (baseIndex % 64 === 0 && performance.now() - startedAt > options.timeLimitMs) {
      throw new ThreeWayMergeLimitError("文本差异计算超时");
    }
    for (let variantIndex = variantLines.length - 1; variantIndex >= 0; variantIndex -= 1) {
      matrix[baseIndex][variantIndex] = baseLines[baseIndex] === variantLines[variantIndex]
        ? matrix[baseIndex + 1][variantIndex + 1] + 1
        : Math.max(matrix[baseIndex + 1][variantIndex], matrix[baseIndex][variantIndex + 1]);
    }
  }
  const operations = [];
  let baseIndex = 0;
  let variantIndex = 0;
  while (baseIndex < baseLines.length || variantIndex < variantLines.length) {
    if (
      baseIndex < baseLines.length
      && variantIndex < variantLines.length
      && baseLines[baseIndex] === variantLines[variantIndex]
    ) {
      operations.push({ type: "equal", line: baseLines[baseIndex] });
      baseIndex += 1;
      variantIndex += 1;
    } else if (
      variantIndex < variantLines.length
      && (baseIndex >= baseLines.length || matrix[baseIndex][variantIndex + 1] >= matrix[baseIndex + 1][variantIndex])
    ) {
      operations.push({ type: "insert", line: variantLines[variantIndex] });
      variantIndex += 1;
    } else {
      operations.push({ type: "delete", line: baseLines[baseIndex] });
      baseIndex += 1;
    }
  }
  const hunks = [];
  let operationIndex = 0;
  let position = 0;
  while (operationIndex < operations.length) {
    if (operations[operationIndex].type === "equal") {
      position += 1;
      operationIndex += 1;
      continue;
    }
    const start = position;
    const replacement = [];
    while (operationIndex < operations.length && operations[operationIndex].type !== "equal") {
      const operation = operations[operationIndex];
      if (operation.type === "delete") position += 1;
      if (operation.type === "insert") replacement.push(operation.line);
      operationIndex += 1;
    }
    hunks.push({ start, end: position, lines: replacement });
  }
  return hunks;
}

function hunkOverlaps(left, right) {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return left.start >= right.start && left.start <= right.end;
  if (rightInsertion) return right.start >= left.start && right.start <= left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function applyHunks(baseLines, start, end, hunks) {
  const result = [];
  let cursor = start;
  for (const hunk of [...hunks].sort((left, right) => left.start - right.start || left.end - right.end)) {
    result.push(...baseLines.slice(cursor, hunk.start));
    result.push(...hunk.lines);
    cursor = Math.max(cursor, hunk.end);
  }
  result.push(...baseLines.slice(cursor, end));
  return result;
}

function conflictMarker(localLines, serverLines) {
  return ["<<<<<<< 本地", ...localLines, "=======", ...serverLines, ">>>>>>> 线上"];
}

function manualFallback(baseText, localText, serverText, reason) {
  return {
    mode: "manual",
    mergedText: localText,
    conflicts: [{
      id: "text-conflict-1",
      kind: "whole-document",
      startLine: 1,
      endLine: Math.max(1, lines(baseText).length),
      baseText,
      localText,
      serverText,
      reason
    }],
    unresolvedBlockCount: 1,
    exceededLimit: true
  };
}

export function mergeTextDiff3(baseValue, localValue, serverValue, overrides = {}) {
  const baseText = normalizeText(baseValue);
  const localText = normalizeText(localValue);
  const serverText = normalizeText(serverValue);
  if (localText === serverText) return { mode: "auto", mergedText: localText, conflicts: [], unresolvedBlockCount: 0, exceededLimit: false };
  if (localText === baseText) return { mode: "auto", mergedText: serverText, conflicts: [], unresolvedBlockCount: 0, exceededLimit: false };
  if (serverText === baseText) return { mode: "auto", mergedText: localText, conflicts: [], unresolvedBlockCount: 0, exceededLimit: false };
  const options = {
    matrixCellLimit: overrides.matrixCellLimit ?? DEFAULT_MATRIX_CELL_LIMIT,
    characterLimit: overrides.characterLimit ?? DEFAULT_CHARACTER_LIMIT,
    lineLimit: overrides.lineLimit ?? DEFAULT_LINE_LIMIT,
    timeLimitMs: overrides.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS
  };
  const baseLines = lines(baseText);
  const localLines = lines(localText);
  const serverLines = lines(serverText);
  if (
    baseText.length + localText.length + serverText.length > options.characterLimit
    || baseLines.length + localLines.length + serverLines.length > options.lineLimit
  ) return manualFallback(baseText, localText, serverText, "limit");
  const startedAt = performance.now();
  let localHunks;
  let serverHunks;
  try {
    localHunks = boundedLineHunks(baseLines, localLines, options, startedAt).map((hunk) => ({ ...hunk, side: "local" }));
    serverHunks = boundedLineHunks(baseLines, serverLines, options, startedAt).map((hunk) => ({ ...hunk, side: "server" }));
  } catch (error) {
    if (error instanceof ThreeWayMergeLimitError) return manualFallback(baseText, localText, serverText, "limit");
    throw error;
  }
  const pending = [...localHunks, ...serverHunks].sort((left, right) => left.start - right.start || left.end - right.end || left.side.localeCompare(right.side));
  const groups = [];
  while (pending.length > 0) {
    const first = pending.shift();
    const group = [first];
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let index = 0; index < pending.length; index += 1) {
        if (!group.some((candidate) => hunkOverlaps(candidate, pending[index]))) continue;
        group.push(pending[index]);
        pending.splice(index, 1);
        expanded = true;
        index -= 1;
      }
    }
    groups.push(group);
  }
  groups.sort((left, right) => Math.min(...left.map((hunk) => hunk.start)) - Math.min(...right.map((hunk) => hunk.start)));
  const merged = [];
  const conflicts = [];
  let cursor = 0;
  for (const group of groups) {
    const start = Math.min(...group.map((hunk) => hunk.start));
    const end = Math.max(...group.map((hunk) => hunk.end));
    merged.push(...baseLines.slice(cursor, start));
    const baseSegment = baseLines.slice(start, end);
    const localSegment = applyHunks(baseLines, start, end, group.filter((hunk) => hunk.side === "local"));
    const serverSegment = applyHunks(baseLines, start, end, group.filter((hunk) => hunk.side === "server"));
    if (localSegment.join("\n") === serverSegment.join("\n")) merged.push(...localSegment);
    else if (localSegment.join("\n") === baseSegment.join("\n")) merged.push(...serverSegment);
    else if (serverSegment.join("\n") === baseSegment.join("\n")) merged.push(...localSegment);
    else {
      const id = `text-conflict-${conflicts.length + 1}`;
      conflicts.push({
        id,
        kind: "lines",
        startLine: start + 1,
        endLine: Math.max(start + 1, end),
        baseText: baseSegment.join("\n"),
        localText: localSegment.join("\n"),
        serverText: serverSegment.join("\n")
      });
      merged.push(...conflictMarker(localSegment, serverSegment));
    }
    cursor = Math.max(cursor, end);
  }
  merged.push(...baseLines.slice(cursor));
  return {
    mode: conflicts.length > 0 ? "conflict" : "auto",
    mergedText: merged.join("\n"),
    conflicts,
    unresolvedBlockCount: conflicts.length,
    exceededLimit: false
  };
}

export function mergeStructuredField(field, baseValue, localValue, serverValue) {
  if (equalValue(localValue, serverValue)) return { field, value: structuredClone(localValue), conflict: false, resolution: "same" };
  if (equalValue(localValue, baseValue)) return { field, value: structuredClone(serverValue), conflict: false, resolution: "server" };
  if (equalValue(serverValue, baseValue)) return { field, value: structuredClone(localValue), conflict: false, resolution: "local" };
  return {
    field,
    value: structuredClone(localValue),
    conflict: true,
    resolution: "unresolved",
    baseValue: structuredClone(baseValue),
    localValue: structuredClone(localValue),
    serverValue: structuredClone(serverValue)
  };
}

export function mergeEntitySnapshots(entityType, baseSnapshot, localSnapshot, serverSnapshot, options = {}) {
  const textFields = entityType === "chapter" ? ["content"] : entityType === "setting" ? ["content", "authorNote"] : [];
  const fields = entityType === "chapter"
    ? ["title", "content", "chapterType"]
    : entityType === "setting"
      ? ["title", "category", "content", "tags", "status", "locked", "evidence", "scope", "authorNote"]
      : [];
  if (fields.length === 0) throw new Error("该实体类型不支持三方合并");
  const mergedSnapshot = { ...structuredClone(serverSnapshot) };
  const conflicts = [];
  for (const field of fields) {
    if (textFields.includes(field)) {
      const merged = mergeTextDiff3(baseSnapshot?.[field], localSnapshot?.[field], serverSnapshot?.[field], options);
      mergedSnapshot[field] = merged.mergedText;
      conflicts.push(...merged.conflicts.map((conflict) => ({ ...conflict, field })));
      continue;
    }
    const merged = mergeStructuredField(field, baseSnapshot?.[field], localSnapshot?.[field], serverSnapshot?.[field]);
    mergedSnapshot[field] = merged.value;
    if (merged.conflict) conflicts.push({ ...merged, kind: "field", id: `field-conflict-${field}` });
  }
  return {
    mergedSnapshot,
    conflicts,
    unresolvedBlockCount: conflicts.length,
    automatic: conflicts.length === 0
  };
}

export function resolveTextConflict(mergedText, conflict, resolution, manualText = "") {
  const marker = [
    "<<<<<<< 本地",
    ...lines(conflict.localText),
    "=======",
    ...lines(conflict.serverText),
    ">>>>>>> 线上"
  ].join("\n");
  const replacement = resolution === "local"
    ? conflict.localText
    : resolution === "server"
      ? conflict.serverText
      : resolution === "both"
        ? [conflict.localText, conflict.serverText].filter(Boolean).join("\n")
        : String(manualText);
  return String(mergedText).replace(marker, replacement);
}
