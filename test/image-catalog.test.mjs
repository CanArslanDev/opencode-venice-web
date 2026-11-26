import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { imageModelCatalog } from '../src/lib/image-catalog.mjs'
import { ImageRequestError, checkPromptLimit, parseCount, parseResponseFormat, parseSize } from '../src/lib/imagegen.mjs'
import { DEFAULT_EDIT_MODEL, DEFAULT_IMAGE_MODEL, EDIT_MODELS, IMAGE_MODELS, MODELS } from '../src/lib/models.mjs'
import { parseStudioOptions } from '../src/lib/studio.mjs'
import { createServer } from '../src/lib/server.mjs'

const refused = (fn) => assert.throws(fn, ImageRequestError)

test('studio catalogue: every model, generation and edit apart, one default each', () => {
  const catalog = imageModelCatalog('studio')
  assert.equal(catalog.route, 'studio')
  assert.deepEqual(catalog.generation.data.map((model) => model.id), Object.keys(IMAGE_MODELS))
  assert.deepEqual(catalog.edit.data.map((model) => model.id), Object.keys(EDIT_MODELS))
  assert.deepEqual(catalog.generation.data.filter((model) => model.default).map((model) => model.id), [DEFAULT_IMAGE_MODEL])
  assert.deepEqual(catalog.edit.data.filter((model) => model.default).map((model) => model.id), [DEFAULT_EDIT_MODEL])
  for (const model of [...catalog.generation.data, ...catalog.edit.data]) {
    assert.equal(typeof model.name, 'string')
    assert.equal(typeof model.nsfw, 'boolean')
  }
})

test('nsfw follows the catalogue (apiUncensored, 2026-11-26)', () => {
  const nsfw = (list) => list.filter((model) => model.nsfw).map((model) => model.id).sort()
  const catalog = imageModelCatalog('studio')
  assert.deepEqual(nsfw(catalog.generation.data), ['chroma', 'krea-2-turbo', 'lustify-sdxl', 'lustify-v8', 'wai-illu'])
  assert.deepEqual(nsfw(catalog.edit.data), ['qwen-edit-uncensored'])
})

test('studio controls are only the ones the model takes', () => {
  const byId = Object.fromEntries(imageModelCatalog('studio').generation.data.map((model) => [model.id, model]))
  for (const [id, info] of Object.entries(IMAGE_MODELS)) {
    const { controls } = byId[id]
    assert.equal('negative_prompt' in controls, !!info.negativePrompt, id)
    assert.equal('steps' in controls, !info.steps?.fixed, id)
    assert.equal('cfg_scale' in controls, !!info.cfg, id)
    assert.equal('resolution' in controls, !!info.sizes, id)
    for (const name of ['seed', 'output_format', 'hide_watermark', 'safe_mode', 'embed_exif', 'style_preset', 'aspect_ratio', 'size', 'n', 'prompt']) {
      assert.ok(name in controls, `${id} ${name}`)
    }
    // a control the catalogue leaves out is refused by the validation
    if (!controls.negative_prompt) refused(() => parseStudioOptions({ negative_prompt: 'x' }, id, info))
    if (!controls.steps) refused(() => parseStudioOptions({ steps: 4 }, id, info))
    if (!controls.cfg_scale) refused(() => parseStudioOptions({ cfg_scale: 4 }, id, info))
    if (!controls.resolution) refused(() => parseStudioOptions({ resolution: '1K' }, id, info))
  }
  assert.deepEqual(byId['krea-2-turbo'].fixed, { steps: 8 })
  assert.equal(byId['krea-2-turbo'].controls.sizes['2K']['16:9'], '2560x1440')
})

test('studio limits and defaults are the validation limits and defaults', () => {
  for (const model of imageModelCatalog('studio').generation.data) {
    const info = IMAGE_MODELS[model.id]
    const { controls: c } = model
    const defaults = parseStudioOptions({}, model.id, info)
    assert.equal(defaults.hideWatermark, c.hide_watermark.default)
    assert.equal(defaults.safeMode, c.safe_mode.default)
    assert.equal(defaults.embedExif, c.embed_exif.default)
    assert.equal(defaults.format, c.output_format.default)
    for (const format of c.output_format.options) parseStudioOptions({ output_format: format }, model.id, info)
    refused(() => parseStudioOptions({ output_format: 'jpeg' }, model.id, info))

    parseStudioOptions({ seed: c.seed.max }, model.id, info)
    parseStudioOptions({ seed: c.seed.min }, model.id, info)
    refused(() => parseStudioOptions({ seed: c.seed.max + 1 }, model.id, info))

    for (const aspect of c.aspect_ratio.options) parseStudioOptions({ aspect_ratio: aspect }, model.id, info)
    refused(() => parseStudioOptions({ aspect_ratio: '7:3' }, model.id, info))
    if (c.resolution) {
      for (const res of c.resolution.options) parseStudioOptions({ resolution: res }, model.id, info)
      assert.equal(defaults.resolution, c.resolution.default)
      assert.equal(defaults.aspectRatio, c.aspect_ratio.default)
    }
    parseSize(`${c.size.max}x${c.size.min}`)
    refused(() => parseSize(`${c.size.max + 1}x${c.size.min}`))

    if (c.steps) {
      assert.equal(defaults.steps, c.steps.default)
      parseStudioOptions({ steps: c.steps.max }, model.id, info)
      refused(() => parseStudioOptions({ steps: c.steps.max + 1 }, model.id, info))
    }
    if (c.cfg_scale) {
      assert.equal(defaults.cfgScale, c.cfg_scale.default)
      parseStudioOptions({ cfg_scale: c.cfg_scale.max }, model.id, info)
      refused(() => parseStudioOptions({ cfg_scale: c.cfg_scale.max + 0.5 }, model.id, info))
      refused(() => parseStudioOptions({ cfg_scale: c.cfg_scale.min - 0.5 }, model.id, info))
    }
    if (c.negative_prompt) {
      parseStudioOptions({ negative_prompt: 'x'.repeat(c.negative_prompt.max_length) }, model.id, info)
      refused(() => parseStudioOptions({ negative_prompt: 'x'.repeat(c.negative_prompt.max_length + 1) }, model.id, info))
    }
    parseStudioOptions({ prompt: 'x'.repeat(c.prompt.max_length) }, model.id, info)
    refused(() => parseStudioOptions({ prompt: 'x'.repeat(c.prompt.max_length + 1) }, model.id, info))
    assert.equal(parseCount(c.n.max), c.n.max)
    refused(() => parseCount(c.n.max + 1))
    for (const format of c.response_format.options) parseResponseFormat(format)
  }
})

test('agent catalogue: only the models the agent runs, with the agent controls', () => {
  const catalog = imageModelCatalog('agent')
  assert.equal(catalog.route, 'agent')
  const ids = catalog.generation.data.map((model) => model.id)
  assert.deepEqual(ids, Object.keys(IMAGE_MODELS).filter((id) => IMAGE_MODELS[id].agent))
  assert.deepEqual(ids, ['z-image-turbo', 'chroma', 'wai-illu'])
  assert.ok(ids.includes(catalog.generation.default))
  for (const model of catalog.generation.data) {
    assert.deepEqual(Object.keys(model.controls).sort(), ['n', 'prompt', 'response_format', 'size'])
    assert.equal(model.fixed, undefined)
  }
  // edits always run on the agent route: the same list in both modes
  assert.deepEqual(catalog.edit, imageModelCatalog('studio').edit)
})

test('edit controls match the edit validation', () => {
  for (const model of imageModelCatalog('studio').edit.data) {
    assert.deepEqual(Object.keys(model.controls).sort(), ['image', 'n', 'prompt', 'response_format'])
    assert.equal(model.controls.image.max, 10)
    checkPromptLimit('x'.repeat(model.controls.prompt.max_length), EDIT_MODELS[model.id], model.id)
    refused(() => checkPromptLimit('x'.repeat(model.controls.prompt.max_length + 1), EDIT_MODELS[model.id], model.id))
  }
})

async function withServer(fn) {
  const http = createHttpServer(createServer())
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${http.address().port}`)
  } finally {
    await new Promise((resolve) => http.close(resolve))
  }
}

test('GET /v1/images/models answers the catalogue; /v1/models keeps its contract', async () => {
  await withServer(async (base) => {
    const images = await (await fetch(`${base}/v1/images/models`)).json()
    assert.deepEqual(images, JSON.parse(JSON.stringify(imageModelCatalog(images.route))))
    const models = await (await fetch(`${base}/v1/models`)).json()
    assert.equal(models.object, 'list')
    assert.deepEqual(models.data.map((model) => model.id), Object.keys(MODELS))
    for (const model of models.data) assert.deepEqual(Object.keys(model).sort(), ['context_length', 'id', 'name', 'object', 'owned_by'])
  })
})

test('VENICE_WEB_IMAGE_ROUTE=agent: the endpoint lists the agent catalogue', () => {
  const script = `
    import { createServer as http } from 'node:http'
    import { createServer } from ${JSON.stringify(fileURLToPath(new URL('../src/lib/server.mjs', import.meta.url)))}
    const server = http(createServer()).listen(0, '127.0.0.1', async () => {
      const body = await (await fetch('http://127.0.0.1:' + server.address().port + '/v1/images/models')).json()
      console.log(JSON.stringify({ route: body.route, ids: body.generation.data.map((m) => m.id) }))
      server.close()
    })`
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, VENICE_WEB_IMAGE_ROUTE: 'agent' } })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1)), { route: 'agent', ids: ['z-image-turbo', 'chroma', 'wai-illu'] })
})
