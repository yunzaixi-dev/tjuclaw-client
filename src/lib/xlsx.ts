import { strFromU8, unzipSync } from 'fflate';

// Reads an .xlsx in the browser for preview: each sheet's cells as text, in
// place, with empty cells kept so columns line up. Formulas show their cached
// value; styles and number formats are not applied.

export interface Sheet { name: string; rows: string[][] }

const MAX_CELLS = 200_000;
const MAX_PART = 32 * 1024 * 1024;
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function xml(text: string) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('invalid_xlsx');
  return doc;
}

const children = (node: Element, local: string) => Array.from(node.getElementsByTagNameNS(MAIN_NS, local));

/** Text of a shared or inline string: its <t> runs, without phonetic hints. */
function stringText(node: Element) {
  return children(node, 't').filter(t => !t.closest('rPh')).map(t => t.textContent ?? '').join('');
}

/** Zero-based column of a reference such as "AB12". */
export function column(ref: string) {
  let col = 0;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    col = col * 26 + code - 64;
  }
  return col - 1;
}

/** Spreadsheet column name for a zero-based index: 0 → A, 26 → AA. */
export function columnName(index: number) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export function parseXlsx(bytes: Uint8Array): Sheet[] {
  const wanted = (name: string) => name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' || name === 'xl/sharedStrings.xml' || name.startsWith('xl/worksheets/');
  const files = unzipSync(bytes, { filter: file => wanted(file.name) && file.originalSize <= MAX_PART });
  const text = (name: string) => files[name] ? strFromU8(files[name]) : '';
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('invalid_xlsx');
  const targets = new Map<string, string>();
  const rels = text('xl/_rels/workbook.xml.rels');
  if (rels) {
    for (const rel of Array.from(xml(rels).getElementsByTagName('Relationship'))) {
      const target = rel.getAttribute('Target') ?? '';
      targets.set(rel.getAttribute('Id') ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    }
  }
  const shared = text('xl/sharedStrings.xml') ? children(xml(text('xl/sharedStrings.xml')).documentElement, 'si').map(stringText) : [];
  let cells = 0;
  return children(xml(workbook).documentElement, 'sheet').map((sheet, index) => {
    const part = targets.get(sheet.getAttributeNS(REL_NS, 'id') ?? '') ?? `xl/worksheets/sheet${index + 1}.xml`;
    const rows: string[][] = [];
    const source = text(part);
    if (source) {
      for (const row of children(xml(source).documentElement, 'row')) {
        const out: string[] = [];
        for (const cell of children(row, 'c')) {
          if (++cells > MAX_CELLS) throw new Error('too_many_cells');
          const type = cell.getAttribute('t') ?? '';
          const value = children(cell, 'v')[0]?.textContent ?? '';
          const textValue = type === 's' ? shared[Number(value)] ?? ''
            : type === 'inlineStr' ? stringText(children(cell, 'is')[0] ?? cell)
              : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE') : value;
          const at = column(cell.getAttribute('r') ?? '');
          const col = at >= 0 && at < 16384 ? at : out.length;
          while (out.length < col) out.push('');
          out[col] = textValue;
        }
        const at = Number(row.getAttribute('r'));
        while (Number.isInteger(at) && at > 0 && rows.length < at - 1) rows.push([]);
        rows.push(out);
      }
    }
    while (rows.length && rows[rows.length - 1].every(value => value === '')) rows.pop();
    return { name: sheet.getAttribute('name') ?? `Sheet${index + 1}`, rows };
  });
}
