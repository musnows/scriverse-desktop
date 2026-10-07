import { describe, expect, it } from "vitest";
import {
  isProgrammaticScroll,
  pinScrollContainerAndFollow,
  pinScrollContainerToBottom,
  runProgrammaticScroll
} from "../../runtime-overlay/public/desktop-ai-feed-scroll.js";

function createFeed({
  scrollHeight,
  clientHeight,
  contentEnd,
  onScroll
}: {
  scrollHeight: number;
  clientHeight: number;
  contentEnd: number;
  onScroll?: () => void;
}) {
  const feed = {
    style: { overflowAnchor: "" },
    offsetHeight: clientHeight,
    clientHeight,
    scrollHeight,
    isConnected: true,
    nextSibling: null as null,
    parentNode: null as null | {
      removeChild: (node: typeof feed) => void;
      insertBefore: (node: typeof feed, next: null) => void;
    },
    lastElementChild: {
      getBoundingClientRect: () => ({ top: 0, bottom: contentEnd - feed.scrollTop })
    },
    _scrollTop: 0,
    onScroll,
    get scrollTop() {
      return this._scrollTop;
    },
    set scrollTop(value: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      this._scrollTop = Math.min(Math.max(0, value), max);
      this.onScroll?.();
    },
    getBoundingClientRect() {
      return { top: 0, bottom: this.clientHeight };
    }
  };
  const parent = {
    removeChild(node: typeof feed) {
      node.parentNode = null;
    },
    insertBefore(node: typeof feed) {
      node.parentNode = parent;
      node.scrollHeight = contentEnd;
    }
  };
  feed.parentNode = parent;
  return feed;
}

describe("offline chat scroll container", () => {
  it("pins a healthy transcript to the bottom without remounting it", () => {
    const feed = createFeed({ scrollHeight: 900, clientHeight: 80, contentEnd: 900 });
    const pinned = pinScrollContainerToBottom(feed);
    expect(pinned).toEqual({ reached: true, released: false });
    expect(feed.scrollTop).toBe(820);
    expect(feed.style.overflowAnchor).toBe("none");
    expect(feed.parentNode).not.toBeNull();
  });

  it("releases a stale scroll range so a long reply can reach the bottom", () => {
    const feed = createFeed({ scrollHeight: 200, clientHeight: 80, contentEnd: 900 });
    const pinned = pinScrollContainerToBottom(feed);
    expect(pinned.released).toBe(true);
    expect(pinned.reached).toBe(true);
    expect(feed.scrollHeight).toBe(900);
    expect(feed.scrollTop).toBe(820);
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeLessThanOrEqual(1);
  });

  it("does not treat a programmatic pin as the user leaving the bottom", () => {
    let userScrolls = 0;
    const feed = createFeed({
      scrollHeight: 900,
      clientHeight: 80,
      contentEnd: 900,
      onScroll: () => {
        if (!isProgrammaticScroll(feed)) userScrolls += 1;
      }
    });
    runProgrammaticScroll(feed, () => { pinScrollContainerToBottom(feed); });
    expect(userScrolls).toBe(0);
    expect(isProgrammaticScroll(feed)).toBe(false);
    feed.scrollTop = 20;
    expect(userScrolls).toBe(1);
  });

  it("measures the scroll range again after a large insert settles", () => {
    const frames = new Map();
    const queued = [];
    const layout = { contentEnd: 200 };
    const feed = createFeed({ scrollHeight: 200, clientHeight: 80, contentEnd: 200 });
    feed.lastElementChild.getBoundingClientRect = () => ({ top: 0, bottom: layout.contentEnd - feed.scrollTop });
    const parent = feed.parentNode;
    parent.insertBefore = (node) => {
      node.parentNode = parent;
      node.scrollHeight = layout.contentEnd;
    };
    pinScrollContainerAndFollow(feed, {
      frames,
      requestAnimationFrame: (callback) => {
        queued.push(callback);
        return queued.length;
      }
    });
    expect(feed.scrollTop).toBe(120);
    expect(feed.scrollHeight).toBe(200);
    layout.contentEnd = 900;
    queued[0]();
    expect(feed.scrollHeight).toBe(900);
    expect(feed.scrollTop).toBe(820);
    expect(feed.scrollHeight - feed.scrollTop - feed.clientHeight).toBeLessThanOrEqual(1);
  });
});
