# IVR contract: customer PIN and callback calls

Two additions to the existing `POST /api/call` / `GET /api/decision/:callId` contract.
Nothing else changes: requests and replies stay HMAC-signed, `callId` stays idempotent,
and BharatPoint still re-checks everything (the IVR is evidence, not authority).

## 1. PIN on confirmation calls

### Request (new field)

`POST /api/call` now includes `pinRequired` (boolean):

```json
{ "callId": "confirm:<authorizationId>:1", "extension": "6001", "mode": "BLIND_ENTRY",
  "txnType": "CASH_OUT", "amountRupees": 200, "pinRequired": true,
  "agentLabel": "Test AG-001, Kothapalli", "language": "te", "ringTimeoutSeconds": 30 }
```

### Call flow when `pinRequired` is true

1. Customer answers. Greet, say who is asking and what for (as today).
2. **Ask for the 4-digit PIN first**: "Enter your 4 digit PIN, then press hash." Collect exactly 4 DTMF digits.
   - Do not read the PIN back. Do not say it. Do not play it to anyone.
   - If fewer or more than 4 digits arrive, or the customer times out: reply `decision: "INVALID_INPUT"`, `keyedPin: null`.
3. Continue exactly as today: blind-entry amount, read back, press 1 to accept or 2 to decline.
4. Reply `decision: "ACCEPTED"` only if the customer pressed 1. Include the digits as `keyedPin`.

When `pinRequired` is false (customers a staff member seeded, and all callback calls), skip step 2 and omit `keyedPin`.

### Reply (new field)

`GET /api/decision/:callId` (and the 202/200 from `POST /api/call`):

```json
{ "callId": "...", "status": "COMPLETED", "decision": "ACCEPTED",
  "keyedRupees": 200, "keyedPin": "4827", "completedAt": "2026-10-14T10:00:00Z" }
```

`keyedPin` is a string of exactly four digits, or `null`/absent. It is inside the signed body, so the HMAC covers it.

### What BharatPoint does with it

| IVR reply | Result |
|---|---|
| `ACCEPTED`, `keyedPin` matches | Customer confirmation proceeds (amount still compared by BharatPoint) |
| `ACCEPTED`, `keyedPin` wrong | Payment rejected (`WRONG_PIN`), the customer's failure count goes up, an alert is raised after 2 per agent per day |
| `ACCEPTED`, `keyedPin` missing/malformed | Treated as `INVALID_INPUT`: nothing is approved, not counted as a guess |
| 3 wrong PINs | Confirmation for that customer is locked for 30 minutes (the agent gets "confirmation unavailable") |

### What the IVR must never do with the PIN

- Never write it to disk, logs, CDRs, recordings, metrics or error reports. Mask DTMF in call recordings.
- Never keep it after the reply to BharatPoint has been delivered (clear it from memory/state once `status` is final and BharatPoint has fetched it, or after a short TTL such as 5 minutes).
- Never include it in any request to anyone except in the signed reply to BharatPoint.
- Treat `/api/decision` responses as sensitive: serve them only over the signed channel, never cache them.

BharatPoint itself never stores the digits: the evidence row has `keyedPin` removed, the audit log never sees it, and the stored PIN is only a peppered scrypt hash.

### Honest limits

- DTMF is not encrypted end to end: the SIP/telephony path and the IVR host can see the digits. The PIN protects against an agent who holds the customer's phone; it does not protect against a compromised IVR or telephony provider.
- A 4-digit PIN has 10,000 values. The lockout (3 tries, 30 minutes) and the per-agent alert are what make guessing impractical, not the PIN's size.
- It does not replace biometric authentication, which a real AePS deployment needs.

## 2. Callback ("ticket") calls

An admin can ring a customer from a ticket. Same endpoints, with two differences in the request:

```json
{ "callId": "ticket:<ticketId>:1", "extension": "6001", "mode": "READBACK", "purpose": "VERIFY",
  "txnType": "CASH_OUT", "amountRupees": 200, "pinRequired": false, "...": "..." }
```

`purpose: "VERIFY"` means this call does **not** authorise anything. Word it as a question:
"Did you ask for a cash withdrawal of 200 rupees from the agent at Kothapalli? Press 1 for yes, 2 for no."

Reply `decision: "ACCEPTED"` for 1 ("yes, I made this") and `"DECLINED"` for 2 ("no, I did not"). `NO_ANSWER` and `FAILED` as usual.
BharatPoint records the answer on the ticket as evidence for the admin. It never changes a payment.
