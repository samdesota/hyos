// Temporary diagnostic logging for the agent-render flash investigation.
// Every line goes to the renderer DevTools console with an `[agent-render]`
// prefix, a monotonic counter, and a seconds timestamp so log lines can be
// correlated with what the data layer delivered and what the timeline did.

let counter = 0;

export const renderLog = (message: string): void => {
  counter += 1;
  const seconds = performance.now() / 1000;
  console.log(
    `[agent-render] ${seconds.toFixed(3)} #${counter.toString(36)} ${message}`,
  );
};

/** Short descriptor of an activity payload for log lines. */
export const describeActivity = (
  activity: { type: string } | null | undefined,
  fallback = "",
): string => {
  if (!activity) return "none";
  if (activity.type === "commentary") {
    const text = (activity as { text?: string }).text ?? "";
    return `commentary(${text.length}ch)`;
  }
  if (activity.type === "tool") {
    const detail = (activity as { detail?: string }).detail ?? "";
    return `tool(${detail.length}ch)`;
  }
  return activity.type;
};
