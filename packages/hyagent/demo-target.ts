export interface ReviewComment {
  id: string;
  body: string;
  resolved: boolean;
}

export interface ReviewState {
  approved: boolean;
  openComments: number;
  comments: ReviewComment[];
}

export function canCommit(state: ReviewState): boolean {
  return state.approved;
}

export function reviewProgress(state: ReviewState): number {
  if (state.comments.length === 0) return 1;
  const resolved = state.comments.filter((comment) => comment.resolved);
  return resolved.length / state.comments.length;
}
