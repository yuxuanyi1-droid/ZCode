/**
 * Composer 模型权威同步用例（2026-10-09 实测缺陷：云任务切模型后选择器仍显示旧模型）。
 *
 * 缺陷链：runtime 应用会话切换 → emit ModelSelected → v4 投影 config.modelSelection
 * 作为 state.updated 帧到达客户端（时间线 modelChange marker 能实时更新），但 composer
 * 选择器读的 per-scope 持久草稿没有任何权威消费者，停留旧值；用户不碰选择器直接发送，
 * Submission 冻结旧选型随消息下发，把 runtime 又切回去。
 *
 * 覆盖（specs/cloud-agent/04 §3.2 2026-10-09 修订二）：
 * - ModelSelected 权威帧变化 → 无标记草稿跟随运行时最新选择（选择器状态更新）；
 * - 草稿为空 / 首帧陈旧同步 → 同样跟随权威（发送后重置取运行时最新值）；
 * - 用户显式选择打 explicit 标记 → pending 意图优先于权威事件，直到发送消费
 *   （runtime 回发同选型事件后收敛并清标记）；
 * - 权威未变化的重复帧（恢复/历史重放）不扰动草稿。
 * - 草稿持久化 explicit 标记 round-trip（坏选择丢弃时标记一并失效）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "@zcode/shared";
import {
  resolveComposerModelAuthoritySync,
  sameComposerModelSelection,
} from "../src/v4/composer/composerModelAuthority.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "../src/v4/composer/composerDraftStore.js";

const GLM = (modelId: string, reasoningLevel?: string): ModelSelection => ({
  providerId: "bigmodel-coding-plan",
  modelId,
  ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
});

const BASE = {
  previousAuthority: GLM("glm-5.3") as ModelSelection | null,
  authority: GLM("glm-5.3-flash"),
  draftSelection: GLM("glm-5.3"),
  draftExplicit: false,
};

test("an unmarked stale draft follows the runtime's latest selection on ModelSelected", () => {
  // 实测缺陷核心场景：会话权威已切到 Flash，草稿（未经本端显式改选）停在 GLM-5.3。
  const decision = resolveComposerModelAuthoritySync(BASE);
  assert.deepEqual(decision, { adopt: GLM("glm-5.3-flash"), pending: false });
});

test("an empty draft adopts the authoritative selection", () => {
  // 发送后草稿重置语义：草稿没有模型意图时显示会话当前权威选择。
  const decision = resolveComposerModelAuthoritySync({ ...BASE, draftSelection: null });
  assert.deepEqual(decision, { adopt: GLM("glm-5.3-flash"), pending: false });
});

test("a stale unmarked draft adopts authority on the first observed frame", () => {
  // 换 scope/重挂载后首帧（previousAuthority=null）：持久草稿可能是上次遗留的
  // 陈旧同步；无显式标记即不是可证明的意图，直接跟随权威。
  const decision = resolveComposerModelAuthoritySync({ ...BASE, previousAuthority: null });
  assert.deepEqual(decision, { adopt: GLM("glm-5.3-flash"), pending: false });
});

test("an explicit pending draft keeps its display until the send consumes it", () => {
  // 用户在本端显式改选（explicit 标记）后，别端切换的权威事件不得覆盖显示。
  const pending = resolveComposerModelAuthoritySync({
    ...BASE,
    draftSelection: GLM("glm-5.3-x"),
    draftExplicit: true,
  });
  assert.deepEqual(pending, { adopt: null, pending: true });

  // 发送被 runtime 接纳后回发同选型 ModelSelected：草稿与权威一致 → 收敛清标记。
  const consumed = resolveComposerModelAuthoritySync({
    ...BASE,
    authority: GLM("glm-5.3-x"),
    draftSelection: GLM("glm-5.3-x"),
    draftExplicit: true,
  });
  assert.deepEqual(consumed, { adopt: null, pending: false });
});

test("converged unmarked drafts and repeated authority frames are no-ops", () => {
  // 草稿已与权威一致且无标记：不需要任何状态变化。
  assert.equal(
    resolveComposerModelAuthoritySync({
      ...BASE,
      authority: GLM("glm-5.3"),
      previousAuthority: GLM("glm-5.3"),
    }),
    null,
  );
  // 权威未变化的重复帧（恢复/历史重放反复投递）：不写草稿。
  assert.equal(resolveComposerModelAuthoritySync({ ...BASE, authority: GLM("glm-5.3") }), null);
  // 同一权威帧重复到达且草稿已跟随：仍是无操作，不产生显式标记。
  assert.equal(
    resolveComposerModelAuthoritySync({
      ...BASE,
      draftSelection: GLM("glm-5.3-flash"),
    }),
    null,
  );
});

test("selection identity compares protocol leaves, not object references", () => {
  assert.equal(sameComposerModelSelection(GLM("glm-5.3", "high"), GLM("glm-5.3", "high")), true);
  assert.equal(sameComposerModelSelection(GLM("glm-5.3", "high"), GLM("glm-5.3", "low")), false);
  assert.equal(sameComposerModelSelection(GLM("glm-5.3"), GLM("glm-5.3", "high")), false);
  assert.equal(sameComposerModelSelection(GLM("glm-5.3"), GLM("glm-4.5")), false);
  assert.equal(sameComposerModelSelection(GLM("glm-5.3"), null), false);
  assert.equal(sameComposerModelSelection(null, null), true);
});

test("draft persistence round-trips the explicit marker and drops it with a bad selection", () => {
  const storage = new Map<string, string>();
  const sandbox = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  };
  // @ts-expect-error 测试沙箱只提供草稿存储用到的 localStorage 面。
  globalThis.window = sandbox;
  try {
    persistV4ComposerDraft("/tmp/ws", undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "",
      mode: "build",
      modelSelection: GLM("glm-5.3-x", "high"),
      modelSelectionExplicit: true,
    });
    const restored = readV4ComposerDraft("/tmp/ws", undefined, V4_DRAFT_SCOPE_ROOT);
    assert.deepEqual(restored?.modelSelection, GLM("glm-5.3-x", "high"));
    assert.equal(restored?.modelSelectionExplicit, true);

    // 选择损坏（modelId 缺失）时选择与标记一并丢弃，不让孤儿标记挡住权威同步。
    const raw = JSON.parse(storage.values().next().value!) as Record<string, unknown>;
    const scope = raw.scopes as Record<string, Record<string, unknown>>;
    for (const draft of Object.values(scope)) {
      draft.modelSelection = { providerId: "bigmodel-coding-plan", modelSelectionExplicit: true };
    }
    storage.set(storage.keys().next().value!, JSON.stringify(raw));
    const repaired = readV4ComposerDraft("/tmp/ws", undefined, V4_DRAFT_SCOPE_ROOT);
    assert.equal(repaired?.modelSelection, undefined);
    assert.equal(repaired?.modelSelectionExplicit, undefined);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
