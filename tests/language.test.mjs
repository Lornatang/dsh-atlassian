import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

test('shipped source and documentation contain no Chinese text', async () => {
  const files = ['README.md', 'CHANGELOG.md', 'NOTICE']
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else files.push(path)
    }
  }
  await visit('src')
  await visit('lib')
  for (const file of files) assert.doesNotMatch(await readFile(file, 'utf8'), /[\u3400-\u9fff]/u, file)
  await assert.rejects(access('README.zh-CN.md'), { code: 'ENOENT' })
})
