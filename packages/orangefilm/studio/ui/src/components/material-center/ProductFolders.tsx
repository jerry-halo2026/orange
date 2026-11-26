// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 产品文件夹视图：一级分类文件夹 → 产品文件夹 → 标签文件夹 → 素材墙。每一级都是 FolderCover 的 2×2 拼贴，
 * 素材墙复用页面的 `renderEntries`，所以拖动、下载、详情与素材库完全一致。
 */
import React from 'react';
import type { MaterialCopy } from '@/lib/material-center/copy';
import type { IndexProduct, MaterialIndexTree, IndexMaterialEntry } from '@/lib/material-center/index-tree';
import type { LibraryEntry } from '@/lib/material-center/library';
import { FolderCover } from './FolderCover.tsx';
import { ProductMaterials } from './ProductMaterials.tsx';
import { cachedCovers, loadCovers } from '@/lib/material-center/product-covers';
import type { MaterialList } from '@/lib/material-center/product-materials';

export type ProductFoldersProps = {
  readonly copy: MaterialCopy;
  readonly tree: MaterialIndexTree;
  readonly renderEntries: (entries: readonly LibraryEntry[]) => React.ReactNode;
  readonly list: MaterialList;
};

type Level = { kind: 'root' } | { kind: 'oneLevel'; name: string } | { kind: 'product'; product: IndexProduct } | { kind: 'label'; product: IndexProduct; label: string };

function FolderCard({ list, folderKey, title, count, videoIds, entries, note, onOpen }: {
  list: MaterialList; folderKey: string; title: string; count: number; videoIds: readonly string[]; entries?: readonly IndexMaterialEntry[]; note?: string; onOpen: () => void;
}) {
  const key = `${folderKey}:${videoIds.slice(0, 4).join(',')}`;
  const [urls, setUrls] = React.useState<readonly string[]>(() => cachedCovers(key) ?? []);
  const asked = React.useRef(false);
  const holder = React.useRef<HTMLButtonElement | null>(null);
  /* `videoIds`/`entries`/`list` are new identities on every parent render; keyed on the folder only, so the observer
     below is mounted once per card instead of being torn down and rebuilt on every render. */
  const latest = React.useRef({ list, entries, videoIds });
  latest.current = { list, entries, videoIds };
  const reveal = React.useCallback(() => {
    if (asked.current) return;
    asked.current = true;
    const now = latest.current;
    void loadCovers(now.list, key, now.videoIds, now.entries).then(next => setUrls(next));
  }, [key]);
  /* 只有进入视口的文件夹才取封面：73 个文件夹同时挂载时不会一次打 73 个请求。 */
  React.useEffect(() => {
    const node = holder.current;
    if (!node) return undefined;
    if (typeof IntersectionObserver === 'undefined') { reveal(); return undefined; }
    const observer = new IntersectionObserver((rows) => { if (rows.some(row => row.isIntersecting)) { reveal(); observer.disconnect(); } }, { rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reveal]);
  return <button ref={holder} type="button" data-product-folder={folderKey} onClick={onOpen}
    className="flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] p-1.5 text-left hover:border-[var(--accent)]">
    <FolderCover urls={urls} count={count} onReveal={reveal} />
    <span className="truncate px-0.5 text-[12px] font-medium" title={title}>{title}</span>
    {note && <span className="truncate px-0.5 text-[10.5px] text-[var(--text-muted)]">{note}</span>}
  </button>;
}

/* The folder the person was in, kept across a remount of this view: leaving the material centre for the canvas and
   coming back to the top folder lost the drill-down every time (2026-11-26). A product that no longer exists in the
   tree sends it back to the root, so the memory cannot outlive what it names. */
let remembered: Level = { kind: 'root' };

export function ProductFolders({ copy, tree, renderEntries, list }: ProductFoldersProps) {
  const [level, setLevelState] = React.useState<Level>(() => remembered);
  const setLevel = React.useCallback((next: Level) => { remembered = next; setLevelState(next); }, []);
  const products = React.useMemo(() => [...(tree.products ?? [])].sort((a, b) => {
    const dateA = a.dates[0]?.date ?? '';
    const dateB = b.dates[0]?.date ?? '';
    return dateB.localeCompare(dateA) || b.count - a.count;
  }), [tree.products]);
  const oneLevels = React.useMemo(() => [...new Set(products.map(product => product.oneLevel || '未分类'))], [products]);

  /* a remembered drill-down into a product that is no longer in the tree would show an empty wall */
  React.useEffect(() => {
    const at = level;
    if (at.kind === 'root' || at.kind === 'oneLevel') return;
    if (!products.some((p) => p.id === at.product.id)) setLevel({ kind: 'root' });
  }, [products, level, setLevel]);

  const crumbs = <nav data-product-crumb="" className="flex flex-wrap items-center gap-1 text-[11px] text-[var(--text-muted)]">
    <button type="button" onClick={() => setLevel({ kind: 'root' })} title="全部产品" aria-label="全部产品"
      className="rounded px-1 hover:bg-[var(--bg-hover)]">{level.kind === 'root' ? '产品' : '⌂ 产品'}</button>
    {level.kind !== 'root' && level.kind !== 'oneLevel' && <>
      <span aria-hidden>/</span>
      <button type="button" onClick={() => setLevel({ kind: 'oneLevel', name: level.product.oneLevel || '未分类' })} className="rounded px-1 hover:bg-[var(--bg-hover)]">{level.product.oneLevel || '未分类'}</button>
    </>}
    {level.kind === 'product' && <><span aria-hidden>/</span><span className="px-1 text-[var(--text)]">{level.product.name}</span></>}
    {level.kind === 'label' && <>
      <span aria-hidden>/</span>
      <button type="button" onClick={() => setLevel({ kind: 'product', product: level.product })} className="rounded px-1 hover:bg-[var(--bg-hover)]">{level.product.name}</button>
      <span aria-hidden>/</span><span className="px-1 text-[var(--text)]">{level.label}</span>
    </>}
  </nav>;

  const wall = (cards: React.ReactNode) => <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>{cards}</div>;

  if (!products.length) return <section data-product-folders="" className="flex flex-col gap-2"><p className="text-[12px] text-[var(--text-muted)]">{copy.groupEmpty}</p></section>;

  if (level.kind === 'label') {
    const label = level.label ? level.product.labels.find(row => row.name === level.label) : null;
    const videoIds = level.label ? (label?.videoIds ?? []) : level.product.videoIds;
    return <section data-product-folders="" data-level="label" className="flex flex-col gap-2">
      {crumbs}
      <ProductMaterials copy={copy} videoIds={videoIds} entries={level.label ? (label?.entries ?? []) : level.product.entries} renderEntries={renderEntries} list={list} />
    </section>;
  }

  if (level.kind === 'product') {
    const product = level.product;
    const all: IndexProduct = product;
    return <section data-product-folders="" data-level="product" className="flex flex-col gap-2">
      {crumbs}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
        <span>{product.count} 条</span>
        {product.dates[0]?.date && <span>最近 {product.dates[0].date} · {product.dates.length} 期</span>}
      </div>
      {wall(<>
        <FolderCard list={list} folderKey={`all:${product.id}`} title={copy.subNavProductsAll} count={all.count} videoIds={all.videoIds} entries={all.entries}
          note={`${all.labels.length} 个标签`} onOpen={() => setLevel({ kind: 'label', product, label: '' })} />
        {product.labels.map(label => <FolderCard list={list} key={label.name} folderKey={`label:${product.id}:${label.name}`} title={label.name} count={label.count} entries={label.entries}
          videoIds={label.videoIds} onOpen={() => setLevel({ kind: 'label', product, label: label.name })} />)}
      </>)}
    </section>;
  }

  if (level.kind === 'oneLevel') {
    const rows = products.filter(product => (product.oneLevel || '未分类') === level.name);
    return <section data-product-folders="" data-level="oneLevel" className="flex flex-col gap-2">
      {crumbs}
      {wall(rows.map(product => <FolderCard list={list} key={product.id} folderKey={product.id} title={product.name} count={product.count} entries={product.entries}
        videoIds={product.videoIds} note={product.dates[0]?.date ? `最近 ${product.dates[0].date} · ${product.dates.length} 期` : '未标日期'}
        onOpen={() => setLevel({ kind: 'product', product })} />))}
    </section>;
  }

  return <section data-product-folders="" data-level="root" className="flex flex-col gap-2">
    {crumbs}
    <details open className="flex flex-col gap-1">
      <summary className="cursor-pointer px-1 text-[12px] font-semibold text-[var(--text-muted)]">产品</summary>
      {wall(oneLevels.map(name => {
        const rows = products.filter(product => (product.oneLevel || '未分类') === name);
        return <FolderCard list={list} key={name} folderKey={`one:${name}`} title={name} count={rows.reduce((sum, row) => sum + row.count, 0)} entries={rows.flatMap(row => row.entries ?? [])}
          videoIds={rows.flatMap(row => row.videoIds.slice(0, 4))} note={`${rows.length} 个产品`} onOpen={() => setLevel({ kind: 'oneLevel', name })} />;
      }))}
    </details>
  </section>;
}
