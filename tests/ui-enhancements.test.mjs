import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/ui.css', import.meta.url), 'utf8')

test('modern UI features remain local-first and keep compatibility IDs', () => {
  for (const id of [
    'sourceInput', 'outputMode', 'outputJson', 'detectedBadge', 'generateAgentBtn',
    'copyBtn', 'downloadBtn', 'downloadSplitBtn', 'previewRows', 'previewMeta', 'prettyJson'
  ]) assert.match(html, new RegExp(`id="${id}"`))

  assert.match(html, /<script id="theme-init">/)
  assert.match(html, /<link rel="stylesheet" href="\/ui\.css">/)
  assert.match(html, /meta name="description"/)
  assert.match(html, /property="og:title"/)
  assert.match(html, /id="historyEnabled" type="checkbox"/)
  assert.match(html, /historyEnabled: false/)
  assert.match(html, /HISTORY_LIMIT = 6/)
  assert.match(html, /historyEnableConfirm/)
  assert.match(css, /html\[data-theme="dark"\]/)
  assert.match(css, /@media \(max-width: 760px\)/)
  assert.match(css, /prefers-reduced-motion: reduce/)
})
