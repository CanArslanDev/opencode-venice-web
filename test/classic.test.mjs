import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLASSIC_PATH,
  answerStarted,
  classicReader,
  decodeTextDocument,
  documentExtractionRequest,
  documentMessage,
  mergeRuns,
  isTextDocument,
  parsedDocument,
  samplingOptions,
  toClassicRequest,
} from '../src/lib/classic.mjs'
import { toVeniceRequest, withRetryReminder } from '../src/lib/emulate.mjs'
import { MODELS, routeFor, windowFor } from '../src/lib/models.mjs'
import { collectStream } from '../src/lib/server.mjs'

const enc = new TextEncoder()
const feedAll = (reader, text, split = 7) => {
  const out = []
  const bytes = enc.encode(text)
  for (let i = 0; i < bytes.length; i += split) out.push(...reader.feed(bytes.slice(i, i + split), false))
  out.push(...reader.feed(new Uint8Array(), true))
  return out
}

/** A real classic stream (qwen3-5-35b-a3b, "Reply with exactly: PONG", 2026-11-25). */
const PONG = [
  '{"kind":"meta","references":[],"servingModelId":"qwen3-5-35b-a3b","servingModelName":"Qwen 3.5 35B A3B"}',
  '{"kind":"meta","augmented":false,"references":[],"completion_id":"chatcmpl-b0352168a16fd5311737cafb81db835c"}',
  '{"kind":"meta","augmented":false,"references":[],"thinking":true}',
  '{"content":"P","kind":"content"}',
  '{"content":"ONG","kind":"content"}',
  '{"kind":"meta","references":[],"servingModelId":"qwen3-5-35b-a3b","servingModelName":"Qwen 3.5 35B A3B"}',
  '',
].join('\n')

test('routes: only the three models the agent route runs stay on it', () => {
  const agent = Object.keys(MODELS).filter((id) => routeFor(id) === 'agent')
  assert.deepEqual(agent.sort(), ['deepseek-v4-1-flash', 'deepseek-v4-1-flash-uncensored', 'z-ai-glm-5-3-flash'])
  assert.equal(routeFor('qwen3-5-35b-a3b'), 'classic')
  assert.equal(routeFor('qwen3-5-35b-a3b', 'agent'), 'agent')
  assert.equal(routeFor('deepseek-v4-1-flash', 'classic'), 'classic')
  assert.equal(routeFor('deepseek-v4-1-flash', 'auto'), 'agent')
  assert.equal(CLASSIC_PATH, '/api/inference/chat')
})

test('classicReader: content deltas, serving model, completion at a clean end', () => {
  const events = feedAll(classicReader(), PONG)
  assert.deepEqual(
    events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta),
    ['P', 'ONG'],
  )
  assert.equal(events.find((event) => event.type === 'veniceai:serving_model').model, 'qwen3-5-35b-a3b')
  assert.equal(events.at(-1).type, 'response.completed')
})

test('classicReader: reasoning_content becomes reasoning, status lines and junk are ignored', () => {
  const events = feedAll(
    classicReader(),
    '{"content":"","kind":"content","reasoning_content":"think"}\n{"kind":"status","content":"processing"}\nnot json\n{"content":"391","kind":"content","reasoning_content":""}',
  )
  assert.deepEqual(
    events.map((event) => [event.type, event.delta]),
    [
      ['response.reasoning_text.delta', 'think'],
      ['response.output_text.delta', '391'],
      ['response.completed', undefined],
    ],
  )
})

test('classicReader: an error line is an error event and no completion', () => {
  const events = feedAll(classicReader(), '{"error":"Internal server error"}\n')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'error')
  assert.match(events[0].message, /Internal server error/)
})

test('toClassicRequest: system prompt string, roles, settings that keep the route honest', () => {
  const { request } = toVeniceRequest({
    model: 'qwen3-coder-480b-a35b-instruct-turbo',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'My name is Rafael.' },
      { role: 'assistant', content: 'Hi Rafael.' },
      { role: 'user', content: 'What is my name?' },
    ],
  })
  const body = toClassicRequest(request, { sampling: { temperature: 0.2 } })
  assert.equal(body.modelId, 'qwen3-coder-480b-a35b-instruct-turbo')
  assert.equal(body.systemPrompt, 'Be brief.')
  assert.equal(body.includeVeniceSystemPrompt, false)
  assert.equal(body.enableLargeContextChat, true)
  assert.equal(body.webEnabled, false)
  assert.equal(body.conversationType, 'text')
  assert.equal(body.isCharacter, false)
  assert.equal(body.reasoning, false)
  assert.equal(body.temperature, 0.2)
  assert.equal(typeof body.requestId, 'string')
  assert.deepEqual(
    body.prompt.map((message) => message.role),
    ['user', 'assistant', 'user'],
  )
  assert.equal(body.prompt[0].content, 'My name is Rafael.')
  assert.match(body.prompt[1].content, /"content":"Hi Rafael\."/) // envelope form, as on the agent route
})

test('toClassicRequest: reasoning follows reasoning_effort', () => {
  const { request } = toVeniceRequest({ model: 'qwen3-5-35b-a3b', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] })
  assert.equal(toClassicRequest(request).reasoning, true)
})

test('toClassicRequest: tool emulation and retry reminders survive the conversion', () => {
  const mapping = toVeniceRequest({
    model: 'qwen3-5-35b-a3b',
    messages: [{ role: 'user', content: 'list files' }],
    tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
  })
  const body = toClassicRequest(withRetryReminder(mapping.request))
  assert.match(body.systemPrompt, /Available tools/)
  // the route keeps only the last of several user messages in a row, so the
  // request and both reminders travel as one message, in order
  assert.equal(body.prompt.length, 1)
  assert.match(body.prompt[0].content, /^list files\n\n\(format reminder\)[\s\S]*\n\n\(act reminder\)/)
})

test('mergeRuns: consecutive same-role messages join, documents stay apart', () => {
  const doc = documentMessage('a.txt', 'A')
  const merged = mergeRuns([
    { role: 'user', content: 'one', imagePath: ['data:a'] },
    { role: 'user', content: 'two', imagePath: ['data:b'] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'three' },
    doc,
    { role: 'user', content: 'four' },
    { role: 'user', content: '' },
  ])
  assert.deepEqual(merged, [
    { role: 'user', content: 'one\n\ntwo', imagePath: ['data:a', 'data:b'] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'three' },
    doc,
    { role: 'user', content: 'four' },
  ])
})

test('toClassicRequest: images become data URLs on the message that carries them', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const mapping = toVeniceRequest({
    model: 'qwen3-vl-235b-a22b',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ],
      },
    ],
  })
  const body = toClassicRequest(mapping.request, { images: mapping.images })
  const withImage = body.prompt.filter((message) => message.imagePath)
  assert.equal(withImage.length, 1)
  assert.deepEqual(withImage[0].imagePath, [`data:image/png;base64,${png.toString('base64')}`])
  assert.match(withImage[0].content, /What is this\?/)
})

test('toClassicRequest: documents become isFile messages after the message that carried them', () => {
  const mapping = toVeniceRequest({
    model: 'qwen3-5-35b-a3b',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is the code word?' },
          { type: 'file', file: { filename: 'report.pdf', file_data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4 x').toString('base64')}` } },
        ],
      },
    ],
  })
  const [file] = mapping.files
  const documents = new Map([[file.mediaId, { filename: 'report.pdf', text: 'The code word is QUOKKA-2210' }]])
  const body = toClassicRequest(mapping.request, { documents })
  const index = body.prompt.findIndex((message) => message.isFile)
  assert.ok(index >= 0)
  assert.deepEqual(body.prompt[index], documentMessage('report.pdf', 'The code word is QUOKKA-2210'))
  assert.match(body.prompt[index - 1].content, /What is the code word\?/)
  assert.match(body.prompt[index].content, /attached the file "report\.pdf"[\s\S]*QUOKKA-2210/)
  // a document that could not be read is still named, never silently dropped
  const missing = toClassicRequest(mapping.request)
  assert.match(missing.prompt.find((message) => message.isFile).content, /report\.pdf[\s\S]*could not be read/)
})

test('toClassicRequest: with tools the reminder stays last, the document goes before it', () => {
  const mapping = toVeniceRequest({
    model: 'qwen3-5-35b-a3b',
    tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarise the file.' },
          { type: 'file', file: { filename: 'notes.md', file_data: `data:text/markdown;base64,${Buffer.from('# hi').toString('base64')}` } },
        ],
      },
    ],
  })
  const [file] = mapping.files
  const body = toClassicRequest(mapping.request, { documents: new Map([[file.mediaId, { filename: 'notes.md', text: '# hi' }]]) })
  assert.match(body.prompt.at(-1).content, /^\(format reminder\)/)
  assert.equal(body.prompt.at(-2).isFile, true)
})

test('samplingOptions: clamps to what the route accepts and the model can give', () => {
  assert.deepEqual(samplingOptions({}, MODELS['qwen3-5-35b-a3b']), {})
  assert.deepEqual(samplingOptions({ temperature: 9, top_p: 0.5, max_tokens: 99999 }, { output: 16384 }), {
    temperature: 2,
    topP: 0.5,
    maxResponseTokens: 16384,
  })
  assert.deepEqual(samplingOptions({ temperature: -1, max_completion_tokens: 20, max_tokens: 50 }, { output: 100 }), {
    temperature: 0,
    maxResponseTokens: 20,
  })
  assert.deepEqual(samplingOptions({ temperature: 'hot', max_tokens: 0 }), {})
})

test('text documents are decoded locally, others are not', () => {
  assert.equal(isTextDocument('text/markdown'), true)
  assert.equal(isTextDocument('application/json'), true)
  assert.equal(isTextDocument('application/pdf'), false)
  assert.equal(decodeTextDocument(Buffer.from('﻿hello', 'utf8')), 'hello')
})

test('parsedDocument / answerStarted read the agent route document items', () => {
  const done = {
    type: 'response.output_item.done',
    item: { type: 'veniceai:document_parsing', source_media_id: 'm1', status: 'completed', filename: 'report.pdf', extracted_text: 'QUOKKA-2210' },
  }
  assert.deepEqual(parsedDocument(done), { mediaId: 'm1', filename: 'report.pdf', status: 'completed', text: 'QUOKKA-2210' })
  assert.equal(parsedDocument({ type: 'response.output_item.added', item: done.item }), null)
  assert.equal(answerStarted({ type: 'response.output_item.added', item: { type: 'message' } }), true)
  assert.equal(answerStarted({ type: 'response.output_item.added', item: { type: 'veniceai:document_parsing' } }), false)
  const request = documentExtractionRequest([{ mediaId: 'm1', filename: 'report.pdf' }], 'deepseek-v4-1-flash-uncensored')
  assert.deepEqual(request.messages[0].content[0], { type: 'input_file', media_id: 'm1', filename: 'report.pdf' })
})

const streamOf = (text) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text))
      controller.close()
    },
  })

async function drain(generator) {
  const live = []
  for (;;) {
    const step = await generator.next()
    if (step.done) return { state: step.value, live }
    live.push(step.value)
  }
}

test('collectStream reads the classic stream: live content, serving model, terminal', async () => {
  const { state, live } = await drain(collectStream(streamOf(PONG), { route: 'classic', emulatedTools: false, request: {} }, (delta) => delta))
  assert.equal(state.answer, 'PONG')
  assert.equal(state.terminal, true)
  assert.equal(state.servedModel, 'qwen3-5-35b-a3b')
  assert.deepEqual(live, [{ content: 'P' }, { content: 'ONG' }])
})

test('collectStream reports the model the agent route really used', async () => {
  const sse = [
    'event: response.output_item.added',
    'data: {"output_index":1,"item":{"type":"message","id":"agent-node:llm:0"}}',
    '',
    'event: response.output_text.delta',
    'data: {"output_index":1,"delta":"PONG"}',
    '',
    'event: response.output_item.done',
    'data: {"output_index":1,"item":{"type":"message","id":"agent-node:llm:0","status":"completed","model_id":"deepseek-v4-1-flash-uncensored"}}',
    '',
    'event: response.completed',
    'data: {"response":{"status":"completed"}}',
    '',
    '',
  ].join('\n')
  const { state } = await drain(collectStream(streamOf(sse), { emulatedTools: true, request: {} }, () => null))
  assert.equal(state.text, 'PONG')
  assert.equal(state.servedModel, 'deepseek-v4-1-flash-uncensored')
})

test('collectStream notices an agent-route compaction and keeps its summary out of the answer', async () => {
  // shape of a real stream (deepseek-v4-1-flash-uncensored, a 1.5M-character
  // prompt, 2026-11-25), summary shortened
  const sse = [
    'event: veniceai:context_compaction.in_progress',
    'data: {"item_id":"compact_1","message_count":1,"output_index":0}',
    '',
    'event: response.output_item.added',
    'data: {"output_index":0,"item":{"type":"veniceai:compaction","id":"compact_1","status":"completed","summary":"## Summary\\nUser provided content.","original_token_count":469383,"message_count":1}}',
    '',
    'event: response.output_item.done',
    'data: {"output_index":0,"item":{"type":"veniceai:compaction","id":"compact_1","status":"completed","summary":"## Summary\\nUser provided content.","original_token_count":469383,"message_count":1}}',
    '',
    'event: veniceai:context_compaction.done',
    'data: {"item_id":"compact_1","messages_compacted":1,"media_count":0,"output_index":0}',
    '',
    'event: response.output_item.added',
    'data: {"output_index":2,"item":{"type":"message","id":"agent-node:llm:0"}}',
    '',
    'event: response.output_text.delta',
    'data: {"output_index":2,"delta":"CODE=UNKNOWN"}',
    '',
    'event: response.output_item.done',
    'data: {"output_index":2,"item":{"type":"message","id":"agent-node:llm:0","status":"completed","model_id":"deepseek-v4-1-flash-uncensored"}}',
    '',
    'event: response.completed',
    'data: {"response":{"status":"completed"}}',
    '',
    '',
  ].join('\n')
  const { state } = await drain(collectStream(streamOf(sse), { emulatedTools: false, request: {} }, (delta) => delta))
  assert.equal(state.answer, 'CODE=UNKNOWN')
  assert.deepEqual(state.compacted, { originalTokens: 469383, summaryChars: 33 })
})

test('agent-route models: the window stops before Venice compacts, the classic window applies when forced', () => {
  for (const id of ['deepseek-v4-1-flash-uncensored', 'deepseek-v4-1-flash', 'z-ai-glm-5-3-flash']) {
    const model = MODELS[id]
    assert.ok(model.window < model.context, id)
    // the compaction trigger counts characters: ~77% of the context at 3.2 characters a token,
    // and the proxy counts 4 characters a token
    assert.ok(model.window <= (model.context * 0.77 * 3.2) / 4, id)
    assert.equal(windowFor(model), model.window)
    assert.equal(windowFor(model, 'classic'), model.classicWindow)
  }
  assert.equal(windowFor(MODELS['qwen3-5-35b-a3b'], 'classic'), 40000)
  assert.equal(windowFor(MODELS['zai-org-glm-5.2']), undefined)
})

test('openCodeModel: the classic window is the context limit, with room left for the conversation', async () => {
  const { openCodeModel } = await import('../src/lib/models.mjs')
  const small = openCodeModel(MODELS['qwen3-coder-480b-a35b-instruct-turbo'])
  assert.deepEqual(small.limit, { context: 40000, output: 8000 })
  const full = openCodeModel(MODELS['zai-org-glm-5.2'])
  assert.deepEqual(full.limit, { context: 1000000, output: 131072 })
  assert.deepEqual(openCodeModel(MODELS['deepseek-v4-1-flash-uncensored'], 'agent').limit, { context: 300000, output: 60000 })
  assert.deepEqual(openCodeModel(MODELS['deepseek-v4-1-flash-uncensored'], 'classic').limit, { context: 35000, output: 7000 })
  for (const model of Object.values(MODELS)) {
    for (const route of ['agent', 'classic']) {
      const { limit } = openCodeModel(model, route)
      assert.ok(limit.context - limit.output >= limit.context * 0.75, model.name)
    }
  }
})

test('classicReader: the 900-second wall-clock cut is an error, not a finished answer', () => {
  // the last lines of a real classic stream (z-ai-glm-5-3-flash, maxResponseTokens 200000, 2026-11-25)
  const text = [
    '{"content":"46996\n","kind":"content"}',
    '{"kind":"error","code":"stream_over_activity_timeout","error":"Streaming request exceeded the 900 second wall-clock limit."}',
    '',
  ].join('\n')
  const events = feedAll(classicReader(), text)
  assert.equal(events.at(-1).type, 'error')
  assert.match(events.at(-1).message, /900 second/)
  assert.ok(!events.some((event) => event.type === 'response.completed'))
})
