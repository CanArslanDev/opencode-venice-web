import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { DOCUMENT_BYTES_PER_TOKEN, UNKNOWN_IMAGE_TOKENS, countTokens, imageDimensions, imageTokens, promptTokens } from '../src/lib/emulate.mjs'
import { staleConfigHint } from '../src/lib/models.mjs'

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0)
  return Buffer.concat([head, data, crc])
}

/** A solid-colour RGB PNG; `metadata` adds a tEXt chunk of that many bytes. */
function png(width, height, metadata = 0) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)])
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(metadata ? [chunk('tEXt', Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.alloc(metadata, 0x41)]))] : []),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const dataUrl = (bytes, type = 'image/png') => `data:${type};base64,${bytes.toString('base64')}`
const withImage = (bytes) => [{ role: 'user', content: [{ type: 'text', text: 'describe it' }, { type: 'image_url', image_url: { url: dataUrl(bytes) } }] }]

test('two PNGs with the same pixels and different metadata cost the same tokens', () => {
  const plain = png(800, 600)
  const tagged = png(800, 600, 200_000)
  assert.ok(tagged.length > plain.length + 190_000)
  assert.deepEqual(imageDimensions(plain), imageDimensions(tagged))
  assert.equal(promptTokens(withImage(plain)), promptTokens(withImage(tagged)))
  // and the image is far below what its base64 would count as text
  assert.ok(promptTokens(withImage(tagged)) < countTokens(dataUrl(tagged)) / 50)
  // the same image as an OpenAI file part
  const asFile = [{ role: 'user', content: [{ type: 'text', text: 'describe it' }, { type: 'file', file: { filename: 'a.png', file_data: dataUrl(tagged) } }] }]
  assert.equal(promptTokens(asFile), promptTokens(withImage(plain)))
})

test('image tokens follow the pixel size', () => {
  assert.equal(imageTokens(png(512, 512)), 85 + 170) // one tile
  assert.equal(imageTokens(png(1024, 1024)), 85 + 170 * 4) // short side to 768: 2x2 tiles
  assert.equal(imageTokens(png(4000, 1000)), 85 + 170 * 4) // fit in 2048: 2048x512, 4x1 tiles
  assert.equal(imageTokens(Buffer.from('not an image')), UNKNOWN_IMAGE_TOKENS)
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x58, 0x03, 0x20, 3, 0, 0, 0])
  assert.deepEqual(imageDimensions(jpeg), { width: 800, height: 600 })
  const gif = Buffer.from('GIF89a\x20\x03\x58\x02', 'latin1')
  assert.deepEqual(imageDimensions(gif), { width: 800, height: 600 })
})

test('long text is still counted in full', () => {
  const text = 'word '.repeat(80_000) // 400k characters
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: text },
  ]
  const tokens = promptTokens(messages)
  assert.ok(tokens >= 100_000, String(tokens))
  assert.ok(tokens < 100_100, String(tokens))
  // text in parts, beside an image, counts the same text plus only the image
  const mixed = [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: dataUrl(png(512, 512)) } }] }]
  assert.equal(promptTokens(mixed), 4 + countTokens(text) + imageTokens(png(512, 512)))
  // a long prompt still trips the window check, an image alone does not
  assert.match(staleConfigHint('qwen3-5-35b-a3b', promptTokens(messages), 'classic'), /past|reads about 40000/)
  assert.equal(staleConfigHint('qwen3-5-35b-a3b', promptTokens(withImage(png(800, 600, 400_000))), 'classic'), null)
})

test('tool calls and tool results count; older images count as their placeholder', () => {
  const image = dataUrl(png(800, 600, 100_000))
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'image_url', image_url: { url: image } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: 'x'.repeat(400) }) } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'y'.repeat(800) },
    { role: 'user', content: 'next' },
  ]
  const expected = 4 * 4 + countTokens('first\n[image]') + countTokens('read') + countTokens(messages[1].tool_calls[0].function.arguments) + 200 + countTokens('next')
  assert.equal(promptTokens(messages), expected)
})

test('documents: text files by their text, binary ones by a share of their bytes, extracted text when known', () => {
  const text = 'line of notes\n'.repeat(1000)
  const md = [{ role: 'user', content: [{ type: 'file', file: { filename: 'notes.md', file_data: `data:text/markdown;base64,${Buffer.from(text).toString('base64')}` } }] }]
  assert.equal(promptTokens(md), 4 + countTokens('notes.md') + countTokens(text))
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32_000, 1)])
  const pdf = [{ role: 'user', content: [{ type: 'file', file: { filename: 'r.pdf', file_data: `data:application/pdf;base64,${pdfBytes.toString('base64')}` } }] }]
  assert.equal(promptTokens(pdf), 4 + countTokens('r.pdf') + Math.ceil(pdfBytes.length / DOCUMENT_BYTES_PER_TOKEN))
  const hex = createHash('sha256').update(pdfBytes).digest('hex')
  const mediaId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  assert.equal(promptTokens(pdf, { texts: new Map([[mediaId, 'extracted '.repeat(100)]]) }), 4 + countTokens('r.pdf') + countTokens('extracted '.repeat(100)))
  // an attachment the request refuses does not break the count
  const zip = [{ role: 'user', content: [{ type: 'file', file: { filename: 'a.zip', file_data: 'data:application/zip;base64,UEsDBA==' } }] }]
  assert.equal(promptTokens(zip), 4 + countTokens('[file: a.zip]'))
})
