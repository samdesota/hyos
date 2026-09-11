import type { Component } from "solid-js";

/**
 * The view module the whiteboard renderer exposes to the app shell, in the
 * same shape as `browser.view`: one page component keyed by board id.
 */
export type WhiteboardPageProps = Readonly<{
  boardId: string;
}>;

export type WhiteboardViewModule = Readonly<{
  WhiteboardPage: Component<WhiteboardPageProps>;
}>;
