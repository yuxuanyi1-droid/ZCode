import type { CloudTaskDto } from "@zcode/cloud-protocol";

export const AUTH_PAGE_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0f1115; color: #e7eaf0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
  form { width: min(400px, 90vw); background: #161a21; border: 1px solid #262d38;
    border-radius: 14px; padding: 26px; display: flex; flex-direction: column; gap: 14px; }
  h1 { font-size: 18px; margin: 0; }
  p { margin: 0; color: #939bab; font-size: 13px; }
  input { background: #1c2129; border: 1px solid #262d38; border-radius: 8px;
    padding: 10px 12px; color: inherit; font: inherit; outline: none; }
  input:focus { border-color: #5b8cff; }
  button { background: #5b8cff; color: #0b0e13; border: none; border-radius: 8px;
    padding: 10px 14px; font: inherit; font-weight: 600; cursor: pointer; }
  ul { width: min(720px, 92vw); padding: 0; list-style: none; margin: 0; display: flex;
    flex-direction: column; gap: 10px; }
  li { background: #161a21; border: 1px solid #262d38; border-radius: 10px; padding: 14px 16px; }
  li a { color: #5b8cff; text-decoration: none; font-weight: 600; }
  .meta { color: #939bab; font-size: 12px; margin-top: 4px; }
  .shell { padding: 32px 16px; display: flex; flex-direction: column; gap: 18px; align-items: center; }
  .badge { display: inline-block; border: 1px solid #262d38; border-radius: 999px;
    padding: 1px 8px; font-size: 11px; color: #939bab; margin-left: 8px; }
  .empty { color: #939bab; }
`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderLoginPage(input: { error?: boolean } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ZCode Cloud</title><style>${AUTH_PAGE_CSS}</style></head>
<body><form method="post" action="/login">
<h1>ZCode Cloud</h1><p>${input.error ? "Invalid token." : "Sign in with your deployment token."}</p>
<input type="password" name="token" placeholder="CLOUD_ACCESS_TOKEN" autofocus required>
<button type="submit">Continue</button></form></body></html>`;
}

export function renderTaskListPage(input: {
  tasks: CloudTaskDto[];
  statusOf: (task: CloudTaskDto) => string;
}): string {
  const items = input.tasks
    .map(
      (
        task,
      ) => `<li><a href="/tasks/${encodeURIComponent(task.id)}/select">${escapeHtml(task.title)}</a>
<span class="badge">${escapeHtml(input.statusOf(task))}</span><div class="meta">${escapeHtml(task.taskStableId)}</div></li>`,
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cloud tasks</title><style>${AUTH_PAGE_CSS}</style></head>
<body><div class="shell"><h1>Cloud tasks</h1>
${input.tasks.length === 0 ? '<p class="empty">No tasks yet. Create one through the cloud API.</p>' : `<ul>${items}</ul>`}
</div></body></html>`;
}
