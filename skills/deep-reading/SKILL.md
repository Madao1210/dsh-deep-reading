---
name: deep-reading
description: 深度阅读一本书（Token 效率优先）：导入拆章、指定章节精读讲解、保存章节记忆、跨会话续读、导出阅读成果。当用户说“读这本书 / 继续读书 / 精读第N章 / 导出阅读笔记”时使用。
---

# Deep Reading（入口技能）

Token 效率优先的读书流程。**章节原文只在章节子任务里读**，主会话只收短结果。

工具（本插件自带的 `dr_*` 工具，直接调用，不要用 shell）：

| 工具 | 用途 |
|---|---|
| `dr_import` | 导入拆章 |
| `dr_read` | 只读：index / range / locate / find |
| `dr_write` | 写入检查点（memory / lecture / user-note / user-state / reader / export） |
| `dr_status` | 逐章记忆状态（reusable / partial / 过期 / 未读） |
| `reading_chapter` | 启动章节子任务精读一章（原文不进本会话） |
| `dr_export_epub` | 把讲解拼成 EPUB |
| `dr_usage` | 用量记账 |

书库根目录由插件配置 `booksRoot` 决定（默认 `~/.dsh/deep-reading/books`）。

## 数据目录 `books/<ID>/`

| 路径 | 内容 | 谁写 |
|---|---|---|
| `book.json` `index.md` `chapters/NNN.md` `chapters/NNN.map.json` | 书籍元数据与原文事实 | 只由 `dr_import` 写 |
| `memory/NNN.md` | AI 解释（带 [n] 定位） | 章节子任务 |
| `lecture/NNN.md` | 本章讲解正文（给人读） | 章节子任务 |
| `user/NNN.md` | 用户想法（只记用户原话） | 本技能 |
| `user/state.md` | 用户理解状态（只记有证据的） | 本技能 |
| `reader.md` | 阅读目的与偏好 | 本技能 |
| `exports/` | 脚本拼接的导出 | 本技能 |
| `usage.jsonl` | 用量账本 | `dr_usage` |

## 流程

### 1) 导入
```
dr_import { src: "<EPUB / .md / .txt / .pdf / 含 md 的目录>", book: "<ID>", title: "书名（可选）" }
```
- `<ID>`：简短英文/拼音（字母数字 `-_`），如 `du-kou-de-deng`
- 向用户只报结果里的 id / title / chapterCount（不要转述章节内容）
- 源未变时返回 `skipped:true`（不重做）
- 完成后记账：`dr_usage { book: "<ID>", task: "split" }`

### 2) 精读一章（核心）
- 先读 `reader.md` 拿阅读目的；不存在就先问用户一句目的，用 `dr_write { kind: "reader" }` 写入
- 先判定本章状态：`dr_status { book: "<ID>", chapter: <N> }`
- 已读复用：目标章为 `reusable` 时，主会话直接基于记忆讲解（按本次目的组织，不要求与立项目的一致），开头注明“（基于已有记忆，未重读原文）”，不启动子任务、不重读、不暂停确认。
- 其余情况调用章节子任务：
  `reading_chapter { book: "<ID>", chapter: <N>, purpose: "<一句话>" }`（超长章可加 `sectionBytes: <N>`，默认 12000）
  - 该工具会自己检查 reusable / partial 并接管全部读取与落盘，参数必须自包含
- 子任务返回「讲解＋状态行」后：**原样呈现给用户，不得重写或缩写**（这是省 token 的关键）
- 记账：`dr_usage { book: "<ID>", task: "read-ch<N>" }`

### 3) 续读（新会话）
- `dr_status { book: "<ID>" }`：找第一个 `reusable:false` 的章节（未读 / partial / 过期）
- 按“精读一章”继续；前文记忆由子任务自己按需读取 `memory/<已读章>.md`
- 记账标签用 `read-ch<N>-resume`

### 4) 导出（脚本拼接，不重写一个字）
- 用 Write 工具写一个 manifest（只有标题行和 @include 行）：
```
# 《书名》阅读导出

## 第 1 章 · 原文与记忆

@include chapters/001.md
@include memory/001.md
```
- `dr_write { book: "<ID>", kind: "export", name: "reading.md", content: "<manifest 文本>" }`
- `@include <相对路径>` 行会被替换为该文件的**逐字内容**；其余行原样保留
- 讲解类 EPUB：`dr_export_epub { book: "<ID>" }`（收录 `lecture/*.md`，逐字，未读章节自然缺席）
- 记账：`task: "export"`

### 5) 用户想法 / 理解状态（只在有真实输入时写）
- 用户粘贴的想法、批注 → `dr_write { kind: "user-note", chapter: <N>, content: "<用户原话>" }`（只放用户原话，不加 AI 解读）
- 用户明确展示了理解或答对/答错问题 → `kind: "user-state"`（只记有证据的，引用用户原话）
- 用户就已读章节提问：先读 `memory/<NNN>.md` 回答；涉及精确用词/论据时再用 `dr_read` 回查原文

## 硬规则（违反即错误）

1. `memory/NNN.md` 每条主张必须附段落定位（`[n]` 或 locate 短语）；定位缺失时**优先补定位，不得靠压缩内容省事**（工具会拒绝无定位的记忆）。
2. 四类信息分开存、不混写：原文事实（`chapters/`）｜AI 解释（`memory/`）｜用户想法（`user/NNN.md`）｜用户理解状态（`user/state.md`）。
3. P1 阶段省略“主题词、实体词、跨章候选依赖”字段，不预生成。
4. 长章分节续读：中间检查点必须 `state: "partial"` + `covered: "a-b/total"`，读完全章才 `state: "complete"`；covered 从 1 起、只增不减（工具会校验）。
5. `dr_read` 的 `find` 只作查询辅助，保持只读，不参与记忆生成流程。
6. 导出只允许 manifest 脚本拼接，不让模型重写任何内容。
7. 章节原文不进入主会话：读原文只发生在 `reading_chapter` 子任务内部。

## 工具速查

```
dr_import  { src: <epub|md|dir>, book: "<ID>", title?: "书名", force? }
dr_read    { book: "<ID>", mode: "index" }
dr_read    { book: "<ID>", mode: "range", chapter: <N>, from?, to?, maxBytes? }
dr_read    { book: "<ID>", mode: "locate", chapter: <N>, phrase: "短语", context? }
dr_read    { book: "<ID>", mode: "find", keyword: "关键词", chapter?, limit? }
dr_status  { book: "<ID>", chapter? }
reading_chapter { book: "<ID>", chapter: <N>, purpose?: "一句话", sectionBytes? }
dr_write   { book: "<ID>", kind: "memory", chapter: <N>, state: "complete", content: "<记忆正文>" }
dr_write   { book: "<ID>", kind: "export", name: "reading.md", content: "<manifest>" }
dr_export_epub { book: "<ID>", out?, title?, author? }
dr_usage   { book: "<ID>", task: "split" }
```

## P1 边界（不做）

跨章分析、主题词/实体词/glossary、伴读模式、批注可视化、PDF、插件封装。路线图 P2–P4 的内容一律不做。

## 版本记录

- v0.2（2026-09-23）：已读复用规则加入——目标章 `reusable` 时由主会话直接基于记忆讲解（不启动子任务、不重读、不暂停确认）；v0.1 及以前无此规则。
- 2026-10-03：章节精读由 `reading_chapter` 工具完成；书库位置由插件配置 `booksRoot` 决定。
