const validator = require('@app-core/validator');
const { throwAppError } = require('@app-core/errors');
const { appLogger } = require('@app-core/logger');
const PaymentMessages = require('@app/messages/payment');

// Validation Spec
const spec = `root {
  accounts[] {
    id string
    balance number
    currency string
  }
  instruction string
}`;

const parsedSpec = validator.parse(spec);

// Utility functions
function splitData(data) {
  return data.split(' ').filter(Boolean);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isValidAccountId(id) {
  for (let i = 0; i < id.length; i++) {
    const c = id[i];
    const ok =
      (c >= 'A' && c <= 'Z') ||
      (c >= 'a' && c <= 'z') ||
      (c >= '0' && c <= '9') ||
      c === '-' ||
      c === '.' ||
      c === '@';
    if (!ok) return false;
  }
  return true;
}

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
      if (expected[i] && keywords[i]?.toUpperCase() !== expected[i]) {
        return true;
      }
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
      if (expected[i] && keywords[i]?.toUpperCase() !== expected[i]) {
        return true;
      }
    }
  }

  if (keywords[11] && keywords[11].toUpperCase() !== 'ON') {
    return true;
  }

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

async function parseInstruction(serviceData) {
  let response;

  const data = validator.validate(serviceData, parsedSpec);

  const parsed = {
    type: null,
    amount: null,
    currency: null,
    debit_account: null,
    credit_account: null,
    execute_by: null,
    accounts: [],
  };

  try {
    const raw = splitData(data.instruction);

    // Normalize keywords but preserve indices 5 & 10 (account IDs)
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

    // Assign debit / credit accounts based on type
    const [type, , , , , debitAccId, , , , , creditAccId] = keywords;

    if (type === 'DEBIT') {
      parsed.debit_account = debitAccId;
      parsed.credit_account = creditAccId;
    } else {
      parsed.debit_account = creditAccId;
      parsed.credit_account = debitAccId;
    }

    parsed.type = type;

    // Amount
    const amount = Number(keywords[1]);
    parsed.amount = amount;

    if (Number.isNaN(amount) || amount <= 0 || !isPositiveInteger(amount)) {
      throwAppError(PaymentMessages.AM01, 'AM01');
    }

    // Currency
    const supported = ['NGN', 'USD', 'GBP', 'GHS'];
    const currency = keywords[2].toUpperCase();

    if (!supported.includes(currency)) {
      throwAppError(PaymentMessages.CU02, 'CU02');
    }

    parsed.currency = currency;

    // Account ID format
    if (!isValidAccountId(keywords[5]) || !isValidAccountId(keywords[10])) {
      throwAppError(PaymentMessages.AC04, 'AC04');
    }

    // Date parsing (if ON keyword exists)
    if (keywords[11] && keywords[11].toUpperCase() === 'ON') {
      const dateString = keywords[12];

      if (!dateString) {
        throwAppError(PaymentMessages.DT01, 'DT01');
      }

      if (dateString.length !== 10 || dateString[4] !== '-' || dateString[7] !== '-') {
        throwAppError(PaymentMessages.DT01, 'DT01');
      }

      parsed.execute_by = dateString;
    }

    // Accounts
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

    const debitBefore = debitAcc.balance;
    const creditBefore = creditAcc.balance;

    let status = 'successful';
    let statusCode = 'AP00';

    if (parsed.execute_by) {
      const today = new Date().toISOString().slice(0, 10);
      if (parsed.execute_by > today) {
        status = 'pending';
        statusCode = 'AP02';
      }
    }

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

    response = {
      ...parsed,
      status,
      status_code: statusCode,
      status_reason: status === 'successful' ? PaymentMessages.AP00 : PaymentMessages.AP02,
    };
  } catch (error) {
    appLogger.errorX(error, 'parse-instruction-error');

    if (parsed.debit_account && parsed.credit_account && data.accounts) {
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
      ].filter(Boolean); // remove nulls if one account not found
    }
    return buildErrorResponse(error, parsed || {});
  }

  return response;
}

module.exports = parseInstruction;
