import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createAgent } from '../../src/agent.ts';

const faux = fauxProvider({ provider: 'openai', models: [{ id: 'test' }], tokensPerSecond: 1 });
faux.setResponses([fauxAssistantMessage([fauxText('This model response must be interrupted before it completes')])]);
const models = createModels(); models.setProvider(faux.provider);
const harness = await Harness.open(await openNodeSqliteStorage(process.argv[2]), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
const agent = createAgent(harness, 'test');
void agent.answer('telegram/chat1', 'event1', 'Hello');
const timer = setInterval(() => {
  if (faux.state.callCount > 0) {
    clearInterval(timer);
    process.send?.('generating');
  }
}, 10);
