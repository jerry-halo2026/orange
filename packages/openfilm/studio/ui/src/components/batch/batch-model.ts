// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 批量出片页的模型（不碰 DOM，可单测）。
 *
 * 这一层只做三件事：把批次状态翻译成人看得懂的三档（可发 / 待改 / 不许发）、把失败翻成人话、
 * 算"只重出受影响的那几条"。界面只负责把它画出来。
 */

export type BatchState = 'idle' | 'running' | 'completed' | 'completed-with-failures' | 'failed';

export type PlanEntry = {
  planId: string;
  /** 计划里的台词（取第一句当标题预览） */
  copyPreview?: string;
  totalSec?: number;
  shotCount?: number;
  blocking?: number;
  canFilm?: boolean;
  /** 渲染结果 */
  result?: { ok: boolean; message: string; file?: string | null; skipped?: boolean };
  /** 素材缩略图（复用素材中心的图，出片前也能看） */
  thumb?: string | null;
  voiceId?: string;
  bgm?: string | null;
};

export type BatchStatus = 'ready' | 'needs-work' | 'blocked' | 'pending' | 'failed';

/** 一条素材的状态：能不能发。红黄绿三档，外加"还没跑"和"跑失败了"。 */
export function statusOf(entry: PlanEntry): BatchStatus {
  if (entry.result && !entry.result.ok) return 'failed';
  if (!entry.result) return 'pending';
  if (typeof entry.blocking === 'number' && entry.blocking > 0) return 'blocked';
  if (entry.canFilm === false) return 'blocked';
  return 'ready';
}

/** 状态对应的中文标签（界面上就是这一个词）。 */
export function statusLabel(status: BatchStatus): string {
  return status === 'ready' ? '可发'
    : status === 'needs-work' ? '待改'
      : status === 'blocked' ? '不许发'
        : status === 'failed' ? '失败' : '排队中';
}

/** 状态对应的颜色（走 Studio 的 token，不新造颜色）。 */
export function statusTone(status: BatchStatus): { text: string; border: string; bg: string } {
  const tone = (/** @type {string} */ name: string) => ({
    text: `var(--${name})`,
    border: `color-mix(in srgb, var(--${name}) 45%, transparent)`,
    bg: `color-mix(in srgb, var(--${name}) 12%, transparent)`,
  });
  if (status === 'ready') return tone('ok');
  if (status === 'blocked' || status === 'failed') return tone('danger');
  if (status === 'needs-work') return tone('warn');
  return { text: 'var(--text-muted)', border: 'var(--border-strong)', bg: 'var(--bg-field)' };
}

/**
 * 失败原因说人话。
 * 引擎原话常常是路径或退出码；这里把它换成"下一步该做什么"。
 */
export function humanReason(message: string): string {
  const text = String(message ?? '');
  if (/渲染器还差配置|引擎路径|CFG_ENGINE_PATHS|engine-paths/i.test(text)) return '缺渲染器配置（ffmpeg / 转场 / 素材目录）——先让 app 把 ffmpeg 下下来';
  if (/没有配音/.test(text)) return '还没有配音：先把文案合成语音，再出片';
  if (/没有排队/.test(text)) return text.replace(/^没有排队：/, '没进队列：');
  if (/找不到.*ffmpeg/i.test(text)) return '找不到 ffmpeg：app 自带的那份还没下载完';
  if (/磁盘|space/i.test(text)) return '磁盘空间不足';
  if (/超时|timeout/i.test(text)) return '渲染超时：这条素材可能损坏，先单独重出试试';
  if (/不会解析|invalid-film/i.test(text)) return '时间线文件读不出来（film.html 可能被改坏）';
  return text.split('\n')[0]?.slice(0, 120) || '没有更多信息';
}

/** 页头的一句汇总：跑了几条、几条能发、几条要改。 */
export function summaryLine(entries: PlanEntry[], state: BatchState = 'idle'): string {
  const total = entries.length;
  const ready = entries.filter((entry) => statusOf(entry) === 'ready').length;
  const failed = entries.filter((entry) => statusOf(entry) === 'failed').length;
  const blocked = entries.filter((entry) => statusOf(entry) === 'blocked').length;
  const done = entries.filter((entry) => Boolean(entry.result)).length;
  if (!total) return '这个工程还没有计划';
  if (state === 'running') return `渲染中 ${done}/${total} · 已好 ${ready} · 失败 ${failed}`;
  return `${total} 条 · 可发 ${ready}${blocked ? ` · 不许发 ${blocked}` : ''}${failed ? ` · 失败 ${failed}` : ''}`;
}

/** 只重出受影响的那几条：失败项 + 内容改过的项。 */
export function retryTargets(entries: PlanEntry[], { onlyFailed = true } = {}): string[] {
  return entries
    .filter((entry) => {
      const status = statusOf(entry);
      if (onlyFailed) return status === 'failed';
      return status === 'failed' || status === 'blocked';
    })
    .map((entry) => entry.planId);
}

/** 一行的副标题：时长 / 镜头数 / 配音 / BGM —— 一眼看清这条是怎么拼的。 */
export function describeEntry(entry: PlanEntry): string {
  const parts = [
    typeof entry.totalSec === 'number' ? `${entry.totalSec.toFixed(1)}s` : '',
    entry.shotCount ? `${entry.shotCount} 镜` : '',
    entry.voiceId ? `配音 ${entry.voiceId}` : '',
    entry.bgm ? `BGM ${entry.bgm}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/** 计划名去掉批次前缀，列表里只需要看尾号。 */
export function shortName(planId: string): string {
  const match = /([^-]+-\d{3})$/.exec(planId);
  return match ? match[1] : planId;
}

/** 从 batch 状态推页面状态（后端字段 → 界面枚举）。 */
export function pageState(batch: { state?: string } | null | undefined): BatchState {
  const state = String(batch?.state ?? '');
  if (state === 'running' || state === 'completed' || state === 'completed-with-failures' || state === 'failed') {
    return state as BatchState;
  }
  return 'idle';
}

/** 进度文案：`12/100 · 完成 10 · 失败 2 · 正在 xqg-013`。 */
export function progressLine(batch: { done?: number; total?: number; ok?: number; failed?: number; skipped?: number; state?: string; events?: { planId: string }[]; verdict?: string } | null | undefined): string {
  if (!batch) return '还没有批次';
  const done = batch.done ?? 0;
  const total = batch.total ?? 0;
  const last = batch.events?.at(-1)?.planId ?? '';
  if (batch.state === 'running') return `${done}/${total} · 完成 ${batch.ok ?? 0} · 失败 ${batch.failed ?? 0}${last ? ` · 正在 ${shortName(last)}` : ' · 准备中'}`;
  return batch.verdict || `${done}/${total}`;
}
