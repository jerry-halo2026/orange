-- 030 静音素材的画面标签：抽三帧让视觉模型打标，标签并入检索文本。
--
-- # 为什么需要这一列
--
-- 67 156 条素材里，能从文件名认出镜头类型的只有 ~12%（包装 3 667 / 原料 2 053 / 展示 1 802 /
-- 人物 320 / 空镜 66），其余 59 248 条名字是"展示小青柑1""片段3"这一类。这些素材**没有声音**，
-- 转写拿不到任何东西 —— 能拿到的只有画面。
--
-- 所以抽三帧（10%/50%/90%）交视觉模型回答「主体/动作/景别/光线/场景/有无人」，结果落在这两列：
--   visual_tags  标签本体（jsonb，便于以后按字段过滤）
--   visual_ver   打标版本（算法或提示词一变就换它，增量任务据此判断哪些还没打过）
--
-- # 为什么单独两列而不是塞进现有 jsonb
--
-- 现有 `doc` 那一坨是抽取器的产物，重跑会整块覆盖；标签是另一条产线（视觉模型），
-- 单独放才能各自增量、各自回滚。向量文本由 `tagText()` 把两者拼起来。
--
-- # 回滚
--
--   alter table public.media_doc
--     drop column if exists visual_tags,
--     drop column if exists visual_ver;

alter table public.media_doc
  add column if not exists visual_tags jsonb,
  add column if not exists visual_ver text;

comment on column public.media_doc.visual_tags is
  '三帧合并后的画面标签：{subject, action, shotSize, light, scene, person}';
comment on column public.media_doc.visual_ver is
  '打标版本（如 frame-tag-1）；空 = 还没打过';

-- 增量任务按"没有标签"或"版本不对"挑待办：这个索引让那一步不用全表扫。
create index if not exists media_doc_visual_pending_idx
  on public.media_doc (media_key)
  where visual_ver is null;

-- 允许按"有没有人"过滤（挑人物镜头时最常用）
create index if not exists media_doc_visual_person_idx
  on public.media_doc ((visual_tags ->> 'person'))
  where visual_tags is not null;
