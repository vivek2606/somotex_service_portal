import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../components/SettingsContext';
import { fmtNum, useAction } from '../components/ui';
import { db } from '../db/db';
import { importStockRows, type StockImportResult } from '../db/service';
import { downloadText, mapStockSheet, parseCsv, STOCK_TEMPLATE, type ParsedStockSheet } from '../lib/csv';

export default function StockImport() {
  const settings = useSettings();
  const { run, busy } = useAction();
  const [sheet, setSheet] = useState<ParsedStockSheet>();
  const [result, setResult] = useState<StockImportResult>();

  const load = async (file: File) => {
    setResult(undefined);
    setSheet(mapStockSheet(parseCsv(await file.text())));
  };

  return (
    <div>
      <div className="topbar">
        <h1>Import stock sheet</h1>
        <span className="spacer" />
        <button onClick={() => downloadText('stock-template.csv', STOCK_TEMPLATE)}>Download template</button>
      </div>
      <div className="card">
        <p>
          Upload your spare parts or gas stock list as a <strong>CSV</strong> file (in Excel: <em>File → Save As → CSV</em>). Columns
          are matched by name. Common headings such as <em>Part No, Description, UOM, Qty, Min Stock, Rate, Model, Bin</em> work.
        </p>
        <ul className="small muted">
          <li>Items are matched by SKU / part number and updated, or created if new. Without a SKU, one is made from the name.</li>
          <li>Where a stock quantity is given, the item is set to it with a ledger entry, so the history stays auditable.</li>
          <li>Type is detected from the name if not given (e.g. “R32” → Refrigerant, “Oxygen” → Brazing Gas, “Nitrogen”).</li>
        </ul>
        <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
      </div>

      {sheet && (
        <div className="card">
          <div className="row between">
            <h2>Preview: {sheet.rows.length} items</h2>
            <button
              className="primary"
              disabled={busy || sheet.rows.length === 0}
              onClick={() => run(async () => setResult(await importStockRows(db, settings, sheet.rows)), 'Import complete')}
            >
              Import {sheet.rows.length} items
            </button>
          </div>
          {sheet.errors.map((e) => (
            <div key={e} className="alert-box">
              {e}
            </div>
          ))}
          {sheet.unmappedColumns.length > 0 && (
            <p className="small muted">Ignored columns: {sheet.unmappedColumns.join(', ')}</p>
          )}
          {result && (
            <div className="alert-box info">
              {result.created} created, {result.updated} updated, stock set on {result.stockSet}. <Link to="/inventory">View inventory</Link>
            </div>
          )}
          <div className="table-wrap" style={{ maxHeight: 480, overflowY: 'auto', marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="num">Stock</th>
                  <th>Unit</th>
                  <th className="num">Reorder</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {sheet.rows.slice(0, 500).map((r) => (
                  <tr key={r.sku}>
                    <td className="small">{r.sku}</td>
                    <td>
                      {r.name}
                      {r.compatibility && <div className="small muted">{r.compatibility}</div>}
                    </td>
                    <td>
                      {r.type}
                      {r.refrigerant && <span className="badge info" style={{ marginLeft: 4 }}>{r.refrigerant}</span>}
                    </td>
                    <td className="num">{r.stock !== undefined ? fmtNum(r.stock, 3) : '—'}</td>
                    <td>{r.unit}</td>
                    <td className="num">{r.reorderLevel ?? '—'}</td>
                    <td className="num">{r.unitCost ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
