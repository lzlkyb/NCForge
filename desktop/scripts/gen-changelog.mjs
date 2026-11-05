#!/usr/bin/env node
// CHANGELOG.md remains the authored source; share the parser with regression tests.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseChangelog, renderChangelog } from './lib/changelog.mjs';

const source = new URL('../../CHANGELOG.md', import.meta.url);
const output = new URL('../src/lib/changelog.generated.ts', import.meta.url);
const entries = parseChangelog(readFileSync(source, 'utf8'));
if (!entries.length) throw new Error('CHANGELOG.md 未解析出任何正式版本');
writeFileSync(output, renderChangelog(entries), 'utf8');
console.log(`[GEN-CHANGELOG] 已生成 ${entries.length} 个版本，最新为 ${entries[0].version}：${fileURLToPath(output)}`);
