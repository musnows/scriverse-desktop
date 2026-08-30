export function mergeLatestChapterSaveRequest(current, next) {
  return {
    automatic: current?.automatic === true && next?.automatic === true
  };
}

export function createLatestAsyncQueue(execute, merge = (_current, next) => next) {
  if (typeof execute !== "function") throw new TypeError("execute must be a function");
  if (typeof merge !== "function") throw new TypeError("merge must be a function");

  let pending = null;
  let running = null;

  const drain = async () => {
    let result;
    try {
      while (pending !== null) {
        const input = pending;
        pending = null;
        result = await execute(input);
      }
      return result;
    } catch (error) {
      pending = null;
      throw error;
    }
  };

  return Object.freeze({
    request(input) {
      pending = pending === null ? input : merge(pending, input);
      if (running === null) {
        running = drain().finally(() => {
          running = null;
        });
      }
      return running;
    },
    isRunning() {
      return running !== null;
    }
  });
}
