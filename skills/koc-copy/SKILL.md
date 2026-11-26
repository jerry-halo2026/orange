---
name: koc-copy
description: （已拆分）现在是 koc-writer（通用层）+ koc-tea（茶饮层）的组合壳。新用法请直接用那两层；这个入口保留是为兼容旧调用。
version: 0.2.0
---

# KOC 文案（组合壳）

这个技能已经拆成两层：

- **koc-writer**（通用层）：写法、体检、改写三式、锚点规则；
- **koc-tea**（茶饮层）：品类红线、场景库、案例。

`install.mjs --layer both` 会把两层一起装到 `~/.orangefilm/skills/`。
旧的 `check.mjs` 仍然可用（等价于 `koc-writer/check.mjs`）。
