// Drives client.js' real component with a toy React, a stubbed fetch and a
// controllable clock: the button's press sequence, with no browser involved.
//
//   node test/second-press.test.mjs
//
// Every case re-evaluates the module, because the store lives at module scope:
// in the app that scope is one document, and a fresh document is what a fresh
// case means.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = fs.readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

let clock = 1_000_000
const realNow = Date.now
Date.now = () => clock

function loadFresh() {
  const slots = []
  let cursor = 0
  function useState(initial) {
    const i = cursor++
    if (slots[i] === undefined) slots[i] = { value: initial }
    const slot = slots[i]
    return [slot.value, (v) => { slot.value = typeof v === 'function' ? v(slot.value) : v }]
  }
  function useEffect(fn) {
    const i = cursor++
    if (slots[i] === undefined) slots[i] = { cleanup: fn() }
  }
  function useCallback(fn) { cursor++; return fn }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState, useEffect, useCallback
  }

  const fakeDocument = {
    head: { appendChild() {} },
    body: {},
    createElement: () => ({ textContent: '', style: {}, remove() {} })
  }
  let mod
  const windowStub = { __ModuleLoader__: { load: (m) => { mod = m } }, location: { reload() {} } }
  new Function('window', 'document', src)(windowStub, fakeDocument)

  const requests = []
  const state = { responses: [] }
  globalThis.fetch = async (url) => {
    requests.push(url)
    const next = state.responses.shift() ?? { ok: true, body: { warnings: [], pending: [], clientStamp: null } }
    return { ok: next.ok !== false, status: next.ok === false ? 500 : 200, json: async () => next.body ?? {} }
  }

  const plugin = mod.factory((id) => (id === 'react' ? React : {}))
  let Registered
  plugin.apply({
    effect: (fn) => { fn(); return () => {} },
    locale: { register: () => () => {}, bind: () => (t) => t },
    slots: { inject: (_name, cb) => cb(), register: (_spec, comp) => { Registered = comp } }
  })

  function render() {
    cursor = 0
    let node = Registered({ t: (k) => k, wide: true })
    while (typeof node?.type === 'function') node = node.type(node.props)
    return node
  }

  return {
    requests,
    state,
    button: render,
    label: () => render().children[1].children[0],
    press: () => { render().props.onClick() },
    flush: () => new Promise((r) => setTimeout(r, 0))
  }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// --- case 1: the first press reloads, the repeat press restarts --------------
{
  const p = loadFresh()
  check('idle label is reloadTitle', p.label() === 'reloadTitle', p.label())
  p.press(); await p.flush()
  check('press 1: reload route', p.requests.length === 1 && p.requests[0].endsWith('/__reload'), p.requests.join(','))
  check('press 1: state reloaded', p.button().props['data-state'] === 'reloaded', p.button().props['data-state'])
  await wait(3200) // past HOLD_MS: back to idle, still armed
  check('after the hold the button offers the restart', p.label() === 'restartTitle', p.label())
  clock += 1000
  p.press(); await p.flush()
  check('press 2: restart route', p.requests[1]?.endsWith('/__restart') === true, p.requests.join(','))
  check('press 2: state restarting', p.button().props['data-state'] === 'restarting', p.button().props['data-state'])
}

// --- case 2: the host says the generation needs a restart --------------------
{
  const p = loadFresh()
  p.state.responses = [{ ok: true, body: { restartReason: 'module-comparison' } }]
  p.press(); await p.flush()
  check('case 2: the first press still reloads', p.requests[0]?.endsWith('/__reload') === true, p.requests.join(','))
  check('case 2: state needsRestart', p.button().props['data-state'] === 'needsRestart', p.button().props['data-state'])
  clock += 1000
  p.press(); await p.flush()
  check('case 2: the second press restarts', p.requests[1]?.endsWith('/__restart') === true, p.requests.join(','))
}

// --- case 3: a double click is not a decision --------------------------------
{
  const p = loadFresh()
  p.press()
  clock += 100
  p.press()
  await p.flush()
  check('case 3: a double click makes one request', p.requests.length === 1, p.requests.join(','))
}

// --- case 4: a failed reload does not arm the button ------------------------
{
  const p = loadFresh()
  p.state.responses = [{ ok: false, body: { error: 'boom' } }]
  p.press(); await p.flush()
  check('case 4: the failure is reported', p.label() === 'reloadFailed', p.label())
  clock += 1000
  p.press(); await p.flush()
  check('case 4: the next press retries the reload', p.requests[1]?.endsWith('/__reload') === true, p.requests.join(','))
}

Date.now = realNow
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
