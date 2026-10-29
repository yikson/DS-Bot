// Cordis emit() does not await listeners; Node timers also ignore returned promises.
// Keep the catch at these boundaries while preserving synchronous middleware results.
const scopes = new WeakMap()

export function asyncScope(rt) {
  if (scopes.has(rt)) return scopes.get(rt)
  const ctx = rt.ctx ?? {}
  const timers = new Set()
  const immediates = new Set()
  const controller = new AbortController()
  let stopped = false
  const report = (label, error) => {
    try {
      if (rt.warn) rt.warn('ds-bot: %s failed: %s', label, error)
      else ctx.logger?.warn('ds-bot: %s failed: %s', label, error)
    } catch { /* A failed logger must not turn a handled failure into a fatal one. */ }
  }
  const guard = (label, callback, propagate = false) => function (...args) {
    try {
      const result = callback.apply(this, args)
      if (!result || typeof result.then !== 'function') return result
      const pending = Promise.resolve(result)
      const handled = pending.catch(error => report(label, error))
      // Awaited middleware must still refuse a tool or turn. emit() can safely
      // ignore the same rejection because its reporting handler is already attached.
      return propagate ? pending : handled
    } catch (error) {
      report(label, error)
      if (propagate) {
        const pending = Promise.reject(error)
        pending.catch(() => {})
        return pending
      }
    }
  }
  const clear = (timer) => {
    clearTimeout(timer)
    timers.delete(timer)
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const task of immediates) clearImmediate(task)
    immediates.clear()
    controller.abort()
  }
  const schedule = (repeat, callback, ms, args) => {
    if (stopped) return
    const invoke = guard(repeat ? 'interval' : 'timeout', callback)
    const timer = (repeat ? setInterval : setTimeout)(() => {
      if (!repeat) timers.delete(timer)
      if (!stopped) return invoke(...args)
    }, ms)
    timers.add(timer)
    return timer
  }
  const scope = {
    get stopped() { return stopped },
    signal: controller.signal,
    stop,
    run(label, callback) {
      if (!stopped) return guard(label, callback)()
    },
    on(name, callback, ...options) {
      if (stopped) return
      const invoke = guard(`listener ${name}`, callback, true)
      const listener = function (...args) {
        if (!stopped) return invoke.apply(this, args)
      }
      Object.defineProperty(listener, 'length', { value: callback.length })
      Object.defineProperty(listener, 'name', { value: callback.name })
      return ctx.on?.(name, listener, ...options)
    },
    effect(callback, label, owner = ctx) {
      return owner.effect?.(guard(label ?? 'effect', () => {
        const dispose = callback()
        return typeof dispose === 'function' ? guard(`${label ?? 'effect'} disposal`, dispose) : dispose
      }, true), label)
    },
    setTimeout: (callback, ms, ...args) => schedule(false, callback, ms, args),
    setInterval: (callback, ms, ...args) => schedule(true, callback, ms, args),
    setImmediate(callback, ...args) {
      if (stopped) return
      const invoke = guard('immediate', callback)
      const task = setImmediate(() => {
        immediates.delete(task)
        if (!stopped) return invoke(...args)
      })
      immediates.add(task)
      return task
    },
    clearTimeout: clear,
    clearInterval: clear,
    // Awaited delays also settle on disposal, so clearing a timer never strands a job.
    delay(ms, signal) {
      return new Promise((resolve) => {
        if (stopped) return resolve(false)
        const abortSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
        if (abortSignal.aborted) return resolve(false)
        const finish = (elapsed) => {
          clear(timer)
          abortSignal.removeEventListener('abort', abort)
          resolve(elapsed)
        }
        const abort = () => finish(false)
        const timer = scope.setTimeout(() => finish(true), ms)
        abortSignal.addEventListener('abort', abort, { once: true })
      })
    },
    async race(job, ms, value) {
      const cancel = new AbortController()
      try {
        return await Promise.race([job, scope.delay(ms, cancel.signal).then(() => value)])
      } finally {
        cancel.abort()
      }
    },
  }
  scopes.set(rt, scope)
  ctx.effect?.(() => stop, 'ds-bot: async callbacks')
  return scope
}
