import { describe, expect, test } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { makeXlsx } from '../../ekyc-dashboard-new/server/xlsx.js';

describe('dashboard XLSX export', () => {
  test('writes a valid workbook package with escaped customer text', () => {
    const files = unzipSync(makeXlsx([['users', ['id', 'note'], [['123', 'A & <B>']]]]));
    expect(Object.keys(files)).toContain('xl/workbook.xml');
    expect(Object.keys(files)).toContain('xl/worksheets/sheet1.xml');
    expect(strFromU8(files['xl/workbook.xml'])).toContain('name="users"');
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('A &amp; &lt;B&gt;');
    expect(sheet).toContain('r="B2"');
  });
});
