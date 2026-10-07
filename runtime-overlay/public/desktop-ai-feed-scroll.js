const programmaticScrollDepth = new WeakMap();

export function isProgrammaticScroll(container) {
  return (programmaticScrollDepth.get(container) ?? 0) > 0;
}

export function runProgrammaticScroll(container, update) {
  if (!container || typeof update !== "function") return undefined;
  programmaticScrollDepth.set(container, (programmaticScrollDepth.get(container) ?? 0) + 1);
  try {
    return update();
  } finally {
    const depth = (programmaticScrollDepth.get(container) ?? 1) - 1;
    if (depth > 0) programmaticScrollDepth.set(container, depth);
    else programmaticScrollDepth.delete(container);
  }
}

function laidOutContentEnd(container) {
  const last = container.lastElementChild;
  if (!last) return Number(container.scrollHeight) || 0;
  if (typeof container.getBoundingClientRect === "function" && typeof last.getBoundingClientRect === "function") {
    const host = container.getBoundingClientRect();
    const child = last.getBoundingClientRect();
    return child.bottom - host.top + (Number(container.scrollTop) || 0);
  }
  return (Number(last.offsetTop) || 0) + (Number(last.offsetHeight) || 0);
}

export function pinScrollContainerToBottom(container) {
  if (!container || container.isConnected === false) return { reached: false, released: false };
  if (container.style && container.style.overflowAnchor !== "none") container.style.overflowAnchor = "none";
  if (typeof container.offsetHeight === "number") void container.offsetHeight;
  let released = false;
  const scrollHeight = Number(container.scrollHeight) || 0;
  const laidOutEnd = laidOutContentEnd(container);
  const parent = container.parentNode;
  if (
    laidOutEnd > scrollHeight + 4
    && parent
    && typeof parent.removeChild === "function"
    && typeof parent.insertBefore === "function"
  ) {
    const next = container.nextSibling ?? null;
    parent.removeChild(container);
    parent.insertBefore(container, next);
    released = true;
    if (typeof container.offsetHeight === "number") void container.offsetHeight;
  }
  const nextHeight = Number(container.scrollHeight) || 0;
  container.scrollTop = nextHeight;
  const remaining = nextHeight - (Number(container.scrollTop) || 0) - (Number(container.clientHeight) || 0);
  return { reached: remaining <= 1, released };
}

export function pinScrollContainerAndFollow(container, {
  frames,
  requestAnimationFrame,
  shouldContinue = () => true
} = {}) {
  if (!container || container.isConnected === false || !shouldContinue()) return;
  frames?.delete(container);
  runProgrammaticScroll(container, () => {
    pinScrollContainerToBottom(container);
    if (!frames || typeof requestAnimationFrame !== "function" || !shouldContinue()) return;
    const followUp = requestAnimationFrame(() => {
      frames.delete(container);
      if (container.isConnected === false || !shouldContinue()) return;
      runProgrammaticScroll(container, () => { pinScrollContainerToBottom(container); });
    });
    frames.set(container, followUp);
  });
}
