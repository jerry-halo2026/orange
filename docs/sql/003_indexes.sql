-- 003 索引：列表/检索/向量/名称模糊 + 唯一约束。
-- 幂等：IF NOT EXISTS。

-- 素材列表：按公司 + 创建时间倒序（最常见的翻页顺序）。
-- NULLS LAST：create_time 可能为空（供应商没给），空的排最后，避免首页全是空行。
CREATE INDEX IF NOT EXISTS material_company_created_idx
  ON material (company_key, create_time DESC NULLS LAST);

-- 名称模糊检索（ILIKE '%…%'）：pg_trgm 的 GIN，配合 001 的 pg_trgm 扩展。
CREATE INDEX IF NOT EXISTS material_name_trgm_idx
  ON material USING gin (name gin_trgm_ops);

-- 标签筛选（text[] 包含判断）。
CREATE INDEX IF NOT EXISTS material_labels_gin_idx
  ON material USING gin (labels);

-- 知识实体：(company_key, kind, slug) 唯一。
CREATE UNIQUE INDEX IF NOT EXISTS wiki_entity_kind_slug_uidx
  ON wiki_entity (company_key, kind, slug);

-- 实体按种类/状态浏览。
CREATE INDEX IF NOT EXISTS wiki_entity_kind_status_idx
  ON wiki_entity (company_key, kind, status, last_updated DESC);

-- 向量检索：余弦距离的 HNSW。
-- m / ef_construction 用默认量级（16 / 64）；数据量上来后再按 recall 与内存实测调整。
CREATE INDEX IF NOT EXISTS wiki_summary_embedding_hnsw_idx
  ON wiki_summary USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 关系两端各一条，便于图遍历（外键不自动建反向索引）。
CREATE INDEX IF NOT EXISTS wiki_edge_src_idx ON wiki_edge (company_key, src_entity_id, kind);
CREATE INDEX IF NOT EXISTS wiki_edge_dst_idx ON wiki_edge (company_key, dst_entity_id, kind);

-- 事件流按素材时间线查询。
CREATE INDEX IF NOT EXISTS wiki_event_video_idx ON wiki_event (company_key, video_id, at DESC);

-- 分析源按内容哈希找（同一内容换模型版本重新分析时复用）。
CREATE INDEX IF NOT EXISTS wiki_source_hash_idx ON wiki_source (company_key, content_hash);
