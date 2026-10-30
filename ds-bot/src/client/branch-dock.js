import { createElement as h, useEffect, useState } from 'react'
import { BotMark } from './mark.js'
import { Elapsed } from './cells.js'
import { t } from './i18n.js'

export function BranchDock({ sessionId, useRoster, useWork, actions }) {
  const roster = useRoster(value => value)
  const work = useWork(value => value)
  const [closedLimit, setClosedLimit] = useState(20)
  useEffect(() => { setClosedLimit(20) }, [sessionId])
  const task = roster.tasks?.find(task => task.id === roster.taskSessions?.[sessionId])
  if (task) return h(TaskHeader, { task, sessionId, roster, work, actions })
  const bot = roster.byId[sessionId]
  if (!bot || sessionId !== (bot.sessionId ?? bot.id)) return null
  const branches = Object.values(bot.workBranches ?? {}).filter(branch => branch.state !== 'closed')
  const tasks = (roster.tasks ?? []).filter(task => task.participants[bot.id])
  const closed = tasks.filter(task => task.state !== 'open')
    .sort((a, b) => (b.closedAt ?? b.updatedAt ?? b.openedAt) - (a.closedAt ?? a.updatedAt ?? a.openedAt))
  if (!branches.length && !tasks.length) return null
  const taskButton = task => {
    const participant = task.participants[bot.id]
    const endpoint = participant.kind === 'trunk' ? bot.sessionId ?? bot.id : task.sessions[bot.id]
    const status = work.tasks?.[task.id]?.status ?? (task.state === 'open' ? task.phase === 'ready' ? 'Needs close' : 'Creating' : task.state)
    const target = roster.byId[task.requester === bot.id ? task.assignee : task.requester]
    const suffix = participant.kind === 'trunk' ? t('Main chat') : t('Task Session')
    return h('button', { key: task.id, type: 'button', className: 'bt-mw-pill', disabled: !endpoint || (task.state === 'open' && task.phase !== 'ready'),
      'aria-label': `${t('Open task')}: ${task.title}`, onClick: () => actions.openBranch(endpoint),
      title: `${task.id}\n${task.title}\n${endpoint ?? t('Creating')}` },
    h('span', { className: 'bt-mw-pill-in' },
      target ? h(BotMark, { bot: target, size: 24 }) : null,
      h('span', { className: 'bt-branch-label' }, `${task.title} · ${t(status)} · ${suffix}${task.lateReplies.count ? ` · ${t('Late results')}: ${task.lateReplies.count}` : ''}`),
      h(Elapsed, { at: task.openedAt })))
  }
  return h('div', { className: 'bt-branch-dock', 'aria-label': t('Tasks') },
    ...tasks.filter(task => task.state === 'open').map(taskButton), ...branches.map(branch => {
    const target = roster.byId[branch.targetBotId]
    const status = branch.state === 'open' ? work.branches?.[branch.sessionId] ?? 'Needs close' : branch.state === 'failed' ? 'Failed' : 'Creating'
    return h('button', { key: branch.id, type: 'button', className: 'bt-mw-pill', disabled: !branch.sessionId,
      onClick: () => actions.openBranch(branch.sessionId), title: branch.title },
    h('span', { className: 'bt-mw-pill-in' },
      target ? h(BotMark, { bot: target, size: 24 }) : null,
      h('span', { className: 'bt-branch-label' }, `${target?.name ?? ''} · ${branch.title} · ${t(status)}`),
      h(Elapsed, { at: branch.openedAt })))
  }), closed.length ? h('details', { key: bot.id, className: 'bt-closed-tasks' },
    h('summary', null, `${t('Closed tasks')} (${closed.length})`),
    h('div', { className: 'bt-closed-task-list' }, ...closed.slice(0, closedLimit).map(taskButton),
      closed.length > closedLimit ? h('button', { type: 'button', className: 'bt-mini',
        onClick: () => setClosedLimit(limit => limit + 20) }, t('More tasks')) : null)) : null)
}

export function TaskHeader({ task, sessionId, roster, work, actions }) {
  return h('section', { className: 'bt-task-header', 'aria-label': t('Task details') },
    h('div', { className: 'bt-task-title' }, h('strong', null, task.title),
      h('span', { className: 'bt-chip' }, t(task.state === 'open' ? 'In progress' : task.state))),
    h('div', { className: 'bt-task-brief' }, task.brief),
    h('div', { className: 'bt-task-participants', 'aria-label': t('Participants') },
      Object.entries(task.participants).map(([botId, participant]) => {
        const bot = roster.byId[botId]
        const endpoint = participant.kind === 'trunk' ? bot?.sessionId ?? botId : task.sessions[botId]
        const since = work.turns?.[endpoint]
        const working = since !== undefined
        const label = `${bot?.name ?? botId} · ${t(working ? 'Working' : 'Idle')}`
        return h('div', { key: botId, className: 'bt-task-participant' },
          endpoint && endpoint !== sessionId ? h('button', { type: 'button', className: 'bt-mini',
            'aria-label': `${t('Open task')}: ${bot?.name ?? botId}`, onClick: () => actions.openBranch(endpoint) }, label)
            : h('span', null, label),
          h(Elapsed, { at: since ?? task.updatedAt ?? task.openedAt }))
      })))
}

export const BRANCH_CSS = `
.bt-task-header{border:1px solid var(--bt-line);background:var(--bt-card);border-radius:12px;padding:12px 16px;max-height:32vh;overflow:auto;font-size:13px;line-height:18px}
.bt-task-title,.bt-task-participant{display:flex;align-items:center;gap:8px;overflow-wrap:anywhere}
.bt-task-title{justify-content:space-between}
.bt-task-brief{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}
.bt-task-participants{display:flex;flex-wrap:wrap;gap:8px 16px;color:var(--bt-ink-2)}
.bt-closed-tasks{width:100%;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-closed-tasks summary{cursor:pointer;padding:6px 0;min-height:28px;box-sizing:border-box}
.bt-closed-task-list{display:flex;flex-wrap:wrap;gap:8px;max-height:200px;overflow:auto;padding:4px 0}
.bt-branch-dock{display:flex;flex-wrap:wrap;gap:8px;padding:4px 0;max-width:100%}
.bt-branch-dock .bt-mw-pill{max-width:100%}
.bt-branch-dock .bt-mw-pill-in{flex:1;min-width:0}
.bt-branch-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bt-branch-dock button:focus-visible,.bt-branch-summary button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-branch-summary{border:1px solid var(--bt-line);background:var(--bt-card);border-radius:12px;padding:12px 16px;white-space:pre-wrap;overflow-wrap:anywhere}
@media(prefers-reduced-motion:reduce){.bt-branch-dock .bt-mw-pill{animation:none;transition:none}}
`
