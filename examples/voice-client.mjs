// Transcript-only reference adapter. This can control real devices after "yes".
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createChatClient, createHttpTransport } from '../custom_components/typesafe_chat/www/chat-client.js';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const deviceId = option('--device');
if (!deviceId || deviceId.startsWith('--') || !process.env.HA_URL || !process.env.HA_TOKEN) {
  console.error('Set HA_URL and HA_TOKEN, then use --device ID with --locations, --location ID, or --thread ID.');
  process.exit(1);
}
const client = createChatClient({ client: { kind: 'voice', deviceId }, transport: createHttpTransport({ baseUrl: process.env.HA_URL, token: () => process.env.HA_TOKEN }) });
let result = await client.call('bootstrap');
if (args.includes('--locations')) { for (const room of result.rooms) console.log(`${room.id}\t${room.name}`); process.exit(0); }
const resume = option('--thread');
result = resume ? await client.call('open', { threadId: resume }) : await client.call('new', { ...(option('--location') ? { location: option('--location') } : {}) });
const threadId = result.conversation.id;
console.log(`Conversation: ${threadId}\nType a transcript, /location ID, /cancel, /recover, /archive, or /quit. "yes" applies a proposal.`);
const terminal = createInterface({ input: stdin, output: stdout });
try {
  while (true) {
    const text = (await terminal.question('You: ')).trim();
    if (text === '/quit') break;
    if (!text) continue;
    let op = 'send'; let fields = { threadId, text, ...(result.reply?.elicitation?.type === 'confirmation' ? { confirmationId: result.reply.elicitation.id } : {}) };
    if (text.startsWith('/location ')) { op = 'location'; fields = { threadId, location: text.slice(10).trim() }; }
    else if (['/cancel', '/recover', '/archive'].includes(text)) { op = { '/cancel': 'cancel', '/recover': 'open', '/archive': 'archive' }[text]; fields = { threadId }; }
    const request = client.prepare(op, fields);
    try {
      result = await client.execute(request);
      console.log(`Home: ${result.reply?.speech || result.reply?.text || (result.replayed ? 'Request already handled. Use /recover to inspect the conversation.' : 'Updated.')}`);
      if (result.reply?.elicitation?.type === 'location') for (const room of result.reply.elicitation.options) console.log(`  /location ${room.id} — ${room.name}`);
      if (result.conversation.archived) break;
    } catch (error) { console.error(`${error.code || 'transport_error'}: ${error.message}\nUse /recover before repeating an action. No request was automatically retried.`); }
  }
} finally { terminal.close(); }
