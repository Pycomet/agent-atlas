import Anthropic from '@anthropic-ai/sdk';
import type { ClassifyModel } from './llm.js';

/** Cheap bulk classification — the spec's explicit model choice (§4.3). */
export const CLASSIFIER_MODEL = 'claude-haiku-4-5';

export function createAnthropicModel(modelId: string = CLASSIFIER_MODEL): ClassifyModel {
  const client = new Anthropic();
  return {
    async complete({ system, user, schema }) {
      const response = await client.messages.create({
        model: modelId,
        max_tokens: 8000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: {
          format: { type: 'json_schema', schema },
        },
      });
      const text = response.content.find((block) => block.type === 'text');
      return text !== undefined ? (JSON.parse(text.text) as unknown) : null;
    },
  };
}
