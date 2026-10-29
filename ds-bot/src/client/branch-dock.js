import { createElement as h } from 'react'
import { BotMark } from './mark.js'
import { Elapsed } from './cells.js'
import { t } from './i18n.js'

export function BranchDock({ sessionId, useRoster, useWork, actions }) {
  const roster = useRoster(value => value)
  const work = useWork(value => value)
  const bot = roster.byId[sessionId]
  if (!bot || sessionId !== (bot.sessionId ?? bot.id)) return null
  const branches = Object.values(bot.workBranches ?? {}).filter(branch => branch.state !== 'closed')
  if (!branches.length) return null
  return h('div', { className: 'bt-branch-dock', 'aria-label': t('Work branches') }, branches.map(branch => {
    const target = roster.byId[branch.targetBotId]
    const status = branch.state === 'open' ? work.branches?.[branch.sessionId] ?? 'Needs close' : branch.state === 'failed' ? 'Failed' : 'Creating'
    return h('button', { key: branch.id, type: 'button', className: 'bt-mw-pill', disabled: !branch.sessionId,
      onClick: () => actions.openBranch(branch.sessionId), title: branch.title },
    h('span', { className: 'bt-mw-pill-in' },
      target ? h(BotMark, { bot: target, size: 24 }) : null,
      h('span', { className: 'bt-branch-label' }, `${target?.name ?? ''} · ${branch.title} · ${t(status)}`),
      h(Elapsed, { at: branch.openedAt })))
  }))
}

export const BRANCH_CSS = `
.bt-branch-dock{display:flex;flex-wrap:wrap;gap:8px;padding:4px 0;max-width:100%}
.bt-branch-dock .bt-mw-pill{max-width:100%}
.bt-branch-dock .bt-mw-pill-in{flex:1;min-width:0}
.bt-branch-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bt-branch-dock button:focus-visible,.bt-branch-summary button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-branch-summary{border:1px solid var(--bt-line);background:var(--bt-card);border-radius:12px;padding:12px 16px;white-space:pre-wrap;overflow-wrap:anywhere}
@media(prefers-reduced-motion:reduce){.bt-branch-dock .bt-mw-pill{animation:none;transition:none}}
`
