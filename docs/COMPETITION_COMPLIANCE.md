# Competition Compliance Snapshot

- Task: `GOV-001`
- Snapshot date: 2026-08-24
- Competition: Somnia x DreamDEX Event Contracts Hackathon
- Internal cutoff: 2026-09-08 15:00 UTC
- Official deadline basis: current DoraHacks event metadata and search-visible event listing indicate the deadline corresponds to 2026-09-08 18:00 UTC. Some UI/listing surfaces may render this as local time, for example 2026/09/08 11:00 in a UTC-7 context.

## Sources Checked

- Official event page: https://dorahacks.io/hackathon/event-contracts/detail
- Official event listing/Q&A: https://dorahacks.io/hackathon/event-contracts and https://dorahacks.io/hackathon/event-contracts/qa
- DoraHacks Terms: https://dorahacks.io/legal/terms
- Somnia network info: https://docs.somnia.network/developer/network-info
- DreamDEX Event Contract contracts: https://docs.dreamdex.io/developers/event-contracts/contracts-and-addresses

## Current Authority Result

`ATT-ELIG-001` remains the entrant eligibility evidence. No current official rule was found that requires organizer approval for generative-AI development tooling. The stricter implementation control remains a fresh dedicated public GitHub repository, owned/permissive assets only, no secrets, public HTTPS demo plus local Docker fallback, and final submission-form recheck.

## Controlled Items

- Team: single entrant until official team constraints are clarified.
- Newness: EdgeLab product-specific code starts in this dedicated repository after handoff activation.
- License: MIT is currently applied after repository dependency/license compatibility review; no event-specific OSS mandate was found in the checked sources.
- KYC/prize: no implementation impact unless requested through authenticated official channels.
- Deployment: public HTTPS target plus local Docker fallback.
- Shannon faucet operations: implementation notes observed public faucet support for `50 STT` and `500 tUSDC` per 24 hours on chain `50312`; recheck faucet availability and token metadata before final video capture.

## GOV-001 Result

PASS for implementation baseline. Any later official rule conflict enters change control.
