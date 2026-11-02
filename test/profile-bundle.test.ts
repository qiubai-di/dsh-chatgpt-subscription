import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { composeEntries } from '@deepseek-ai/dsh-app-boot';
import { parse } from 'yaml';

test('the published bundle registers the enabled subscription plugin in native DSH composition', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const patch = parse(await readFile(manifest.dsh.bundle.patch, 'utf8'));
  const warnings: string[] = [];
  const entries = composeEntries([patch], warning => warnings.push(warning));

  assert.deepEqual(warnings, []);
  const plugins = entries.filter(entry => entry.name === manifest.name);
  assert.equal(plugins.length, 1, 'DSH must compose exactly one subscription plugin');
  assert.notEqual(plugins[0]!.disabled, true, 'the subscription plugin must be enabled');
});
