# Work-branch sessions

- Date: 2026-10-29
- Related: Issue #7; depends on the Session-log recovery fix in PR #4

This note is in English at the request of the author of this port; the other notes in this folder are in Chinese.

## Why

A Bot that hands work to a teammate keeps one main chat. Every task request, reply and follow-up lands in that one Session, so a few delegated tasks fill the context window and force a new conversation part long before the Bot's own work needs one. The extra text is mostly detail that only the task needs.

A work branch moves that detail out of the main chat. The task runs in a native DSH Session fork of the owning Bot, and the main chat receives one short conclusion when the task is over.

## Decided behavior

**Opt-in pair.** The plugin option `workBranches: [["Chief", "Coder"]]` names two Bots. The first is the owner. Each name must match exactly one Bot, and the two must differ; an invalid pair is ignored and logged once. The option may list several pairs. The default is `[]`, which creates no new branches.

**Creation.** In either request direction, a new task between the pair forks the owner's main Session with `sessionController.fork`, then:

- selects the owner's model and reasoning effort for the fork (a fork otherwise starts on the profile default);
- applies the owner's permission preset, title and capabilities;
- records the fork's inherited event count, so memory review skips the inherited prefix;
- sends the task to the peer with a reply address in the branch.

An outbound task from the owner forks the owner. A new inbound request from the peer is executed in a fork of the owner and answered to the peer. If the Harness has no `fork`, the task fails with an explicit error. There is no fallback to a summary-based Session.

**Routing.** A reply goes to the branch Session that sent the task. Follow-ups made while handling a branch reply reuse its address. Outside such a turn, the peer passes `message_bot` `work: "<branch id>"` to pick an open branch, or `work: "new"` for a separate task. Without `work`, one open branch is reused. With several open branches the call is refused and lists their ids and titles. With none, a new branch is created. The prompt and `list_bots` show the current choices. Group messages, `reply_to: "user"` and unconfigured pairs keep the previous behavior. A repeated explicit `request_id` replays its receipt and never forks again. Unread requests are not merged across branches, and receipts are scoped per branch.

**Branch Session.** A branch has the owner's identity, model, permissions and working directory. It reads newer main-chat information with `read_own_chat`; nothing is broadcast into it. It does not rotate conversation parts: it inherits the main chat's context, so a branch forked from a nearly full chat has less room. Before the work grows too long, the branch closes with status `blocked` and records the continuation point, and the work continues in a new branch.

**Lifecycle.** A Main Bot can stop another Bot's running turns in open branches with `stop_bot`, even while that Bot's main chat is idle. Deleting a Bot releases the activity and clears the per-Session state of all its branches, including closed and failed ones, and archives their Sessions with `stopActivity: true`.

**Closing.** Only a branch can call `close_work_branch({status, conclusion, link?})`, with status `done`, `blocked` or `cancelled`. The whole conclusion text, including title, status, branch id and link, must fit 1000 Unicode code points. Closing writes one `branch-summary` event into the current main Session under a durable id. Delivery and startup recovery check the current and the original main Session, including consumed messages and inbox splice events, so the conclusion is delivered once. The conclusion may wake one main-Bot turn; that turn's output is extra cost. Closed branches stay readable and are not archived automatically.

**Answers.** A branch answer is stored in the work record before it is sent. The work closes only after the send and the flush succeed. A failed send is retried after 1, 2 and 4 seconds. After the retries, the stored answer stays for startup recovery. The dock shows "Delivery failed; retry pending" while an answer is outstanding.

**Restart.** At start, the host recovers every persisted branch, including when the option is now empty:

- a branch still in `creating` becomes `failed`;
- an `open` branch whose Session log cannot be read (after one retry) becomes `failed` with a blocked conclusion for the main chat;
- a pending task send, a pending answer and an undelivered conclusion are completed, or recognized as already delivered;
- interrupted branch turns resume through the existing resume path.

**Interface.** The owner's main chat shows a dock above the input with one pill per branch that is not closed: the peer's mark, the task title, its state (Working, Waiting, Needs close, Delivery failed; retry pending, Failed or Creating) and elapsed time. A pill opens that branch Session directly. The conclusion appears in the main chat as a card.

## Persisted state

Branch records live under `bot.workBranches`, keyed by branch id. Fields: `sessionId`, `trunkSessionId`, `targetBotId`, `title`, `brief`, `workIds`, `state` (`creating`, `open`, `closed`, `failed`), `openedAt`, `inheritedThrough`, and when applicable `pendingDelivery`, `closedAt`, `summaryId`, `summaryDelivered`, `conclusion`. A pending answer is stored on the work record as `pendingAnswer`. Reply routing uses `replySessionId` on message sources. A test loads records of this shape (open, closed, failed) and checks routing, recovery and closing.

## Not done

- No force close from the interface, and no automatic archive of closed branches.
- No notification push for a conclusion.
- No fallback when the Harness cannot fork.
- A branch does not rotate or recover its own context overflow.

## Known limits

- The conclusion reaches the main Bot as a message and can cost one main-Bot turn.
- An answer addressed to a branch Session that cannot be read stays pending and is never reported as delivered. Restore or inspect the Session before restarting.
- Behavior was checked with the mock model and unit tests only; real-model and installed-Desktop acceptance are still open.

## Rollback

Set `workBranches` to `[]` or remove it: no new branches are created, while existing branches keep routing and can close. Keep a compatible plugin installed until every in-flight branch has settled. Going straight back to a version that does not know branches is unsafe: replies addressed to a branch would reach the main chat, and open branch records would stay unread.
