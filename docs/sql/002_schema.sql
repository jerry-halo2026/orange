-- 002 表结构：素材 + 知识库（source / summary / entity / edge / event）。
--
-- 约定：
--   * 全部表以 `company_key` 为第一列并进入主键 —— 多租户隔离的物理基础（配合 004 的 RLS）。
--   * `env_id` 区分同一公司下的环境（sandbox / production）；素材主键含 env_id，wiki 侧只按 (company_key, video_id)。
--   * 时间统一 timestamptz（UTC 存储）；`create_time` 是供应商侧创建时间，`updated_at` 是本地行更新时间。
--   * 哈希一律 64 位小写 hex（sha256），用于跨轮次判同（不许写前缀/大写）。
--   * 幂等：IF NOT EXISTS，可反复执行。
CREATE TABLE IF NOT EXISTS material (
  company_key    text        NOT NULL,
  env_id         text        NOT NULL,
  video_id       text        NOT NULL,
  video_type     smallint,
  name           text,
  size           bigint,
  duration_ms    bigint,
  category1_id   text,
  category2_id   text,
  labels         text[]      NOT NULL DEFAULT '{}',
  account_key    text,
  account_name   text,
  create_time    timestamptz,
  -- 供应商原样返回的 videoState 对象（id/name/weight/backgroundColor/frontColor/isDefault）
  provider_state jsonb,
  sha256         text,
  content_hash   text,
  analyzer_ver   text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_pk PRIMARY KEY (company_key, env_id, video_id),
  CONSTRAINT material_company_key_nonempty CHECK (length(company_key) > 0),
  CONSTRAINT material_video_id_nonempty CHECK (length(video_id) > 0),
  CONSTRAINT material_size_nonneg CHECK (size IS NULL OR size >= 0),
  CONSTRAINT material_duration_nonneg CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT material_sha256_hex CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT material_content_hash_hex CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT material_video_type_nonneg CHECK (video_type IS NULL OR video_type >= 0)
);

COMMENT ON TABLE material IS '供应商素材的本地投影；只存元数据，不存媒体字节。';
COMMENT ON COLUMN material.env_id IS '环境：sandbox / production 等；同一 video_id 在不同 env 是不同行。';
COMMENT ON COLUMN material.content_hash IS '内容指纹（去重/判同用），与 sha256 分列：sha256 是字节哈希，content_hash 是归一化后的内容哈希。';
COMMENT ON COLUMN material.analyzer_ver IS '最近一次成功分析该素材的分析器版本；未分析为 NULL。';

-- 分析源：一轮分析（模型版本 + 输入内容哈希）产出的 markdown 与证据。
CREATE TABLE IF NOT EXISTS wiki_source (
  company_key  text        NOT NULL,
  video_id     text        NOT NULL,
  analyzer_ver text        NOT NULL,
  content_hash text        NOT NULL,
  video_md     text,
  evidence     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_source_pk PRIMARY KEY (company_key, video_id, analyzer_ver),
  CONSTRAINT wiki_source_content_hash_hex CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wiki_source_analyzer_ver_nonempty CHECK (length(analyzer_ver) > 0)
);

COMMENT ON TABLE wiki_source IS '分析结果的原始记录；主键含 analyzer_ver，换模型版本不覆盖旧结果。';

-- 摘要：一条素材的结构化结论 + 向量。与 material 以 (company_key, video_id) 对齐。
CREATE TABLE IF NOT EXISTS wiki_summary (
  company_key     text        NOT NULL,
  video_id        text        NOT NULL,
  one_line        text,
  scenes          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  best_clip       jsonb,
  risks           text[]      NOT NULL DEFAULT '{}',
  production      text        CHECK (production IS NULL OR production IN ('live', 'ai', 'code', 'mixed')),
  confidence      numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status          text        NOT NULL DEFAULT 'candidate'
                    CHECK (status IN ('candidate', 'trusted', 'disputed')),
  embedding       vector(1024),
  embedding_model text,
  embedding_ver   text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_summary_pk PRIMARY KEY (company_key, video_id),
  -- 向量三件套要么都有，要么都没有：半个向量无法检索也无法解释来源。
  CONSTRAINT wiki_summary_embedding_complete CHECK (
    (embedding IS NULL AND embedding_model IS NULL AND embedding_ver IS NULL)
    OR (embedding IS NOT NULL AND embedding_model IS NOT NULL AND embedding_ver IS NOT NULL)
  )
);

COMMENT ON TABLE wiki_summary IS '素材的一句话结论/场景/最佳片段/风险；embedding 为 1024 维（与所选 embedding 模型对齐）。';
COMMENT ON COLUMN wiki_summary.status IS 'candidate=自动产出待审；trusted=人工确认；disputed=有争议。';

-- 知识实体：产品、人物、场景、风格、品牌、合集、钩子、卖点。
CREATE TABLE IF NOT EXISTS wiki_entity (
  company_key  text        NOT NULL,
  entity_id    text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('product', 'person', 'scene', 'style', 'brand', 'collection', 'hook', 'selling_point')),
  slug         text        NOT NULL,
  title        text,
  body_md      text,
  tags         text[]      NOT NULL DEFAULT '{}',
  sources      text[]      NOT NULL DEFAULT '{}',
  confidence   numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disputed', 'retired')),
  last_updated timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_entity_pk PRIMARY KEY (company_key, entity_id),
  CONSTRAINT wiki_entity_slug_nonempty CHECK (length(slug) > 0),
  CONSTRAINT wiki_entity_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

COMMENT ON TABLE wiki_entity IS '知识库实体；(company_key,kind,slug) 唯一（见 003），slug 是小写连字符。';

-- 实体关系。
CREATE TABLE IF NOT EXISTS wiki_edge (
  company_key   text        NOT NULL,
  edge_id       text        NOT NULL,
  src_entity_id text        NOT NULL,
  dst_entity_id text        NOT NULL,
  kind          text        NOT NULL,
  weight        real        CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1)),
  evidence      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_edge_pk PRIMARY KEY (company_key, edge_id),
  CONSTRAINT wiki_edge_kind_nonempty CHECK (length(kind) > 0),
  CONSTRAINT wiki_edge_no_self CHECK (src_entity_id <> dst_entity_id),
  CONSTRAINT wiki_edge_src_fk FOREIGN KEY (company_key, src_entity_id)
    REFERENCES wiki_entity (company_key, entity_id) ON DELETE CASCADE,
  CONSTRAINT wiki_edge_dst_fk FOREIGN KEY (company_key, dst_entity_id)
    REFERENCES wiki_entity (company_key, entity_id) ON DELETE CASCADE
);

COMMENT ON TABLE wiki_edge IS '实体关系；两端外键带 company_key，跨租户引用在物理上不可能。';

-- 事件流（可观测/审计：分析完成、人工修订、状态流转等）。
CREATE TABLE IF NOT EXISTS wiki_event (
  company_key text        NOT NULL,
  event_id    text        NOT NULL,
  video_id    text,
  kind        text        NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_event_pk PRIMARY KEY (company_key, event_id),
  CONSTRAINT wiki_event_kind_nonempty CHECK (length(kind) > 0)
);

COMMENT ON TABLE wiki_event IS '追加型事件流；只插入不更新，用于回放与对账。';
