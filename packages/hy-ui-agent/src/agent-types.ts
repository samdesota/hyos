export interface ElementSelection {
  tagName: string;
  text?: string;
  id?: string;
  classNames?: string[];
  attributes?: Record<string, string>;
  cssPath?: string;
  sourceHint?: string;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface QuickIterationRequest {
  instruction: string;
  selection: ElementSelection;
  contextElements?: ElementSelection[];
  screenshot?: {
    dataUrl: string;
    width: number;
    height: number;
  };
  mode?: "preview" | "apply";
}

export interface TextReplacement {
  path: string;
  find: string;
  replace: string;
}

export interface QuickIterationResult {
  id: string;
  model: string;
  summary: string;
  edits: TextReplacement[];
  applied: boolean;
}

export interface AgentActivity {
  phase: "context" | "model" | "tool" | "apply" | "complete" | "error";
  message: string;
  detail?: string;
  timestamp: number;
}

export type AgentActivityReporter = (
  activity: Omit<AgentActivity, "timestamp">,
) => void;

export interface QuickIterationAgent {
  run(
    request: QuickIterationRequest,
    report?: AgentActivityReporter,
  ): Promise<QuickIterationResult>;
}
