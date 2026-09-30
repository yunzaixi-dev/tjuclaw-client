export type DisplayMath = { from: number; to: number; tex: string; contentFrom: number };

const quotePrefix = /^[ \t]*(?:>[ \t]*)*/;
const closing = /(?<!\\)\$\$[ \t]*$/;

/** Display math owns its lines, including blank lines, independently of paragraphs. */
export function findDisplayMath(source: string, excluded: (position: number) => boolean = () => false): DisplayMath[] {
  const lines = source.split('\n');
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const blocks: DisplayMath[] = [];
  for (let index = 0; index < lines.length; index++) {
    const prefix = quotePrefix.exec(lines[index])![0];
    const text = lines[index].slice(prefix.length);
    if (!text.startsWith('$$') || excluded(offsets[index] + prefix.length)) continue;
    const first = text.slice(2);
    const sameLine = closing.exec(first);
    if (sameLine) {
      blocks.push({ from: offsets[index], to: offsets[index] + lines[index].length, tex: first.slice(0, sameLine.index).trim(), contentFrom: offsets[index] + prefix.length + 2 });
      continue;
    }
    // Only a delimiter on its own line closes a multiline block.
    const depth = (prefix.match(/>/g) ?? []).length;
    const content = [first];
    let end = index + 1;
    for (; end < lines.length; end++) {
      const nextPrefix = quotePrefix.exec(lines[end])![0];
      const nextDepth = (nextPrefix.match(/>/g) ?? []).length;
      if (lines[end].trim() && nextDepth !== depth) break;
      const next = lines[end].slice(nextPrefix.length);
      if (/^\$\$[ \t]*$/.test(next)) {
        blocks.push({ from: offsets[index], to: offsets[end] + lines[end].length, tex: content.join('\n').trim(), contentFrom: offsets[index + 1] + (quotePrefix.exec(lines[index + 1])?.[0].length ?? 0) });
        index = end;
        break;
      }
      // Strip quote markers, but preserve TeX indentation.
      content.push(depth ? lines[end].replace(/^[ \t]*(?:>[ \t]?)+/, '') : lines[end]);
    }
    // An unfinished block must not rescan the same tail for every $$ line.
    // Crossing out of a quote resumes scanning at the new container.
    if (end === lines.length) break;
    if (index !== end) index = end - 1;
  }
  return blocks;
}
