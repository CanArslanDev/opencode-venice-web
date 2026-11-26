/**
 * Document input: OpenAI chat `file` parts travel as `input_file` parts with
 * their bytes, like images (docs/PROTOCOL.md §2c).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AttachmentError,
  FILE_NOTE,
  IMAGE_NOTE,
  MAX_FILES,
  attachmentFromFilePart,
  documentType,
  splitImages,
  textOf,
  toVeniceRequest,
  withRetryReminder,
} from '../src/lib/emulate.mjs'
import { multipartBody } from '../src/lib/venice.mjs'
import { DEFAULT_MODEL, MODELS, openCodeModel } from '../src/lib/models.mjs'

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
// the shape @ai-sdk/openai-compatible sends for an attached PDF (captured from `opencode run -f report.pdf`)
const filePart = (filename, data, type) => ({ type: 'file', file: { filename, file_data: `data:${type};base64,${Buffer.from(data).toString('base64')}` } })
const text = (value) => ({ type: 'text', text: value })
const tool = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } })

test('documentType takes text/*, the web upload list, and the extension for a generic type', () => {
  assert.equal(documentType('application/pdf', 'a.pdf'), 'application/pdf')
  assert.equal(documentType('text/markdown; charset=utf-8', 'a.md'), 'text/markdown')
  assert.equal(documentType('text/x-python', 'a.py'), 'text/x-python')
  assert.equal(documentType('', 'Report.PDF'), 'application/pdf')
  assert.equal(documentType('application/octet-stream', 'sheet.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(documentType('application/zip', 'a.zip'), null)
  assert.equal(documentType('', 'archive.zip'), null)
})

test('a PDF file part becomes a document with its name, an image file part an image', () => {
  const pdf = attachmentFromFilePart(filePart('report.pdf', PDF, 'application/pdf'))
  assert.equal(pdf.kind, 'file')
  assert.equal(pdf.file.filename, 'report.pdf')
  assert.equal(pdf.file.mimeType, 'application/pdf')
  assert.deepEqual(pdf.file.data, PDF)
  assert.match(pdf.mediaId, /^[0-9a-f]{8}-[0-9a-f]{4}-/)
  const png = attachmentFromFilePart(filePart('dot.png', Buffer.from(PNG, 'base64'), 'image/png'))
  assert.equal(png.kind, 'image')
  assert.equal(png.image.mimeType, 'image/png')
  // raw base64 without a data URL, typed by the extension
  const raw = attachmentFromFilePart({ type: 'file', file: { filename: 'notes.md', file_data: Buffer.from('# hi').toString('base64') } })
  assert.equal(raw.file.mimeType, 'text/markdown')
})

test('a file the proxy cannot send is a 400 with the reason, never dropped', () => {
  const cases = [
    [filePart('a.zip', 'PK', 'application/zip'), /a\.zip \(application\/zip\) cannot be sent: .*pdf/],
    [{ type: 'file', file: { file_id: 'file-123', filename: 'x.pdf' } }, /file_id references are not supported/],
    [{ type: 'file', file: { filename: 'empty.pdf', file_data: 'data:application/pdf;base64,' } }, /empty/],
    [{ type: 'file', file: { filename: 'x.pdf', file_data: 'https://example.com/x.pdf' } }, /base64/],
  ]
  for (const [part, message] of cases) {
    assert.throws(() => attachmentFromFilePart(part), (error) => error instanceof AttachmentError && error.status === 400 && message.test(error.message))
  }
  const many = Array.from({ length: MAX_FILES + 1 }, (_, index) => filePart(`f${index}.txt`, `file ${index}`, 'text/plain'))
  assert.throws(() => splitImages(many), /at most 10 files/)
})

test('the request carries an input_file part named after the file, its bytes go with it', async () => {
  const mapping = toVeniceRequest({ model: DEFAULT_MODEL, messages: [{ role: 'user', content: [text('what is the code word?'), filePart('report.pdf', PDF, 'application/pdf')] }] })
  const parts = mapping.request.messages.at(-1).content
  assert.deepEqual(parts[0], { type: 'input_file', media_id: mapping.files[0].mediaId, filename: 'report.pdf' })
  assert.equal(parts[1].text, 'what is the code word?')
  assert.equal(mapping.images.length, 0)
  assert.deepEqual(mapping.media, mapping.files)
  // multipart: the file goes as media.<id> under its own name and type
  const { body, contentType } = await multipartBody(
    (() => {
      const form = new FormData()
      for (const file of mapping.media) form.append(`media.${file.mediaId}`, new Blob([file.data], { type: file.mimeType }), file.filename)
      return form
    })(),
  )
  const back = await new Response(body, { headers: { 'content-type': contentType } }).formData()
  const sent = back.get(`media.${mapping.files[0].mediaId}`)
  assert.equal(sent.name, 'report.pdf')
  assert.equal(sent.type, 'application/pdf')
})

test('with tools the file moves to the format reminder with the file note, and stays through a retry', () => {
  const mapping = toVeniceRequest({
    model: DEFAULT_MODEL,
    tools: [tool('read')],
    messages: [{ role: 'user', content: [text('summarise'), filePart('notes.md', '# notes', 'text/markdown'), { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }],
  })
  const users = mapping.request.messages.filter((message) => message.role === 'user')
  assert.ok(users[0].content.every((part) => part.type === 'output_text'))
  const last = users.at(-1).content
  assert.deepEqual(last.slice(0, 2).map((part) => part.type), ['input_image', 'input_file'])
  assert.equal(last.at(-1).text, FILE_NOTE)
  assert.notEqual(FILE_NOTE, IMAGE_NOTE)
  assert.deepEqual(mapping.media.map((item) => item.mimeType), ['image/png', 'text/markdown'])
  const retry = withRetryReminder(mapping.request)
  assert.equal(retry.messages.filter((message) => message.content.some((part) => part.type === 'input_file')).length, 1)
  assert.equal(retry.messages.at(-1).content.find((part) => part.type === 'input_file').filename, 'notes.md')
})

test('files in older turns stay as a [file: name] note and are not resent', () => {
  const mapping = toVeniceRequest({
    model: DEFAULT_MODEL,
    messages: [
      { role: 'user', content: [text('read this'), filePart('old.pdf', PDF, 'application/pdf')] },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks' },
    ],
  })
  assert.equal(mapping.files.length, 0)
  assert.match(mapping.request.messages[0].content[0].text, /\[file: old\.pdf\]/)
  assert.equal(textOf([filePart('a.pdf', PDF, 'application/pdf')]), '[file: a.pdf]')
  // an unsupported file in an older turn does not fail the request
  assert.doesNotThrow(() => toVeniceRequest({ model: DEFAULT_MODEL, messages: [{ role: 'user', content: [filePart('a.zip', 'PK', 'application/zip')] }, { role: 'user', content: 'next' }] }))
})

test('OpenCode config advertises pdf input on every model, image input on vision models', () => {
  for (const [id, model] of Object.entries(MODELS)) {
    const entry = openCodeModel(model)
    assert.equal(entry.attachment, true, id)
    assert.ok(entry.modalities.input.includes('pdf'), id)
    assert.equal(entry.modalities.input.includes('image'), !!model.vision, id)
  }
  assert.deepEqual(openCodeModel({ name: 'x', reasoning: false, context: 1, output: 1, documents: false }).modalities, undefined)
})
