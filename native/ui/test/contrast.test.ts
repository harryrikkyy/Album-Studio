// Scope: authored tokens and specific text rules, not a whole-app accessibility certification.
// Oklab inverse matrix: https://bottosson.github.io/posts/oklab/ (public domain).
// Contrast: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

type RGBA = [number, number, number, number]
const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8')
const clamp = (v: number) => Math.min(1, Math.max(0, v))
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
function colour(value: string): RGBA {
  const [L = 0, C = 0, h = 0, alpha = 1] = value
    .replace(/oklch\(|\)/g, '')
    .trim()
    .split(/[\s/]+/)
    .map(Number)
  const a = C * Math.cos((h * Math.PI) / 180),
    b = C * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    encode(clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    encode(clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    encode(clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
    alpha,
  ]
}
function over(fg: RGBA, bg: RGBA): RGBA {
  return [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    1,
  ]
}
const luminance = (c: RGBA) => 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2])
function ratio(a: RGBA, b: RGBA) {
  const x = luminance(a),
    y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
function rule(selector: string, property: string) {
  const start = styles.indexOf(`${selector} {`)
  assert.ok(start >= 0, `Missing ${selector}`)
  const block = styles.slice(start, styles.indexOf('}', start))
  const value = new RegExp(`${property}:\\s*([^;]+);`).exec(block)?.[1]
  assert.ok(value, `Missing ${property} in ${selector}`)
  return value
}
test('contrast calculations retain standard black/white and neutral-grey references', () => {
  assert.equal(ratio([0, 0, 0, 1], [1, 1, 1, 1]), 21)
  assert.ok(Math.abs(luminance(colour('oklch(0.5 0 0)')) - 0.125) < 1e-7)
})
for (const theme of ['studio-dark', 'studio-light']) {
  test(`${theme}: content, status, primary actions, and menu text meet 4.5:1`, () => {
    const start = tokens.indexOf(`[data-theme="${theme}"]`),
      block = tokens.slice(start, tokens.indexOf('}', start))
    const palette = new Map(
      [...block.matchAll(/--([a-z0-9-]+):\s*(oklch\([^;]+\));/g)].map((m) => [m[1]!, colour(m[2]!)]),
    )
    const get = (key: string) => {
      const value = palette.get(key)
      assert.ok(value, `Missing ${key}`)
      return value
    }
    const resolve = (value: string) => (value.startsWith('var(') ? get(value.slice(6, -1)) : colour(value))
    const failures: string[] = []
    const check = (label: string, fg: RGBA, bg: RGBA) => {
      const value = ratio(fg, bg)
      if (value < 4.5) failures.push(`${label}: ${value.toFixed(3)}:1`)
    }
    for (const bg of ['bg-app', 'bg-panel', 'bg-raised', 'bg-hover', 'bg-active', 'bg-well']) {
      for (const ink of ['ink', 'ink-2', 'ink-3']) check(`${ink}/${bg}`, get(ink), get(bg))
    }
    check('primary', get('accent-ink'), get('accent'))
    check('primary hover', get('accent-ink'), get('accent-hover'))
    for (const status of ['ok', 'warn', 'danger'])
      check(`${status} notice`, get(status), over(get(`${status}-soft`), get('bg-raised')))
    check('inspector keyboard hints', resolve(rule('.insp-hint', 'color')), get('bg-panel'))
    const hintAlpha = Number(rule('.menu__hint', 'opacity'))
    check(
      'menu shortcut hints',
      over([...get('ink').slice(0, 3), hintAlpha] as RGBA, get('bg-raised')),
      get('bg-raised'),
    )
    check(
      'focused menu shortcut hints',
      over([...get('accent-ink').slice(0, 3), hintAlpha] as RGBA, get('accent')),
      get('accent'),
    )
    check(
      'danger menu hover',
      resolve(rule('.menu__item.is-danger:hover:not(:disabled), .menu__item.is-danger:focus-visible', 'color')),
      get('danger'),
    )
    assert.deepEqual(failures, [])
  })
}
