/**
 * 测试用小 PDF 生成器：手搓一个字节精确的最小 PDF（Helvetica 11pt）。
 * 每页 spec：{ lines: ['...', ...] } 文本页，或 { rectOnly: true } 只画一个
 * 矩形的"扫描件样子"页（零文字，用来测拒绝路径）。
 */
export function makePdfBytes(pagesSpec) {
  const enc = (s) => Buffer.from(s, 'latin1');
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
  const chunks = []; // {num, body}
  const pageObjNums = [];
  // 1 catalog, 2 pages, 3 font；之后每页占两个对象号：page, content。
  const FONT = 3;
  pagesSpec.forEach((spec, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    pageObjNums.push(pageNum);
    chunks.push({
      num: pageNum,
      body: enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${FONT} 0 R >> >> /Contents ${contentNum} 0 R >>`),
    });
    let stream;
    if (spec.rectOnly) {
      stream = '0 0 1 rg 100 100 400 400 re f\n';
    } else {
      const parts = ['BT /F1 11 Tf'];
      let y = 720;
      for (const line of spec.lines) {
        parts.push(`1 0 0 1 72 ${y} Tm (${esc(line)}) Tj`);
        y -= 20;
      }
      parts.push('ET');
      stream = parts.join('\n') + '\n';
    }
    chunks.push({
      num: contentNum,
      body: enc(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`),
    });
  });
  chunks.push({ num: FONT, body: enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') });
  chunks.sort((a, b) => a.num - b.num);
  chunks.unshift({ num: 1, body: enc(`<< /Type /Catalog /Pages 2 0 R >>`) });
  chunks.splice(1, 0, {
    num: 2,
    body: enc(`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>`),
  });

  const pieces = [enc('%PDF-1.4\n')];
  let offset = pieces[0].length;
  const offsets = new Map();
  for (const c of chunks) {
    offsets.set(c.num, offset);
    const piece = Buffer.concat([enc(`${c.num} 0 obj\n`), c.body, enc('\nendobj\n')]);
    pieces.push(piece);
    offset += piece.length;
  }
  const maxNum = chunks.length;
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++) xref += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  pieces.push(enc(xref));
  return Buffer.concat(pieces);
}
