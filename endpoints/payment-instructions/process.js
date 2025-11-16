const { createHandler } = require('@app-core/server');
const parseInstruction = require('@app/services/payment-processor/parse-instruction');

module.exports = createHandler({
  path: '/payment-instructions',
  method: 'post',

  middlewares: [],

  // Step 4: Define the handler
  async handler(rc, helpers) {
    // Step 5: Prepare service payload
    const payload = {
      ...rc.body,
    };

    // Step 6: Call your service
    const response = await parseInstruction(payload);

    // Step 7: Return response
    return {
      status: helpers.http_statuses.HTTP_200_OK,
      message: 'Instruction processed successfully',
      data: response,
    };
  },
});
