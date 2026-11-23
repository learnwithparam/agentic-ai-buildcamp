// The screenshots the docs show, as data. Each name must match an image link in docs/.
// A shot opens one web page, may do one UI step, then saves a PNG in docs/images/.

export type Surface = "board" | "chat" | "phoenix";
export type UiStep = "none" | "ask" | "chart" | "approval";

export type Shot = {
  name: string;
  doc: string;
  surface: Surface;
  step: UiStep;
};

export const IMAGE_DIR = "docs/images";
export const VIEWPORT = { width: 1280, height: 800 };

// Where each web surface lives. A learner can point a surface somewhere else with an env var.
export const SURFACE_URL: Record<Surface, { env: string; fallback: string }> = {
  board: { env: "BOARD_URL", fallback: "http://localhost:3000" },
  chat: { env: "CHAT_UI_URL", fallback: "http://localhost:3001" },
  phoenix: { env: "PHOENIX_URL", fallback: "http://localhost:6006" },
};

export const SHOTS: Shot[] = [
  {
    name: "01-gateway-tracing-trace.png",
    doc: "docs/modules/01-gateway-tracing.md",
    surface: "phoenix",
    step: "none",
  },
  {
    name: "07-analytics-mcp-chart.png",
    doc: "docs/modules/07-analytics-mcp.md",
    surface: "chat",
    step: "chart",
  },
  {
    name: "08-surfaces-board.png",
    doc: "docs/modules/08-surfaces.md",
    surface: "board",
    step: "none",
  },
  {
    name: "08-surfaces-answer.png",
    doc: "docs/modules/08-surfaces.md",
    surface: "board",
    step: "ask",
  },
  {
    name: "10-approvals-memory-card.png",
    doc: "docs/modules/10-approvals-memory.md",
    surface: "chat",
    step: "approval",
  },
];
