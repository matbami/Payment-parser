const validator = require('@app-core/validator');
const { throwAppError } = require('@app-core/errors');
const { appLogger } = require('@app-core/logger');
const PaymentMessages = require('@app/messages/payment');

const spec = `root {
  accounts[] {
    id string
    balance number
    currency string
  }
  instruction string
}`;

const parsedSpec = validator.parse(spec);

/**
 * Breaks the instruction into words while removing empty spaces.
 */
function splitData(data) {
  return data.split(' ').filter(Boolean);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Ensures an account ID contains only allowed characters.
 */
function isValidAccountId(accountId) {
  for (let i = 0; i < accountId.length; i++) {
    const char = accountId[i];
    const validAccount =
      (char >= 'A' && char <= 'Z') ||
      (char >= 'a' && char <= 'z') ||
      (char >= '0' && char <= '9') ||
      char === '-' ||
      char === '.' ||
      char === '@';
    if (!validAccount) return false;
  }
  return true;
}

/**
 * Validates that keywords in the instruction appear in the right order.
 * Accepted patterns:
 *
 * DEBIT X Y FROM ACCOUNT A FOR CREDIT TO ACCOUNT B
 * CREDIT X Y TO ACCOUNT B FOR DEBIT FROM ACCOUNT A
 */
function isOutOfOrder(keywords, type) {
  if (type === 'DEBIT') {
    const expected = [
      'DEBIT',
      null,
      null,
      'FROM',
      'ACCOUNT',
      null,
      'FOR',
      'CREDIT',
      'TO',
      'ACCOUNT',
    ];
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] && keywords[i]?.toUpperCase() !== expected[i]) return true;
    }
  }

  if (type === 'CREDIT') {
    const expected = [
      'CREDIT',
      null,
      null,
      'TO',
      'ACCOUNT',
      null,
      'FOR',
      'DEBIT',
      'FROM',
      'ACCOUNT',
    ];
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] && keywords[i]?.toUpperCase() !== expected[i]) return true;
    }
  }

  if (keywords[11] && keywords[11].toUpperCase() !== 'ON') return true;

  return false;
}

function buildErrorResponse(err, parsed) {
  return {
    type: parsed.type || null,
    amount: parsed.amount || null,
    currency: parsed.currency || null,
    debit_account: parsed.debit_account || null,
    credit_account: parsed.credit_account || null,
    execute_by: parsed.execute_by || null,
    status: 'failed',
    status_reason: err.message,
    status_code: err.errorCode,
    accounts: parsed.accounts || [],
  };
}

/**
 * Main instruction parser.
 * Validates the payload, extracts keywords, performs business logic checks,
 * and returns either a processed instruction or an error response.
 */
async function parseInstruction(serviceData) {
  const parsed = {
    type: null,
    amount: null,
    currency: null,
    debit_account: null,
    credit_account: null,
    execute_by: null,
    accounts: [],
  };

  let data;

  try {
    data = validator.validate(serviceData, parsedSpec);
    const raw = splitData(data.instruction);

    const keywords = raw.map((word, index) =>
      index === 5 || index === 10 ? word : word.toUpperCase()
    );

    if (keywords.length < 8) {
      throwAppError(PaymentMessages.SY01, 'SY01');
    }
    if (keywords[0] !== 'DEBIT' && keywords[0] !== 'CREDIT') {
      throwAppError(PaymentMessages.SY03, 'SY03');
    }

    if (isOutOfOrder(keywords, keywords[0])) {
      throwAppError(PaymentMessages.SY02, 'SY02');
    }

    // Extract debit/credit roles based on instruction type
    const [type, , , , , debitAccId, , , , , creditAccId] = keywords;
    parsed.type = type;
    parsed.debit_account = type === 'DEBIT' ? debitAccId : creditAccId;
    parsed.credit_account = type === 'DEBIT' ? creditAccId : debitAccId;

    // Validate & parse amount
    const amount = Number(keywords[1]);
    parsed.amount = amount;
    if (Number.isNaN(amount) || amount <= 0 || !isPositiveInteger(amount))
      throwAppError(PaymentMessages.AM01, 'AM01');

    // Validate currency
    const supported = ['NGN', 'USD', 'GBP', 'GHS'];
    const currency = keywords[2].toUpperCase();
    parsed.currency = currency;
    if (!supported.includes(currency)) {
      throwAppError(PaymentMessages.CU02, 'CU02');
    }

    if (!isValidAccountId(keywords[5]) || !isValidAccountId(keywords[10])) {
      throwAppError(PaymentMessages.AC04, 'AC04');
    }

    if (keywords[11] && keywords[11].toUpperCase() === 'ON') {
      const dateString = keywords[12];
      if (
        !dateString ||
        dateString.length !== 10 ||
        dateString[4] !== '-' ||
        dateString[7] !== '-'
      ) {
        throwAppError(PaymentMessages.DT01, 'DT01');
      }

      parsed.execute_by = dateString;
    }

    const { accounts } = data;

    const debitAcc = accounts.find((a) => a.id === parsed.debit_account);
    const creditAcc = accounts.find((a) => a.id === parsed.credit_account);

    if (!debitAcc || !creditAcc) {
      throwAppError(PaymentMessages.AC03, 'AC03');
    }
    if (debitAcc.currency !== creditAcc.currency) {
      throwAppError(PaymentMessages.CU01, 'CU01');
    }
    if (parsed.currency !== debitAcc.currency.toUpperCase()) {
      throwAppError(PaymentMessages.CU01, 'CU01');
    }

    if (parsed.debit_account === parsed.credit_account) {
      throwAppError(PaymentMessages.AC02, 'AC02');
    }
    if (debitAcc.balance < parsed.amount) {
      throwAppError(PaymentMessages.AC01, 'AC01');
    }

    // Capture original balances
    const debitBefore = debitAcc.balance;
    const creditBefore = creditAcc.balance;

    let status = 'successful';
    let statusCode = 'AP00';

    // Schedule future date implementation
    if (parsed.execute_by) {
      const today = new Date().toISOString().slice(0, 10);
      if (parsed.execute_by > today) {
        status = 'pending';
        statusCode = 'AP02';
      }
    }

    // Apply balance changes only for immediate transactions
    if (status === 'successful') {
      debitAcc.balance -= parsed.amount;
      creditAcc.balance += parsed.amount;
    }

    parsed.accounts = [
      {
        id: debitAcc.id,
        balance: debitAcc.balance,
        balance_before: debitBefore,
        currency: debitAcc.currency,
      },
      {
        id: creditAcc.id,
        balance: creditAcc.balance,
        balance_before: creditBefore,
        currency: creditAcc.currency,
      },
    ];

    return {
      ...parsed,
      status,
      status_code: statusCode,
      status_reason: status === 'successful' ? PaymentMessages.AP00 : PaymentMessages.AP02,
    };
  } catch (error) {
    appLogger.errorX(error, 'parse-instruction-error');

    // Attempt to attach account details even during failure
    if (parsed.debit_account && parsed.credit_account && data?.accounts) {
      const debitAcc = data.accounts.find((a) => a.id === parsed.debit_account);
      const creditAcc = data.accounts.find((a) => a.id === parsed.credit_account);

      parsed.accounts = [
        debitAcc
          ? {
              id: debitAcc.id,
              balance: debitAcc.balance,
              balance_before: debitAcc.balance,
              currency: debitAcc.currency,
            }
          : null,
        creditAcc
          ? {
              id: creditAcc.id,
              balance: creditAcc.balance,
              balance_before: creditAcc.balance,
              currency: creditAcc.currency,
            }
          : null,
      ].filter(Boolean);
    }

    return buildErrorResponse(error, parsed);
  }
}

module.exports = parseInstruction;
