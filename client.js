window.__ModuleLoader__.load({
  id: '@local/dsh-restart-button',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const SOFT_ROUTE = '/plugins/dsh-restart-button/__reload'
    const HARD_ROUTE = '/plugins/dsh-restart-button/__restart'
    const STATE_ROUTE = '/plugins/dsh-restart-button/__state'
    /** The host refuses a write without it, so another document cannot drive this. */
    const HEADER = { 'x-dsh-restart-button': '1' }
    const NS = 'dsh-restart-button'

    /**
     * When this document evaluated its copy of the Client code.
     *
     * Paired with the file stamp the host reports, this is what answers "is the
     * page still running old Client code" honestly. The module graph cannot
     * answer it: an entry's `rev` only moves when the HMR watch rebuilds the
     * bundle, so a hand-edited client.js leaves the graph identical while the
     * page keeps running yesterday's code.
     */
    const LOADED_AT = Date.now()

    const zh = {
      reloadTitle: '刷新插件',
      restartTitle: '完全重启',
      working: '正在刷新…',
      reloaded: '插件已刷新',
      reloadFailed: '刷新失败',
      restarting: '正在重启…',
      restartFailed: '重启失败'
    }
    const en = {
      reloadTitle: 'Reload plugins',
      restartTitle: 'Restart app',
      working: 'Reloading…',
      reloaded: 'Plugins reloaded',
      reloadFailed: 'Reload failed',
      restarting: 'Restarting…',
      restartFailed: 'Restart failed'
    }

    const styles = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        height: '28px',
        minWidth: '28px',
        padding: '0 6px',
        border: 'none',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        font: 'inherit'
      },
      working: { color: 'var(--dsw-alias-brand-primary)', cursor: 'progress' },
      done: { color: 'var(--dsw-alias-state-success-primary)' },
      needsRestart: { color: 'var(--dsw-alias-state-warn-primary)' },
      failed: { color: 'var(--dsw-alias-state-error-primary)' },
      text: { fontSize: '12px', whiteSpace: 'nowrap' }
    }

    /**
     * Progress lives at module scope, not in component state.
     *
     * The sidebar footer re-projects its actions on every store update, so this
     * button is mounted fresh for each render pass and component state would be
     * thrown away between clicks. The client module itself is evaluated once per
     * page load, so a module-level store is what actually survives a remount --
     * which also makes the second click land, when a second click is needed.
     *
     * States: idle -> working -> reloaded (then back to idle)
     *                       \-> needsRestart (the next click restarts for real)
     *                       \-> failed (then back to idle)
     *         needsRestart -> restarting (the window is about to go away)
     */
    const HOLD_MS = 3000
    // Long enough for the "reloaded" label to be read before the document
    // goes away, since reloading a page is a visible interruption.
    const RELOAD_HOLD_MS = 1200
    /**
     * Two stamps from the same machine can still disagree by a tick: the file
     * mtime comes from the filesystem's clock, LOADED_AT from the page's. A page
     * that loaded after an edit would otherwise reload itself once for nothing.
     */
    const CLOCK_SLACK_MS = 1000
    /**
     * The pending page reload, kept apart from `store.timer`.
     *
     * `store.timer` belongs to the state machine: it returns the button to idle
     * after a hold. Sharing it would either cancel the reload or leave the
     * button stuck in a state that no longer means anything.
     */
    let reloadTimer
    const store = {
      state: 'idle',
      listeners: new Set(),
      timer: undefined,
      snapshot() {
        return store.state
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
      clearTimer() {
        if (store.timer !== undefined) {
          clearTimeout(store.timer)
          store.timer = undefined
        }
      },
      set(next, holdMs) {
        if (store.state === next) return
        store.state = next
        store.clearTimer()
        if (typeof holdMs === 'number') {
          store.timer = setTimeout(() => store.set('idle'), holdMs)
        }
        for (const listener of store.listeners) listener(next)
      },
      reset() {
        store.clearTimer()
        if (reloadTimer !== undefined) {
          clearTimeout(reloadTimer)
          reloadTimer = undefined
        }
        store.listeners.clear()
        store.state = 'idle'
      }
    }

    /** One plugin-reload attempt. Resolves to the host's answer, never throws. */
    async function reloadPlugins() {
      try {
        const response = await fetch(SOFT_ROUTE, { method: 'POST', headers: HEADER })
        const body = await response.json().catch(() => ({}))
        if (response.ok !== true) {
          return { ok: false, error: body?.error ?? `HTTP ${response.status}` }
        }
        // A restart reason means the new generation cannot be published in
        // place: the honest answer is that this one needs the full restart.
        if (body?.restartReason !== undefined && body.restartReason !== null) {
          return { ok: false, needsRestart: true, error: String(body.restartReason) }
        }
        // The host reports when client.js last changed on disk. If that is newer
        // than this document's own evaluation time, this page is running the
        // previous generation and only a new document can fix it. An unknown
        // stamp (null) is not evidence of staleness, so it never reloads.
        const stamp = typeof body?.clientStamp === 'number' ? body.clientStamp : null
        return {
          ok: true,
          warnings: body?.warnings ?? [],
          pending: body?.pending ?? [],
          pageStale: stamp !== null && stamp > LOADED_AT + CLOCK_SLACK_MS
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** A real app restart. On success the window disappears, so the state is left held. */
    async function restartApp() {
      try {
        const response = await fetch(HARD_ROUTE, { method: 'POST', headers: HEADER })
        if (response.ok !== true) {
          const body = await response.json().catch(() => ({}))
          store.set('restartFailed', HOLD_MS)
          return
        }
        // Deliberately stay in 'restarting': the app is going down, and an idle
        // button would invite a second press while the helper is still working.
      } catch {
        store.set('restartFailed', HOLD_MS)
      }
    }

    function Icon(props) {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: props.spin === true ? { animation: 'dsh-restart-spin 900ms linear infinite' } : null
        },
        h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.7-3.97' }),
        h('path', { d: 'M13.6 2.2v3.1h-3.1' })
      )
    }

    function labelOf(state, t) {
      switch (state) {
        case 'working':
          return t('working')
        case 'reloaded':
          return t('reloaded')
        case 'needsRestart':
          return t('restartTitle')
        case 'failed':
          return t('reloadFailed')
        case 'restarting':
          return t('restarting')
        case 'restartFailed':
          return t('restartFailed')
        default:
          return t('reloadTitle')
      }
    }

    function styleOf(state) {
      switch (state) {
        case 'working':
          return Object.assign({}, styles.button, styles.working)
        case 'reloaded':
          return Object.assign({}, styles.button, styles.done)
        case 'needsRestart':
          return Object.assign({}, styles.button, styles.needsRestart)
        case 'failed':
        case 'restartFailed':
          return Object.assign({}, styles.button, styles.failed)
        case 'restarting':
          return Object.assign({}, styles.button, styles.working)
        default:
          return styles.button
      }
    }

    const BUSY = new Set(['working', 'restarting'])

    function Control(props) {
      const t = props.t
      const [state, setState] = React.useState(store.snapshot())

      React.useEffect(() => {
        // Pick up whatever the store already holds: a remount while a reload is
        // running, or while the app is going down, must not look idle again.
        setState(store.snapshot())
        return store.subscribe(setState)
      }, [])

      const onClick = React.useCallback(() => {
        const now = store.snapshot()
        if (BUSY.has(now)) return
        // The one deliberate escalation: once a reload has told us the new
        // generation cannot be published in place, this button becomes the
        // restart button. A click in that state is the user agreeing to it.
        if (now === 'needsRestart') {
          store.set('restarting')
          void restartApp()
          return
        }
        store.set('working')
        void reloadPlugins().then((result) => {
          if (result.ok === true) {
            store.set('reloaded', HOLD_MS)
            // Only when the host proved the Client graph changed: the running
            // page is then one generation behind and reloading the document is
            // the only way to pick the new Client code up. Same URL, so the
            // session, scroll position and drafts come back with it.
            if (result.pageStale === true) {
              // Held in its own slot: the "reloaded" hold timer still owns
              // store.timer, and stealing it would leave a dead end state if
              // the document never goes away.
              reloadTimer = setTimeout(() => {
                const location = typeof window === 'undefined' ? undefined : window.location
                if (typeof location?.reload === 'function') location.reload()
                else store.set('idle')
              }, RELOAD_HOLD_MS)
            }
          } else if (result.needsRestart === true) store.set('needsRestart')
          else store.set('failed', HOLD_MS)
        })
      }, [])

      const wide = props.wide === true
      const label = labelOf(state, t)
      const busy = BUSY.has(state)

      return h(
        'button',
        {
          type: 'button',
          title: label,
          'aria-label': label,
          'aria-busy': busy,
          'data-state': state,
          disabled: busy,
          onClick,
          style: styleOf(state)
        },
        h(Icon, { spin: busy }),
        h('span', {
          // A wide footer shows text always; a narrow one only speaks up when
          // there is something to say, so the icon row stays quiet.
          style: Object.assign({}, styles.text, wide || state !== 'idle' ? null : { display: 'none' })
        }, label)
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const offZh = ctx.locale.register(NS, 'zh', zh)
          const offEn = ctx.locale.register(NS, 'en', en)
          return () => {
            offZh()
            offEn()
          }
        }, 'dsh-restart-button: dictionaries')

        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          // The spin is a CSS animation, which cannot be expressed inline; it is
          // registered and removed here so it never outlives the plugin.
          const style = document.createElement('style')
          style.textContent = '@keyframes dsh-restart-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }'
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-restart-button: animation')

        ctx.slots.inject('sidebar.footer.action', () => {
          const component = (props) => h(Control, Object.assign({}, props, { t }))
          return ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-restart-button',
              order: 90,
              label: () => t(store.snapshot() === 'needsRestart' ? 'restartTitle' : 'reloadTitle')
            },
            component
          )
        })

        ctx.effect(() => () => store.reset(), 'dsh-restart-button: progress state')
      }
    }
  }
})
