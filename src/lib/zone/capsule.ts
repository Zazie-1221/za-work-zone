import type { Workspace, ZoneFile } from "@/lib/zone/model";

/**
 * 收起胶囊的内容槽位。
 *
 * 胶囊本身是固定尺寸的，里面只有三个槽：lead（左边的小标记）、text（一行摘要）、trail（右边的小徽标）。
 * 每个槽的内容由「摘要提供者」决定：提供者按优先级排队，每个槽取第一个给了内容的提供者。
 * 以后想加剪贴板、计时器、媒体播放之类的摘要，只需要 registerCapsuleProvider 一个新的提供者，
 * 不用动胶囊的布局和窗口逻辑。
 */

export type StageTone = "sketch" | "model" | "render" | "deliver" | "none";

export type CapsuleLead = { kind: "dot"; tone: StageTone };

export type CapsuleSummary = {
  lead?: CapsuleLead;
  text?: string;
  trail?: string;
  /** 悬停提示。 */
  title?: string;
};

export type CapsuleContext = {
  workspace?: Workspace;
  files: ZoneFile[];
};

export type CapsuleProvider = {
  id: string;
  /** 越大越优先。内置的项目摘要是 0。 */
  priority: number;
  summarize: (ctx: CapsuleContext) => CapsuleSummary | null;
};

/** 悬停预览与展开的延迟：显示快、隐藏慢，避免鼠标一滑过就弹、一离开就缩。 */
export const CAPSULE_TIMING = { showMs: 350, hideMs: 700 } as const;

const providers = new Map<string, CapsuleProvider>();

export function registerCapsuleProvider(provider: CapsuleProvider): () => void {
  providers.set(provider.id, provider);
  return () => {
    if (providers.get(provider.id) === provider) providers.delete(provider.id);
  };
}

export function resolveCapsule(ctx: CapsuleContext): CapsuleSummary {
  const ordered = [...providers.values()].sort((a, b) => b.priority - a.priority);
  const out: CapsuleSummary = {};
  for (const provider of ordered) {
    let part: CapsuleSummary | null = null;
    try {
      part = provider.summarize(ctx);
    } catch {
      part = null;
    }
    if (!part) continue;
    out.lead ??= part.lead;
    out.text ??= part.text;
    out.trail ??= part.trail;
    out.title ??= part.title;
    if (out.lead && out.text && out.trail && out.title) break;
  }
  return out;
}

const STAGE_LABEL: Record<Exclude<StageTone, "none">, string> = {
  sketch: "草图",
  model: "建模",
  render: "渲染",
  deliver: "交付",
};

/** 按阶段文件夹的名字认阶段，认不出来就是 none。 */
export function stageTone(name?: string): { tone: StageTone; label: string } {
  if (!name) return { tone: "none", label: "" };
  const tone: StageTone = /草图|sketch/i.test(name)
    ? "sketch"
    : /建模|模型|model/i.test(name)
      ? "model"
      : /渲染|render/i.test(name)
        ? "render"
        : /交付|deliver/i.test(name)
          ? "deliver"
          : "none";
  return { tone, label: tone === "none" ? "" : STAGE_LABEL[tone] };
}

/** 内置提供者：当前项目 + 当前阶段 + 文件数。 */
const projectProvider: CapsuleProvider = {
  id: "project",
  priority: 0,
  summarize: ({ workspace, files }) => {
    if (!workspace) return { lead: { kind: "dot", tone: "none" } };
    const stage = stageTone(workspace.folders.find((folder) => folder.id === workspace.currentStageId)?.name);
    const count = files.filter((file) => file.workspaceId === workspace.id).length;
    const text = [workspace.name, stage.label].filter(Boolean).join(" · ");
    return {
      lead: { kind: "dot", tone: stage.tone },
      text,
      trail: count > 0 ? (count > 99 ? "99+" : String(count)) : undefined,
      title: [text, count > 0 ? `${count} 个文件` : ""].filter(Boolean).join(" · "),
    };
  },
};

registerCapsuleProvider(projectProvider);
