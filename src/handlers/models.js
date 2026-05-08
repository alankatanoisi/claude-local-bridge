'use strict';

/**
 * GET /v1/models
 * Returns an OpenAI-compatible model listing of the currently advertised models.
 *
 * The catalog can now come from:
 * - the original local Claude bridge models
 * - provider-backed catalogs like OpenCode Go
 * - or a hybrid of both, depending on settings
 */

const { getAdvertisedModels } = require('../catalog');
const { sendJson } = require('../utils');

async function handleModels(ctx, _req, res) {
  const now = Math.floor(Date.now() / 1000);
  const advertised = await getAdvertisedModels(ctx);
  const models = advertised.map((m) => ({
    id: m.id,
    object: 'model',
    created: now,
    owned_by: m.owned_by,
    context_length: m.context_length,
    output_length: m.output_length,
  }));
  sendJson(res, 200, { object: 'list', data: models });
}

module.exports = { handleModels };
