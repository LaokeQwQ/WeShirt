import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

for (const file of ['frontend/src/views/Assistant.vue', 'frontend/src/components/AdminAI.vue']) {
  test(file + ' compiles its script and accessible template', async () => {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8')
    const { descriptor, errors } = parse(source, { filename: file })
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: file })
    const result = compileTemplate({ id: file, source: descriptor.template.content, filename: file, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(result.errors, [])
  })
}
