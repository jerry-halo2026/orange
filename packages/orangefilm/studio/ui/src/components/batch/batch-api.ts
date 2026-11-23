// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 批量出片页的 HTTP 客户端：四个动作，和 MCP 的 `plan.render` 打的是同一个批次注册表。
 *
 * 页面只传**工程 id**，路径由服务端解析 —— 这条规矩与 fission-local 一致，界面永远不该有能力
 * 指定文件系统位置。
 */
import type { BatchApi } from './BatchRenderPage';

const base = '/api/fission-render';

const readJson = async (response: Response) => {
  const body = await response.json().catch(() => null);
  return body && typeof body === 'object' ? body : null;
};

/** @param {string} project 当前工程 id */
export function createRenderBatchApi(project?: string): BatchApi {
  const id = () => project ?? new URLSearchParams(location.search).get('project') ?? '';
  return {
    async start({ planIds, concurrency }) {
      const response = await fetch(`${base}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: id(),
          ...(planIds?.length ? { planIds } : {}),
          ...(concurrency ? { concurrency } : {}),
        }),
      });
      const body = await readJson(response);
      if (!response.ok || body?.ok === false) {
        return { ok: false, message: String(body?.message ?? `HTTP ${response.status}`) };
      }
      return { ok: true, batchId: String(body?.batchId ?? '') };
    },
    async status(batchId) {
      const response = await fetch(`${base}/status?project=${encodeURIComponent(id())}&batchId=${encodeURIComponent(batchId)}`);
      if (!response.ok) return null;
      const body = await readJson(response);
      return body?.batch ? { batch: body.batch } : null;
    },
    async retry(batchId) {
      const response = await fetch(`${base}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: id(), batchId }),
      });
      const body = await readJson(response);
      if (!response.ok || body?.ok === false) {
        return { ok: false, message: String(body?.message ?? `HTTP ${response.status}`) };
      }
      return { ok: true, batchId: String(body?.batchId ?? batchId), retried: Number(body?.retried ?? 0) };
    },
  };
}

/** 首屏：计划清单 + 最近批次。失败就当空列表，页面自己会说"还没有计划"。 */
export async function loadRenderState(project?: string) {
  const id = project ?? new URLSearchParams(location.search).get('project') ?? '';
  if (!id) return { entries: [], batches: [] };
  const response = await fetch(`${base}/state?project=${encodeURIComponent(id)}`);
  if (!response.ok) return { entries: [], batches: [] };
  const body = await readJson(response);
  return {
    entries: Array.isArray(body?.entries) ? body.entries : [],
    batches: Array.isArray(body?.batches) ? body.batches : [],
  };
}
