import { useState } from 'react';
import { columnName, type Sheet } from '../lib/xlsx';

const MAX_ROWS = 1000;
const MAX_COLS = 100;

/** A read-only spreadsheet: sheet tabs, then a grid with row and column headings. */
export function SheetView({ sheets }: { sheets: Sheet[] }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  if (!sheet) return <p className="file-preview-message">表格里没有工作表。</p>;
  const width = Math.min(MAX_COLS, Math.max(1, ...sheet.rows.slice(0, MAX_ROWS).map(row => row.length)));
  const rows = sheet.rows.slice(0, MAX_ROWS);
  const clipped = sheet.rows.length > MAX_ROWS || sheet.rows.some(row => row.length > MAX_COLS);
  return <div className="sheet-view">
    {sheets.length > 1 ? <div className="sheet-tabs" role="tablist" aria-label="工作表">
      {sheets.map((item, index) => <button key={`${index}-${item.name}`} type="button" role="tab" aria-selected={index === active} onClick={() => setActive(index)}>{item.name}</button>)}
    </div> : null}
    <div className="sheet-scroll" role="region" aria-label={`工作表 ${sheet.name}`} tabIndex={0}>
      {rows.length ? <table className="sheet-grid">
        <thead><tr><th scope="col" aria-label="行号" />{Array.from({ length: width }, (_, col) => <th key={col} scope="col">{columnName(col)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}><th scope="row">{index + 1}</th>
          {Array.from({ length: width }, (_, col) => <td key={col}>{row[col] ?? ''}</td>)}
        </tr>)}</tbody>
      </table> : <p className="file-preview-message">这个工作表是空的。</p>}
    </div>
    {clipped ? <p className="sheet-note">只预览前 {MAX_ROWS} 行、{MAX_COLS} 列；完整内容请下载原件。</p> : null}
  </div>;
}
