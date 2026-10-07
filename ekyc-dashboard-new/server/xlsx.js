import { strToU8, zipSync } from 'fflate';

const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escapeXml = value => Array.from(String(value ?? '')).filter(char => { const code = char.charCodeAt(0); return code >= 32 || code === 9 || code === 10 || code === 13; }).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const cellName = (row, col) => {
  let name = ''; let number = col + 1;
  while (number) { number -= 1; name = String.fromCharCode(65 + number % 26) + name; number = Math.floor(number / 26); }
  return `${name}${row}`;
};
const xml = text => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${text}`);
function worksheet(columns, rows) {
  const all = [columns, ...rows];
  const lines = all.map((values, index) => `<row r="${index + 1}">${values.map((value, column) => `<c r="${cellName(index + 1, column)}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`).join('')}</row>`).join('');
  return xml(`<worksheet xmlns="${sheetNs}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${lines}</sheetData></worksheet>`);
}
export function makeXlsx(sheets) {
  if (!sheets.length) throw new Error('XLSX requires at least one sheet');
  const contentTypes = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const workbookSheets = sheets.map(([name], index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const workbookRels = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${relNs}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  const files = {
    '[Content_Types].xml': xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${contentTypes}</Types>`),
    '_rels/.rels': xml(`<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${relNs}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': xml(`<workbook xmlns="${sheetNs}" xmlns:r="${relNs}"><sheets>${workbookSheets}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': xml(`<Relationships xmlns="${pkg}">${workbookRels}</Relationships>`),
  };
  sheets.forEach(([, columns, rows], index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = worksheet(columns, rows); });
  return Buffer.from(zipSync(files, { level: 6 }));
}
