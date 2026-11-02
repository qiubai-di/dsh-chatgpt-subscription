import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { requestPolicyFacts } from '../src/request-policy.js'

// Release metadata checks supplement (never replace) packed public-entry wire tests.
const root = new URL('../../', import.meta.url)
const json = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8'))

test('candidate metadata identifies 0.1.8 and its changed replay projection consistently', async () => {
  const manifest = await json('package.json')
  const lock = await json('package-lock.json')
  assert.equal(manifest.version, '0.1.8')
  assert.equal(lock.version, manifest.version)
  assert.equal(lock.packages[''].version, manifest.version)
  const facts = requestPolicyFacts('gpt-6.1-sol', 'synthetic-release-generation', new AbortController().signal, 'compaction')
  assert.ok(facts.cache?.projection.includes(`subscription@${manifest.version}/native-replay-v2`))
  assert.ok(facts.cache?.projection.includes('tool-identity=v1;pi-replay-body-state=v1'))
  assert.ok(facts.cache?.projection.endsWith(';tool-choice=none'))
})

test('public CLI version matches the package version without opening an account store', async () => {
  const manifest = await json('package.json')
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
  const output = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  assert.equal(output.trim(), manifest.version)
})

test('package allowlist delivers legal BC contract docs and JSON without bundling BC', async () => {
  const manifest = await json('package.json')
  for (const file of ['docs', 'test/fixtures/bc-namespace-contract.json', 'CHANGELOG.md']) {
    assert.ok(manifest.files.includes(file), `missing candidate delivery entry: ${file}`)
  }
  assert.equal(manifest.bundleDependencies.some((name: string) => /billion-context|optchat/i.test(name)), false)
  const fixture = await json('test/fixtures/bc-namespace-contract.json')
  assert.equal(fixture.tools[0].type, 'namespace')
  assert.equal(fixture.tools[0].name, 'dsh')
  assert.equal(fixture.tools[0].tools[0].name, 'run_code')
  assert.equal(fixture.bcCompressReachable, false)
})
