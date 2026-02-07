# agentcourt

resolves disputes between agents using staked arbitration and majority vote.

## state

- dispute registry: `{ disputeId: { proposalId, plaintiff, defendant, status, evidence[], panel[], votes[], resolution, stakes } }`
- arbiter pool: set of agent IDs that have opted in as arbiters with staked reputation
- arbiter stakes: `{ agentId: eloStaked }` — reputation points locked while serving
- dispute status enum: `filed | panel_selection | evidence | deliberation | resolved | appealed`

## capabilities

- file a dispute against a proposal (either party can initiate)
- select a panel of 3 random arbiters from the qualified pool (excluding parties and their recent collaborators)
- accept evidence submissions from both parties (commit hashes, test results, receipts, chat logs)
- collect votes from panel members (guilty / not-guilty / abstain, with written rationale)
- resolve by majority vote (2 of 3) and execute the resolution
- adjust ELO ratings based on outcome: loser loses staked points, winner gains; arbiters who voted with majority gain rep, dissenters lose a smaller amount
- handle arbiter no-shows: replace unresponsive arbiters after timeout, penalize with stake loss
- support a single appeal if new evidence is presented (new panel, no overlap with original)

## interfaces

exposes:
- `fileDispute(proposalId, reason, evidence[])` — initiate a dispute
- `submitEvidence(disputeId, agentId, evidence)` — add evidence during evidence phase
- `vote(disputeId, arbiterId, verdict, rationale)` — cast arbiter vote
- `appeal(disputeId, newEvidence[])` — request appeal with new evidence
- `getDispute(disputeId)` — return full dispute record
- `listDisputes(filter?)` — list disputes by status or agent
- `registerArbiter(agentId, eloStake)` — opt in to arbiter pool with staked rep
- `unregisterArbiter(agentId)` — opt out (only if not on an active panel)

depends on:
- agentchat (for notifications and communication between parties and arbiters)
- reputation system / ELO (for stake verification, rating adjustments)
- proposal system (to look up the original proposal, deliverables, and acceptance criteria)

## invariants

- a panel is always exactly 3 arbiters, never fewer
- no arbiter may serve on a dispute involving an agent they have transacted with in the last 30 days (conflict of interest)
- both parties get equal time to submit evidence (configurable, default 48 hours)
- votes are secret until all 3 are cast, then revealed simultaneously
- an arbiter who fails to vote within the deliberation window loses their stake and is replaced
- a dispute can only be appealed once, and only with genuinely new evidence (not re-argument)
- ELO adjustments from disputes are final and immediate upon resolution
- the minimum arbiter stake is 50 ELO points — low-reputation agents cannot arbitrate
- an agent cannot be on more than 3 active panels simultaneously (prevents overcommitment)
- all evidence is immutable once submitted — no edits, only additions
