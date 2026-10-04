# dsh-deep-reading

**Deep Reading** —— DSH（DeepSeek Harness）的深度阅读插件：Token 效率优先的读书流程。
导入拆章 → 单章精读（子代理）→ 带 `[n]` 定位的章节记忆 → 已读复用 → 逐字导出。

像读过书的人在讲：不是摘要，不是搬运目录，而是"我读完了，我来跟你聊这本书"。

有AI自己的观点：能说"这点我同意/这里我觉得作者有问题"，而不是只复述作者。

让用户真懂：重点是理解，不是信息量。

它把「读一本书」变成一件**可累积、可续读、可导出**的事：

- 读过的每一章都留下**带段落定位**的讲解记忆；换一个阅读目的，可以不重读原文直接复用；
- 读一半关掉，新会话说一声「继续」就原样接上；
- 读完全书，一键导出成逐字不差的 EPUB 或 Markdown。

**省 Token 的关键**：章节原文只在子代理里读、主会话只收短结果——一本书的正文永远不会灌进主对话，
读再厚的书，上下文也不会被撑爆。

## 读书功能

### 导入拆章：EPUB / Markdown / 纯文本 / PDF 都能进

- 支持五种来源：EPUB、单个 `.md`、目录（一个 `.md` 文件一章）、`.txt`、`.pdf`。
- `.txt` / `.pdf` 先转成 Markdown 再切章（`lib/convert.js`），**转换全文**留在 `books/<ID>/source.md`。
- 切章规则：Markdown 按 `# ` 一级标题切，标题之前的内容算「前言」，一个标题都没有就当整本一章；
  EPUB 按书自身的章节结构（spine）逐节收，EPUB 2 会自动升级后导入。
- 导入时给每章正文编好**段落号**（`[1] [2] [3] …`）——后面所有的「定位」都建在这个编号上。
- 源文件没变再导入会返回 `skipped:true`，不重做。
- 导入完只报书名和章数，不转述章节内容。

### 单章精读：原文只在子代理里读

- 你说「精读第 N 章」，主会话会派生一个**章节子代理**（`reading_chapter` 工具）。
- 子代理带着本章原文和阅读目的独自读完，返回一份「讲解 + 状态行」——
  讲解原样呈现给你，同时落盘为本章记忆。
- **原文不进主会话**：一本书读下来，主对话里只有短结果，上下文很轻。
- 超长章节自动分节（默认每节 12000 字节）：中间检查点标 `partial` + `covered "1-3/7"`，
  读完全章才转 `complete`；中途断了下次从断点续，不从头再来。

### 章节记忆：每条结论都能指回原文段落

- 记忆写进 `memory/NNN.md`，**每条主张必须带 `[n]` 段落定位**（工具强制校验，缺定位直接拒绝写入）。
- `complete` 的记忆**不可回改**：后来理解变了，就在后续章节的记忆里写「修正了第 N 章的某结论」——
  记忆只追加，像一份可以回放的阅读史。
- 记忆绑定**当时的原文哈希**：章节文件一旦变了（比如你手工修过 `source.md`），
  旧记忆自动判为「过期」，不会被悄悄用错。

### 已读复用：换个目的，也不用重读原文

- `dr_status` 给每章判 `reusable`：记忆 `complete` + 源哈希一致 + 记忆协议版本一致，三个都满足才算数。
- 遇到 `reusable` 的章，直接**基于记忆讲解**（开头注明「（基于已有记忆，未重读原文）」），
  不派子代理、不重读、也不打断你确认。
- 换视角也行：上次从制度角度读的，这次要「从人物角度再讲一遍第 2 章」——照样复用。

### 跨会话续读：读一半关掉，下次原样接上

- 新会话里说「继续读书」：`dr_status` 全书扫一遍，找到第一个还没读完的章（未读 / 读到一半 / 过期）接着读。
- 前文记忆由子代理按需读取，不用你复述读到哪了。

### 回查原文：段落 / 短语 / 关键词三种定位

`dr_read` 四种模式，全部**只读**、绝不写盘：

- `index`：列全书章节目录（含每章段数、记忆状态）；
- `range`：按段落区间读原文（带 `[n]` 锚点，超字节上限自动截断并给 `nextFrom`）；
- `locate`：按短语定位段落（附上下文窗口）；
- `find`：关键词检索全书或指定章。

问「作者那句话原话是怎么说的？」时用得上。

### 你的想法单独存：和 AI 解释分开放

四类信息严格分开，互不污染：

| 类别 | 存哪 | 规则 |
|---|---|---|
| 原文事实 | `chapters/` | 只由 `dr_import` 写 |
| AI 解释 | `memory/` `lecture/` | 每条带 `[n]` 定位 |
| 你的想法 | `user/NNN.md` | 只记你的原话，不加 AI 解读 |
| 你的理解状态 | `user/state.md` | 只记有证据的（引用你的原话） |

另外 `reader.md` 记你的阅读目的与偏好，精读每章前都会先看它。

### 导出：逐字拼接，AI 不重写一个字

- **Markdown 导出**：写一份 manifest（标题行 + `@include` 行），
  `@include <相对路径>` 会被替换为该文件的**逐字内容**，其余行原样保留——
  原文和记忆怎么编排进阅读笔记，你说了算。
- **EPUB3 导出**：`dr_export_epub` 把逐章讲解 `lecture/*.md` 拼成电子书，逐字收录，未读章节自然缺席。
- 两种导出都由脚本做拼接，模型不参与改写。

### 用量账本：每章花了多少 Token，看得见

- 每完成一步（导入 / 精读一章 / 续读 / 导出）记一笔到 `usage.jsonl`，子代理的 token 也会折进去。
- `dr_usage` 的 `report` 模式按章汇总：哪一章读得贵、合计花了多少，一目了然。

## 一次典型阅读

```
你：把《置身事内》.epub 导入，ID 用 zhi-shen-shi-nei
      → 拆成 N 章（只报书名 + 章数）
你：精读第 1 章
      → 子代理读完，返回带 [n] 定位的讲解（原文没进主会话）
你：继续
      → 从第 2 章接着读
你：以「地方政府」的视角再讲一遍第 1 章
      → 复用已有记忆，未重读原文
你：把讲解导出成 EPUB
      → 得到逐字收录的电子书
```

## 安装

```bash
dsh plugin --profile <profile> add <本目录路径>
```

桌面版（profile 名 `desktop`）装完后**必须重启 DSH 桌面应用**才会加载。

## 书库位置

默认 `$DSH_HOME/deep-reading/books`。想把书库放到别处、或多套安装共用同一批书、
同一份记忆与用量账本，就在 profile 的 `cordis.patch.yml` 里改：

```yaml
- id: dsh-deep-reading
  name: dsh-deep-reading
  config:
    booksRoot: 'D:/deep-reading/books'   # 改成你自己的书库路径
```

> 注意：这条是**整体替换** config，不是一个字段的合并。

## 工具速查

| 工具 | 作用 |
|---|---|
| `dr_import` | 导入 EPUB / `.md` / `.txt` / `.pdf` / 含 md 的目录，拆章 + 建索引；txt/pdf 先转成 Markdown，转换全文留 `source.md`；源未变则 `skipped:true` |
| `dr_read` | `mode`: `index` / `range`（带 `[n]` 锚点、按字节分节）/ `locate` / `find` |
| `dr_write` | 写 `memory` / `lecture` / `user-note` / `user-state` / `reader` / `export`（export 做 `@include` 逐字拼接） |
| `dr_status` | 每章状态与 `reusable` 判定（含源文件 hash 比对） |
| `dr_usage` | 用量账本记账 / 汇总（含子代理 token 折算） |
| `dr_export_epub` | 把 `lecture/*.md` 拼成 EPUB3（逐字收录，不重写一个字） |
| `reading_chapter` | 派生单章精读子代理；目标章 `reusable` 时直接短路，不 spawn |

## 技能

- `deep-reading`：入口流程（模型可调用）；用户说「读这本书 / 继续读书 / 精读第 N 章 / 导出阅读笔记」时进入
- `deep-reading-chapter`：章节子代理的说明书（模型/用户都不可调用，只作为子代理 persona，由 `reading_chapter` 注入）

## 源格式与转换（txt / pdf）

- `.txt`：BOM / UTF-8 / GB18030 / Big5 自动判定（按高频汉字打分；拿不准会在导入报告里写"不确定"）；
  "一行一段"还是"硬换行"由正文自己说话（看句末标点比例 + 空行密度）。
- `.pdf`：需要**文字层**。中文靠 pdfjs 的 CMap 表，`lib/convert.js` 里两处不能动：
  `cMapUrl` 必须传纯文件路径（Node 的 fetch 不支持 `file://`），
  并且要显式换用 `pdfjs-dist/legacy/build/pdf.mjs`（官方 Node 构建；unpdf 自带的 serverless 构建读不了 CMap 表）。
  缺任何一处，中文 PDF 会**静默抽出 0 个字**（看起来像扫描件）。
- 扫描件（图片版、没有文字层）会被**拒绝导入**并提示先 OCR；本版不做 OCR。
- 转换全文留在 `books/<ID>/source.md`（默认可见，切章时排除）。
  想手工修标题：改 `source.md` 给标题行加 `# `，再按 `.md` 导入。

## 数据目录 `books/<ID>/`

| 路径 | 内容 | 谁写 |
|---|---|---|
| `book.json` `index.md` `chapters/NNN.md` `.map.json` | 元数据与原文事实 | 只由 `dr_import` 写 |
| `source.md` | txt/pdf 导入时的转换全文（不参与切章） | 只由 `dr_import` 写 |
| `memory/NNN.md` | AI 解释（每条主张带 `[n]` 定位） | 章节子代理 |
| `lecture/NNN.md` | 逐章讲解正文（EPUB 的来源） | 章节子代理 |
| `user/NNN.md` `user/state.md` `reader.md` | 用户想法、理解状态、阅读目的 | 主会话 |
| `exports/` | 拼接 / EPUB 导出 | `dr_write` / `dr_export_epub` |
| `usage.jsonl` `.usage-agents.json` | 用量账本 | `dr_usage` / `reading_chapter` |

## 测试

```bash
npm run load-check   # 插件契约：81 项（context 桩、schema 结构、每个工具实跑、转换依赖）
npm test             # 行为门禁：114 条规则（幂等、截断衔接、记忆不可回改、导出越界、txt/pdf 转换…）
npm run host-check   # 用桌面应用自带的 cordis/ToolRuntime/SkillRegistry 真跑一遍：74 项
npm run check        # 三个一起跑（共 269 项）
```

`host-check` 需要本机装有 DSH 桌面版（只读，不改动应用）；非默认安装目录用
`DSH_APP_DIR` 指定。它会自动用应用自带的 Electron-as-Node 重新启动自己。

## 许可证

MIT © 2026 Madao
