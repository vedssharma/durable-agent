import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import {
  AssistantEntry, Harness, createRegistry, defineDoc, configure,
} from '@earendil-works/pi-durable';
import type { ConversationId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const context = BACKGROUND_CONTEXT;
const Routes = defineDoc<{ conversations: Record<string, number> }>({
  kind: 'app.channel-routes', version: 1, scope: 'session',
  initial: () => ({ conversations: {} }),
});

export interface Agent {
  answer(key: string, requestId: string, text: string): Promise<string>;
  close(): Promise<void>;
}

export function createAgent(harness: Harness, modelId: string): Agent {
  return {
    async answer(key, requestId, text) {
      // Route and conversation are created in the same durable commit.
      const id = await harness.commit(async tx => {
        const routes = await tx.doc(Routes);
        if (routes.conversations[key] !== undefined) return routes.conversations[key] as ConversationId;
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        await configure(tx, conversation.id, {
          model: { provider: 'openai', modelId },
          tools: [],
          instructions: 'You are a helpful personal assistant. This conversation is isolated from other chats. Be concise. You have no external action tools; never claim to have taken actions you cannot perform.',
        });
        routes.conversations[key] = conversation.id;
        return conversation.id;
      }, context);
      const conversation = await harness.conversation(id, context);
      if (!conversation) throw new Error('Stored conversation is missing');
      const submission = await conversation.submit({ type: 'input', content: text, requestId }, context);
      const settled = await submission.wait(context);
      if (settled.status !== 'done' || settled.type !== 'input') {
        return 'I could not complete this request. Please try again.';
      }
      const entry = await conversation.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
      const message = entry?.model?.[0];
      if (!message || message.role !== 'assistant') throw new Error('Missing assistant answer');
      return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        || 'I could not produce a text response.';
    },
    close: () => harness.close(context),
  };
}

export async function openAgent(file: string, modelId: string): Promise<Agent> {
  const models = createModels();
  models.setProvider(openaiProvider());
  if (!models.getModel('openai', modelId)) throw new Error(`Model not found in installed catalog: ${modelId}`);
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
  const storage = await openNodeSqliteStorage(file);
  const harness = await Harness.open(storage, {
    models, registry: createRegistry(), settings: { compaction: { enabled: true }, retry: { maxRetries: 3 } },
  }, context);
  harness.resume();
  return createAgent(harness, modelId);
}
