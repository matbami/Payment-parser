# Payment Instruction Processor

This service parses and validates natural-language payment instructions such as:

```bash
DEBIT 2000 NGN FROM ACCOUNT ACC-001 FOR CREDIT TO ACCOUNT ACC-002
DEBIT 500 USD FROM ACCOUNT WALLET01 FOR CREDIT TO ACCOUNT WALLET02 ON 2025-01-02
```


It performs:

- Structural keyword validation  
- Amount and currency checks  
- Account existence checks  
- Balance validation  
- Scheduled (future date) processing  
- Final balance updates  
- Detailed error reporting with codes  

---



## 1. Folder Structure
```bash
services/payment-processor/
├── parse-instruction.js
messages/
├── payment.js
endpoints/payment-instructions/
├── process.js
```

---

## 2. How It Works

When the endpoint receives a POST request, the controller forwards the payload to:


The parser:

1. Validates payload shape using a schema.
2. Splits the instruction into keywords.
3. Confirms correct ordering of required keywords.
4. Extracts the debit account, credit account, amount, currency, and optional execution date.
5. Performs all business validations:
   - supported currencies  
   - account existence  
   - matching currencies  
   - sufficient balance  
6. Applies balance changes (unless scheduled).
7. Returns a normalized response with status codes.

---

## 3. Expected Request Body

```json
{
  "accounts": [
    { "id": "ACC-001", "balance": 5000, "currency": "NGN" },
    { "id": "ACC-002", "balance": 1500, "currency": "NGN" }
  ],
  "instruction": "DEBIT 2000 NGN FROM ACCOUNT ACC-001 FOR CREDIT TO ACCOUNT ACC-002"
}
```
---
## 4. Example Successful Response
```json
{
  "type": "DEBIT",
  "amount": 2000,
  "currency": "NGN",
  "debit_account": "ACC-001",
  "credit_account": "ACC-002",
  "execute_by": null,
  "status": "successful",
  "status_code": "AP00",
  "status_reason": "Transaction executed successfully",
  "accounts": [
    { "id": "ACC-001", "balance": 3000, "balance_before": 5000, "currency": "NGN" },
    { "id": "ACC-002", "balance": 3500, "balance_before": 1500, "currency": "NGN" }
  ]
}
```

---
## 5. Example Error (SY02 – Invalid keyword order)

Request
```json

{
  "accounts": [
    { "id": "ACC-01", "balance": 1000, "currency": "NGN" },
    { "id": "ACC-02", "balance": 2000, "currency": "NGN" }
  ],
  "instruction": "DEBIT NGN 2000 FROM ACCOUNT ACC-01 FOR CREDIT TO ACCOUNT ACC-02"
}

```

Response

```json

{
  "status": "failed",
  "status_code": "SY02",
  "status_reason": "Invalid keyword order"
}

```



## 6. How to Test Locally

**1. Start your server:**
```bash
npm run dev
```

**Step 2 — Send a Test Request:**

```bash
POST /payment-instructions
```


**with a body like**
```json
{
  "accounts": [
    { "id": "ACC-001", "balance": 4000, "currency": "NGN" },
    { "id": "ACC-002", "balance": 500,  "currency": "NGN" }
  ],
  "instruction": "DEBIT 1000 NGN FROM ACCOUNT ACC-001 FOR CREDIT TO ACCOUNT ACC-002"
}
```

## 7. STATUS CODES
| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| SY01 | Missing keyword                              |
| SY02 | Invalid keyword order                        |
| SY03 | Malformed instruction                        |
| AM01 | Invalid amount                               |
| CU01 | Account currency mismatch                    |
| CU02 | Unsupported currency                         |
| AC01 | Insufficient funds                           |
| AC02 | Debit and credit accounts cannot be the same |
| AC03 | Account not found                            |
| AC04 | Invalid account ID format                    |
| DT01 | Invalid date format (must be YYYY-MM-DD)     |
| AP00 | Transaction executed successfully            |
| AP02 | Transaction scheduled for future execution   |












