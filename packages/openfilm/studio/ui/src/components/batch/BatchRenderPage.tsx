// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 批量出片页：**列表即预览**。
 *
 * 这一页只回答三个问题：这批会成什么样、哪条卡住、改完重出哪几条。
 * 参数不在这里（那是「高级」里的事）——批量出片时人要看的是结果，不是输入框。
 *
 * 复用的都是台账里已有的东西：`fields` 的间距与提示、`Card` 的三档按钮高度与圆角、
 * `ClipDownloadBadge` 的胶囊写法、`fission/fields` 的 Disclosure。没有新造视觉语言。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { button, hint } from '../fission/fields';
import {
  describeEntry, humanReason, pageState, progressLine, retryTargets, shortName, statusLabel, statusOf, statusTone, summaryLine,
  type BatchState, type PlanEntry,
} from './batch-model';

export type BatchEntry = PlanEntry & { thumb?: string | null };

export type BatchApi = {
  start: (options: { planIds?: string[]; concurrency?: number }) => Promise<{ ok: boolean; batchId?: string; message?: string }>;
  status: (batchId: string) => Promise<{ batch: any } | null>;
  retry: (batchId: string) => Promise<{ ok: boolean; batchId?: string; retried?: number; message?: string }>;
};

type Props = {
  entries: BatchEntry[];
  api: BatchApi;
  onOpenPlan?: (planId: string) => void;
  onOpenFile?: (file: string) => void;
  /** 高级设置（并发、预设）默认折叠 —— 批量出片时不看参数 */
  advanced?: React.ReactNode;
};

export function BatchRenderPage({ entries, api, onOpenPlan, onOpenFile, advanced }: Props) {
  const [batch, setBatch] = useState<any>(null);
  const [state, setState] = useState<BatchState>('idle');
  const [error, setError] = useState('');
  const [openPlan, setOpenPlan] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  /* 跑起来之后每秒问一次；跑完就停 —— 不做长轮询，也不靠 websocket。 */
  useEffect(() => {
    if (!batch?.id || state !== 'running') return;
    const timer = setInterval(() => {
      void api.status(batch.id).then((answer) => {
        if (!answer?.batch) return;
        setBatch(answer.batch);
        setState(pageState(answer.batch));
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [api, batch?.id, state]);

  const results = useMemo(() => {
    const byId = new Map<string, any>();
    for (const result of batch?.results ?? []) byId.set(String(result.planId), result);
    for (const event of batch?.events ?? []) {
      if (!byId.has(String(event.planId)) && event.ok === false) {
        byId.set(String(event.planId), { ok: false, message: event.message });
      }
    }
    return byId;
  }, [batch]);

  /* 后端结果并回条目：列表里的状态永远以"这一批"的结果为准 */
  const rows = useMemo(
    () => entries.map((entry) => ({ ...entry, result: results.get(entry.planId) ?? entry.result })),
    [entries, results],
  );

  const start = useCallback(async (planIds?: string[]) => {
    setError('');
    const answer = await api.start({ ...(planIds ? { planIds } : {}) });
    if (!answer.ok) { setError(humanReason(answer.message ?? '')); return; }
    setState('running');
    if (answer.batchId) {
      const fresh = await api.status(answer.batchId);
      if (fresh?.batch) { setBatch(fresh.batch); setState(pageState(fresh.batch)); }
    }
  }, [api]);

  const retry = useCallback(async () => {
    if (!batch?.id) return;
    setError('');
    const answer = await api.retry(batch.id);
    if (!answer.ok) { setError(humanReason(answer.message ?? '')); return; }
    setState('running');
    const fresh = await api.status(String(answer.batchId ?? batch.id));
    if (fresh?.batch) { setBatch(fresh.batch); setState(pageState(fresh.batch)); }
  }, [api, batch?.id]);

  const affected = retryTargets(rows);
  const running = state === 'running';

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-panel)]">
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">批量出片</h2>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{summaryLine(rows, state)}</p>
        </div>
        <div className="flex-1" />
        <span className={`text-[12px] ${running ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>{progressLine(batch)}</span>
        {affected.length > 0 && (
          <button type="button" className={button} onClick={() => void retry()} disabled={running}>
            只重出失败的 {affected.length} 条
          </button>
        )}
        <button
          type="button"
          className="rounded border border-[var(--accent)] bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[var(--bg-panel)] disabled:opacity-50"
          onClick={() => void start()}
          disabled={running || !rows.length}
        >
          {running ? '渲染中…' : '全部重出'}
        </button>
        {advanced && (
          <button type="button" className={button} onClick={() => setShowAdvanced((open) => !open)} aria-expanded={showAdvanced}>
            {showAdvanced ? '收起高级设置' : '高级设置'}
          </button>
        )}
      </header>

      {error && (
        <p className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-4 py-2 text-[12px] text-[var(--danger)]">
          {error}
        </p>
      )}

      {showAdvanced && advanced ? (
        <div className="border-b border-[var(--border)] px-4 py-3">{advanced}</div>
      ) : null}

      <ul className="divide-y divide-[var(--border)]">
        {rows.map((entry) => {
          const status = statusOf(entry);
          const tone = statusTone(status);
          const open = openPlan === entry.planId;
          const reason = entry.result && !entry.result.ok ? humanReason(entry.result.message) : '';
          return (
            <li key={entry.planId} className={open ? 'bg-[var(--bg-raised)]' : 'hover:bg-[var(--bg-hover)]'}>
              <div className="flex items-center gap-3 px-4 py-2.5">
                {/* 缩略图：复用素材中心的图（出片前也能看，不必等首帧） */}
                <div className="h-[52px] w-[92px] shrink-0 overflow-hidden rounded border border-[var(--border)] bg-[var(--bg-field)]">
                  {entry.thumb
                    ? <img src={entry.thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
                    : <div className="grid h-full w-full place-items-center text-[11px] text-[var(--text-muted)]">无缩略图</div>}
                </div>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setOpenPlan(open ? null : entry.planId)}
                  aria-expanded={open}
                >
                  <div className="truncate text-[13px] font-semibold">
                    {shortName(entry.planId)} · {entry.copyPreview || '（无台词）'}
                  </div>
                  <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">{describeEntry(entry)}</div>
                  {reason && <div className="mt-0.5 text-[12px] text-[var(--danger)]">{reason}</div>}
                </button>
                <span
                  className="shrink-0 rounded-full border px-2 py-0.5 text-[11px]"
                  style={{ color: tone.text, borderColor: tone.border, background: tone.bg }}
                >
                  {statusLabel(status)}
                </span>
                {entry.result?.file && (
                  <button type="button" className={button} onClick={() => onOpenFile?.(String(entry.result?.file))}>看</button>
                )}
                <button type="button" className={button} onClick={() => onOpenPlan?.(entry.planId)}>计划</button>
              </div>
              {open && (
                <div className="px-4 pb-3 pl-[7.5rem]">
                  <p className={hint}>
                    {entry.copyPreview ? `第一句：${entry.copyPreview}` : '这条计划没有台词'}
                    {typeof entry.blocking === 'number' ? ` · 合规 block ${entry.blocking}` : ''}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" className={button} onClick={() => void start([entry.planId])} disabled={running}>
                      只重出这条
                    </button>
                    <button type="button" className={button} onClick={() => onOpenPlan?.(entry.planId)}>打开计划</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {!rows.length && <li className="px-4 py-6 text-center text-[12px] text-[var(--text-muted)]">这个工程还没有计划：先用「一句话 → 计划」生成，再回来批量出片。</li>}
      </ul>
    </section>
  );
}
