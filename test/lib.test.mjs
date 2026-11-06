import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

mkdirSync('.tmp-test', { recursive: true });
const src = readFileSync('src/lib.ts', 'utf8');
const transpiled = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
writeFileSync('.tmp-test/lib.mjs', transpiled);
const lib = await import(pathToFileURL('.tmp-test/lib.mjs'));

test('normalizes only successful login events', () => {
  const events = lib.normalizeLogText(`{"Action":"login","Allowed":true,"UserUID":"u1","AppUUID":"a1","CreatedAt":"2026-11-04T01:02:03Z","Email":"USER@EXAMPLE.COM","RayID":"r1"}\n{"Action":"logout","Allowed":true,"UserUID":"u1","AppUUID":"a1","CreatedAt":"2026-11-04T01:02:03Z"}\n{"Action":"login","Allowed":false,"UserUID":"u2","AppUUID":"a2","CreatedAt":"2026-11-04T01:02:03Z"}`);
  assert.equal(events.length, 1);
  assert.equal(events[0].period, '2026-11');
  assert.equal(events[0].email, 'user@example.com');
});

test('creates date-prefixed lookback window', () => {
  assert.deepEqual(lib.getLookbackDates(new Date('2026-11-04T12:00:00Z'), 2), ['20261102', '20261103', '20261104']);
  assert.deepEqual(lib.datePrefixes('logs', ['20261104']), ['logs/20261104/']);
});
