export interface AgentPreferences {
  followEdits: boolean;
  contextLines: number;
  showFullFiles: boolean;
}

export const defaultPreferences: AgentPreferences = {
  followEdits: true,
  contextLines: 3,
  showFullFiles: false,
};

export function normalizePreferences(
  preferences: Partial<AgentPreferences>,
): AgentPreferences {
  return {
    ...defaultPreferences,
    ...preferences,
  };
}

export function shouldFollowAgent(
  preferences: AgentPreferences,
  userIsScrolling: boolean,
): boolean {
  return preferences.followEdits && !userIsScrolling;
}

export function visibleContextLines(preferences: AgentPreferences): number {
  return Math.max(0, preferences.contextLines);
}

export function shouldShowFullFile(
  preferences: AgentPreferences,
  requestedByReviewer: boolean,
): boolean {
  return preferences.showFullFiles || requestedByReviewer;
}

export function preferenceSummary(preferences: AgentPreferences): string {
  const follow = preferences.followEdits ? "following" : "paused";
  const files = preferences.showFullFiles ? "full files" : "diffs";
  return `${follow}, ${preferences.contextLines} lines, ${files}`;
}

export function parsePreferenceSummary(summary: string): string[] {
  return summary.split(", ");
}
