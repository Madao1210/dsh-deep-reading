/**
 * 源转换：`.txt` / `.pdf` → Markdown，交给章节切分器之前的最后一步。
 *
 * EPUB 不在这里——collect.js 里的 EPUB 路径本来就以 Markdown 形式取正文。
 * 转换分两段：编码/版面清洗（把源变成"一行一段/硬换行"的朴素文本），
 * 再升级章节标题（正则 + PDF 字号两条命中的判据），最后交回 collect.js。
 *
 * 关键实测（2026-10-04，用本机真实中文 PDF 验证）：
 * - Node 的 fetch 不支持 file://，pdfjs 自带的 CMap 表加载会失败，
 *   所以 cMapUrl 必须传**纯文件路径**（不是 file:// URL），并关掉 useWorkerFetch；
 * - 且要显式改用 pdfjs-dist 官方 Node 构建（legacy/build/pdf.mjs）：
 *   它的 node_utils_fetchData 用 fs.readFile 读表，unpdf 自带的 serverless 构建不能。
 *   两者缺一：中文 PDF 会静默抽出 0 个字（曾被误判为"扫描件"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fail } from './util.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- 文本编码

/** 高频汉字（含简繁），用来判断哪种中文编码解得"像人话"。 */
const COMMON_HANZI = new Set(
  '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农找装广显吧阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读啊超免压银买皇养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托央户烈洋哥索胡款靠评版宝座释景顾弟登货互付伯慢欧换闻危忙核暗姐介坏讨丽良序升监临亮露永呼味野架域沙掉括舰鱼杂误湾吉减编楚肯测败屋跑梦散温困剑渐封救贵枪缺楼县尚毫移娘朋画班智亦耳恩短掌恐遗固席松秘谢鲁遇康虑幸均销钟诗藏赶剧票损忽巨炮旧端探湖录叶春乡附吸予礼港雨呀板庭妇归睛饭额含顺输摇招婚脱补谓督毒油疗旅泽材灭逐莫笔亡鲜词圣择寻厂睡博勒烟授诺伦岸奥唐卖俄炸载洛健堂旁宫喝借君禁阴园谋宋避抓荣姑孙逃牙束跳顶玉镇雪午练迫爷篇肉嘴馆遍凡础洞卷坦牛宁纸诸训私庄祖丝翻暴森塔默握戏隐熟骨访弱蒙歌店鬼软典欲萨伙遭盘爸扩盖弄雄稳忘亿刺拥徒姆杨齐赛趣曲刀床迎冰虚玩析窗醒妻透购替塞努休虎扬途侵刑绿兄迅套贸毕唯谷轮库迹尤竞街促延震弃甲伟麻川申缓潜闪售灯针哲络抵朱埃抱鼓植纯夏忍页杰筑折郑贝尊吴秀混臣雅振染盛怒舞圆搞狂措姓残秋培迷诚宽宇猛摆梅毁伸摩盟末乃悲拍丁赵硬麦蒋操耶阻订彩抽赞魔纷沿喊违妹浪碰',
);

/** 命中高频字越多越(+)，替换符/私用区越多越(−)。 */
function scoreHanzi(text) {
  const sample = text.length > 40000 ? text.slice(0, 40000) : text;
  let common = 0;
  let bad = 0;
  let n = 0;
  for (const ch of sample) {
    n += 1;
    const c = ch.codePointAt(0);
    if (c === 0xfffd || c === 0) bad += 1;
    else if (c >= 0xe000 && c <= 0xf8ff) bad += 1;
    else if (c >= 0x4e00 && c <= 0x9fff && COMMON_HANZI.has(ch)) common += 1;
  }
  return n === 0 ? 0 : (common - bad * 3) / n;
}

/**
 * BOM → UTF-8 严格校验 → GB18030 / Big5 拼分数。
 * 两种中文编码都能把对方的字节解成"看起来正常的汉字"（没有替换符），
 * 所以判据是高频字的比例，而不是有没有报错。
 */
export function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch { /* 不是 UTF-8，继续试中文编码 */ }
  const cands = [];
  for (const enc of ['gb18030', 'big5']) {
    try {
      const t = new TextDecoder(enc).decode(buf);
      cands.push({ enc, t, score: scoreHanzi(t) });
    } catch { /* 平台没有这个解码器 */ }
  }
  if (cands.length === 0) fail('无法识别 txt 的编码（UTF-8 / GB18030 / Big5 都试过了）');
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  const runnerUp = cands[1];
  const uncertain = best.score <= 0.01 || (runnerUp && best.score - runnerUp.score < 0.01);
  return { text: best.t, encoding: best.enc, uncertain };
}

// ---------------------------------------------------------------- 标题判据

/** 章节标题的样子：第X章/卷、序/楔子/后记、Chapter N、Part N、Prologue… */
const CHAPTER_RE = /^(?:第\s*[0-9０-９零〇一二三四五六七八九十百千两]{1,12}\s*[章节回卷篇部话]|序[章言]?|楔子|引子|引言|前言|后记|尾声|终章|自序|代序|附录\s*[A-Za-z0-9一二三四五六七八九十]{0,4}|番外\s*[0-9一二三四五六七八九十]{0,4}|(?:上|中|下)(?:部|篇|卷)|卷\s*[0-9一二三四五六七八九十]{1,3}|Chapter\s+[0-9IVXLCDM]+|Part\s+[0-9IVXLCDM]+|Prologue|Epilogue|Preface|Foreword|Introduction|Appendix(?:\s+[A-Z0-9]{1,3})?)/i;

/** 标题后面接这些字，多半是正文（"第一章的内容是…"），不是标题。 */
const CONTINUATION_RE = /^[的是中里上下与和把被在有了着就都而说写着讲关于内当本主个这那我你他她它们些次天年日月部分]/;

/** 一句话的结尾标点；标题不该以它收尾。 */
const SENTENCE_END_RE = /[。！？!?；;，,、]$/;

export function isHeadingLine(raw) {
  const t = String(raw).trim();
  if (t === '' || t.length > 60) return false;
  if (t.startsWith('#') || SENTENCE_END_RE.test(t)) return false;
  const m = t.match(CHAPTER_RE);
  if (!m) return false;
  const rest = t.slice(m[0].length);
  if (rest === '') return true;
  if (/^[\s：:、.．·—\-–]/.test(rest)) return true;
  return !CONTINUATION_RE.test(rest);
}

// ---------------------------------------------------------------- 行 → 段落

const CJK = /[⺀-鿿豈-﫿＀-￯]/;

/** 该行是不是"该另起一段"的收尾（句末标点，或落单的右引号/右括号）。 */
const PARA_END_RE = /(?:[。！？…!?；;：:.]["'”’』」》）)]?|["'”’』」》）)])$/;

/** 一行文字正正经经收尾的样子（用来判断这是不是硬换行的断行处）。 */
const TERMINAL_RE = /[。！？…!?；;：:.]["'”’』」》）)]?$/;

function joinTwo(a, b) {
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b; // 英文断词连回来
  const last = a.slice(-1);
  const first = b.slice(0, 1);
  if (CJK.test(last) || CJK.test(first)) return a + b;
  return `${a} ${b}`;
}

/**
 * 视觉行 → 段落。PDF 每一行都是硬断行；中文 txt 常见"一行一段、无空行"。
 * 两条判据：上一行以句末标点收尾 → 断段；下一行以全角空格/制表缩进 → 断段。
 * 标题行永远独立成段。
 */
export function joinWrappedLines(lines, opts = {}) {
  const isHeading = opts.isHeading ?? isHeadingLine;
  const paras = [];
  let cur = '';
  let prev = '';
  const flush = () => { if (cur !== '') { paras.push(cur); cur = ''; prev = ''; } };
  for (const raw of lines) {
    const line = String(raw).trim();
    if (line === '') { flush(); continue; }
    // 落单的右引号/右括号（PDF 常把它挤到单独一行）贴回上一段，不另起一段。
    if (cur !== '' && /^["'”’』」》）)\]]+$/.test(line)) { cur += line; prev = line; continue; }
    if (isHeading(line)) { flush(); paras.push(line); continue; }
    if (cur === '') { cur = line; prev = line; continue; }
    if (PARA_END_RE.test(prev) || /^[　\t]/.test(raw)) { flush(); cur = line; prev = line; continue; }
    cur = joinTwo(cur, line);
    prev = line;
  }
  flush();
  return paras;
}

/** 标题的完整指纹（去掉全部空白、小写）。 */
const keyFull = (t) => t.replace(/\s+/g, '').toLowerCase();

/** 再剥掉"点线 + 页码"尾巴的指纹——目录行"第一章 起点……3"要和正文标题认成同一个。 */
const keyNoTail = (t) => t
  .replace(/[\s.．·•…\-–—]{1,}\d{1,4}\s*$/, '')
  .replace(/[\s.．·•…\-–—]+$/, '')
  .replace(/\s+/g, '')
  .toLowerCase();

/** 段落级文本 → Markdown：把章节标题行升级成 `# `，同名标题只留最后一次（目录页）。 */
export function markHeadings(paras) {
  const pieces = [];
  for (const p of paras) {
    const lines = p.split('\n');
    const first = lines[0].trim();
    if (lines.length === 1) {
      pieces.push({ heading: isHeadingLine(first), text: first });
      continue;
    }
    if (isHeadingLine(first)) {
      pieces.push({ heading: true, text: first });
      const rest = lines.slice(1).join('\n').trim();
      if (rest !== '') pieces.push({ heading: false, text: rest });
    } else {
      pieces.push({ heading: false, text: p });
    }
  }
  // 目录页会把同一批标题在正文之前再列一遍：若某行去掉页码尾巴后，正好等于
  // 后面某个标题的完整指纹，这行就是目录行，降级成普通文字（保留靠后的正文标题）。
  // 不能只比较"去尾巴后的指纹"：'Chapter 1' 和 'Chapter 2' 都会退化成 'chapter'，
  // 那样每章就只剩最后一个标题了（2026-10-04 手搓 PDF 实测踩到）。
  const seenLater = new Set();
  const out = new Array(pieces.length);
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    if (p.heading && seenLater.has(keyNoTail(p.text))) {
      out[i] = { heading: false, text: p.text };
    } else {
      out[i] = p;
      if (p.heading) seenLater.add(keyFull(p.text));
    }
  }
  const headings = out.filter((p) => p.heading).length;
  const markdown = out.map((p) => (p.heading ? `# ${p.text}` : p.text)).join('\n\n');
  return { markdown, headings, paragraphs: out.length };
}

// ---------------------------------------------------------------- txt

/** 纯文本 → Markdown。先判断它是"硬换行"还是"一行一段"，再决定要不要合并视觉行。 */
export function textToMarkdown(text) {
  const norm = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/^﻿/, '');
  const lines = norm.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) fail('txt 里没有正文（全是空白）');
  // 多数行都不以句末标点收尾 → 是硬换行的视觉行，必须合并；
  // 否则看空行密度：空行够密说明段落结构已经写好了，尊重原样。
  const fragments = nonEmpty.filter((l) => !TERMINAL_RE.test(l.trim())).length;
  const fragRatio = fragments / nonEmpty.length;
  const blanks = lines.length - nonEmpty.length;
  const mode = fragRatio < 0.5 && blanks / nonEmpty.length >= 0.15 ? 'blank-lines' : 'joined';
  const paras = mode === 'blank-lines'
    ? norm.split(/\n[ \t]*\n+/).map((b) => b.trim()).filter(Boolean)
    : joinWrappedLines(lines);
  const marked = markHeadings(paras);
  return { ...marked, mode, fragRatio };
}

// ---------------------------------------------------------------- pdf

const MAX_PDF_BYTES = 256 * 1024 * 1024;

const PAGE_NUMBER_RE = /^[\s·•‧∙・.，,、\-–—|｜()（）[\]【】]*\d{1,4}[\s·•‧∙・.，,、\-–—|｜()（）[\]【】]*$/;

let unpdfReady = null;

/** 懒加载 unpdf，并把它的 PDF.js 换成官方 Node 构建（唯一能读 CMap 表的那个）。 */
async function loadUnpdf() {
  if (!unpdfReady) {
    unpdfReady = (async () => {
      const unpdf = await import('unpdf');
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      await unpdf.definePDFJSModule(() => Promise.resolve(pdfjs));
      return unpdf;
    })().catch((e) => {
      unpdfReady = null;
      fail(`PDF 支持没有装好（unpdf / pdfjs-dist）: ${e.message}`,
        '在插件目录跑 npm install 后重试');
    });
  }
  return unpdfReady;
}

/** pdfjs-dist 的数据目录（cmaps / standard_fonts），纯路径——file:// 在 Node 里读不了。 */
function pdfjsDataDir(name) {
  try {
    const pkg = require.resolve('pdfjs-dist/package.json');
    const dir = path.join(path.dirname(pkg), name);
    if (!fs.existsSync(dir)) fail(`pdfjs-dist 里缺少 ${name} 目录（装坏了？）`, '在插件目录重新 npm install');
    return dir.replace(/\\/g, '/') + '/';
  } catch (e) {
    if (e && e.name === 'DrError') throw e;
    fail('找不到 pdfjs-dist（PDF 的中文字符表就在它里面）', '在插件目录跑 npm install');
  }
}

/** 一页的结构化文本项 → 视觉行 {text, size}。hasEOL 为主，y 跳变为辅。 */
function itemsToLines(items) {
  const lines = [];
  let cur = '';
  let size = 0;
  let y = null;
  const flush = () => {
    if (cur.trim() !== '') lines.push({ text: cur.replace(/[ \t]+$/, ''), size });
    cur = '';
    size = 0;
    y = null;
  };
  for (const it of items) {
    if (cur !== '' && y !== null && typeof it.y === 'number' && Math.abs(it.y - y) > Math.max(2, (it.fontSize || 10) * 0.6)) flush();
    cur += it.str;
    size = Math.max(size, Math.round(it.fontSize || 0));
    if (y === null && typeof it.y === 'number') y = it.y;
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}

/** 页眉/页脚：同一行文字（数字抹平）出现在足够比例的页面上。 */
function findRepeatedLines(pagesLines, totalPages) {
  if (totalPages < 4) return new Set();
  const counts = new Map();
  for (const lines of pagesLines) {
    const seen = new Set();
    const edge = [...lines.slice(0, 3), ...lines.slice(-3)];
    for (const l of edge) {
      const norm = l.text.replace(/\d+/g, '#').trim();
      if (norm === '' || norm.length > 40) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      counts.set(norm, (counts.get(norm) || 0) + 1);
    }
  }
  const repeated = new Set();
  for (const [norm, c] of counts) if (c >= Math.max(3, Math.ceil(totalPages * 0.4))) repeated.add(norm);
  return repeated;
}

/** 正文行（去掉页眉页脚与页码）→ 段落，并统计"多大字号算标题"。 */
function cleanPages(pagesLines) {
  const totalPages = pagesLines.length;
  const repeated = findRepeatedLines(pagesLines, totalPages);
  const stats = { droppedPageNumbers: 0, droppedRepeated: 0, emptyPages: 0 };
  const kept = [];
  for (const lines of pagesLines) {
    let content = 0;
    lines.forEach((l, i) => {
      const isEdge = i < 3 || i >= lines.length - 3;
      if (isEdge && PAGE_NUMBER_RE.test(l.text)) { stats.droppedPageNumbers += 1; return; }
      if (isEdge && repeated.has(l.text.replace(/\d+/g, '#').trim())) { stats.droppedRepeated += 1; return; }
      kept.push(l);
      content += 1;
    });
    if (content === 0) stats.emptyPages += 1;
  }
  // 有的 PDF 会在每个汉字之间插空格（"第 一 章"）：只有整本都是这种风格时才抹掉，
  // 否则保留"第一章 停业通知"这类正常的标题空格。
  const SPACE_BETWEEN_CJK = /[　-鿿豈-﫿][ \t]+(?=[　-鿿豈-﫿])/g;
  const ADJACENT_CJK = /[　-鿿豈-﫿](?=[　-鿿豈-﫿])/g;
  const probe = kept.map((l) => l.text).join('\n');
  const withSpace = (probe.match(SPACE_BETWEEN_CJK) || []).length;
  const adjacent = (probe.match(ADJACENT_CJK) || []).length;
  const spacedStyle = withSpace >= 20 && withSpace / (withSpace + adjacent) > 0.4;
  const allLines = kept.map((l) => ({
    text: spacedStyle ? l.text.replace(/[　-鿿豈-﫿][ \t]+(?=[　-鿿豈-﫿])/g, '$1') : l.text,
    size: l.size,
  }));
  const bodySize = weightedMedian(
    allLines.filter((l) => l.text.length >= 10).map((l) => ({ v: l.size || 0, w: l.text.length })),
  ) || 10;
  return { allLines, bodySize, stats, spacedStyle };
}

function weightedMedian(pairs) {
  if (pairs.length === 0) return 0;
  const sorted = [...pairs].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of sorted) {
    acc += p.w;
    if (acc >= total / 2) return p.v;
  }
  return sorted[sorted.length - 1].v;
}

export async function convertPdf(src) {
  const size = fs.statSync(src).size;
  if (size > MAX_PDF_BYTES) fail(`PDF 太大（${Math.round(size / 1024 / 1024)}MB，上限 256MB）`);
  const unpdf = await loadUnpdf();
  const data = new Uint8Array(fs.readFileSync(src));

  let doc;
  try {
    doc = await unpdf.getDocumentProxy(data, {
      cMapUrl: pdfjsDataDir('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: pdfjsDataDir('standard_fonts'),
      useWorkerFetch: false,
    });
  } catch (e) {
    fail(`PDF 打不开：${e.message}`, '损坏或加密的 PDF 无法转换；扫描件（图片版）需要先 OCR');
  }

  let pagesLines;
  const warnings = [];
  try {
    const { items } = await unpdf.extractTextItems(doc);
    pagesLines = items.map(itemsToLines);
  } finally {
    try { await doc.destroy(); } catch { /* 关不掉就算了 */ }
  }

  const totalPages = pagesLines.length;
  const { allLines, bodySize, stats } = cleanPages(pagesLines);
  const rawText = allLines.map((l) => l.text).join('\n');
  const rawChars = rawText.replace(/\s/g, '').length;
  const garbage = (rawText.match(/�/g) || []).length + (rawText.match(/\(cid:\d+\)/g) || []).length;

  if (rawChars < Math.max(50, 25 * totalPages)) {
    fail(
      `这份 PDF 共 ${totalPages} 页，只抽出 ${rawChars} 个字——是扫描件（图片版）或纯图片文档`,
      '本版不做 OCR：请先用 OCR 工具（或另找文字版）转成 txt 再导入',
    );
  }
  if (stats.emptyPages > 0 && stats.emptyPages >= Math.max(2, Math.ceil(totalPages * 0.3))) {
    warnings.push(`${stats.emptyPages}/${totalPages} 页没有文字（插图页或扫描页）`);
  }
  if (garbage > 0) {
    warnings.push(`抽出 ${garbage} 个乱码字符（原 PDF 字体嵌入不完整）`);
    if (garbage > rawChars * 0.01) warnings.push('乱码比例偏高，抽出的文字可能不可靠');
  }

  // 字号明显大于正文、又不以句末标点收尾的短行，也算标题（没有"第X章"字样的书靠它）。
  const sizeOf = new Map();
  for (const l of allLines) {
    const t = l.text.trim();
    if (sizeOf.get(t) === undefined || l.size > sizeOf.get(t)) sizeOf.set(t, l.size);
  }
  const isSizeHeading = (t) => {
    const s = sizeOf.get(t);
    return s !== undefined && s >= bodySize * 1.18 && t.length <= 40
      && !SENTENCE_END_RE.test(t) && !PAGE_NUMBER_RE.test(t);
  };
  const paras = joinWrappedLines(allLines.map((l) => l.text), {
    isHeading: (t) => isHeadingLine(t) || isSizeHeading(t),
  });
  const marked = markHeadings(paras);

  if (marked.headings === 0 && totalPages >= 30) {
    warnings.push('没识别到章节标题：整本会作为一章导入；可在 source.md 里给标题行加 `# ` 后，用 dr_import 导入该 .md');
  }

  return {
    ...marked,
    pages: totalPages,
    chars: rawChars,
    garbage,
    emptyPages: stats.emptyPages,
    bodySize,
    droppedPageNumbers: stats.droppedPageNumbers,
    droppedRepeated: stats.droppedRepeated,
    warnings,
  };
}

// ---------------------------------------------------------------- 汇总

/** txt 源 → { markdown, conversion }，collect.js 用。 */
export function convertTxt(src) {
  const { text, encoding, uncertain } = decodeText(fs.readFileSync(src));
  const conv = textToMarkdown(text);
  const warnings = [];
  if (uncertain) warnings.push(`编码不确定（按 ${encoding} 解的）——请打开 source.md 核对开头是否乱码`);
  if (conv.headings === 0) warnings.push('没识别到章节标题：整本会作为一章导入；可在 source.md 里给标题行加 `# ` 后，用 dr_import 导入该 .md');
  return {
    markdown: conv.markdown,
    conversion: {
      kind: 'txt',
      encoding,
      uncertain,
      mode: conv.mode === 'blank-lines' ? '空行分段' : '按行合并',
      headings: conv.headings,
      paragraphs: conv.paragraphs,
      warnings,
    },
  };
}
