import { MockHomeAssistant, normalizeDevices, stateLabel } from './home.mjs';
import * as providers from './providers.mjs';

export function planDecision(stage, devices) {
  const { answers: a } = stage;
  const used = ['intent'];
  const intent = a.intent.choice;
  if (intent === 'information_request') return { intent, used, targets: [], services: [] };
  used.push('compound');
  if (a.compound.noul >= 0.5) return { intent: 'compound', used, targets: [], services: [] };
  used.push('scope', 'device_type');
  const scope = a.scope.choice;
  const kind = a.device_type.choice;
  let targets;
  if (scope === 'specific_device') {
    used.push('device');
    targets = devices.filter(d => d.id === a.device.choice && d.kind === kind);
  } else if (scope === 'area') {
    used.push('room');
    targets = devices.filter(d => d.room === a.room.choice && d.kind === kind);
  } else targets = devices.filter(d => d.kind === kind);
  if (!targets.length) return { intent, used, targets: [], services: [], message: 'No matching device in this home. Try a listed room or device.' };
  if (intent === 'smarthome_query') return { intent, used, targets, services: [] };
  const actionKey = `${kind}_action`;
  used.push(actionKey);
  const action = a[actionKey].choice;
  const services = targets.map(device => {
    const domain = device.entity_id.split('.')[0];
    const data = { entity_id: device.entity_id };
    let service = action;
    if (kind === 'thermostat') { service = 'set_hvac_mode'; data.hvac_mode = { ac_on: 'cool', heat_on: 'heat', turn_off: 'off' }[action]; }
    if (action === 'dim') {
      service = 'turn_on';
      const amount = stage.command.match(/\b(\d{1,3})\s*%/);
      data.brightness_pct = amount ? Math.min(100, Number(amount[1])) : Math.max(1, Math.round(device.attributes.brightness / 255 * 50));
    }
    return { domain, service, data };
  });
  return { intent, used, targets, services };
}

export async function runRequest({ command, devices: input, context = 'none' }, dependencies = providers, signal) {
  if (typeof command !== 'string' || !command.trim() || command.trim().length > 1500) throw new Error('Enter a command between 1 and 1,500 characters.');
  if (!['none', 'devices'].includes(context)) throw new Error('Choose a valid device context.');
  command = command.trim();
  const started = performance.now();
  const devices = normalizeDevices(input);
  const home = new MockHomeAssistant(devices);
  const stages = [];
  const initial = await dependencies.evaluate(command, devices, context, signal);
  const firstPlan = planDecision(initial, devices);
  stages.push({ ...initial, used: firstPlan.used });
  let plans = [firstPlan];
  if (firstPlan.intent === 'information_request') stages.push(await dependencies.answerQuestion(command, signal));
  else if (firstPlan.intent === 'compound') {
    const split = await dependencies.splitCommand(command, signal);
    stages.push(split);
    const parallelStarted = performance.now();
    const evaluated = await Promise.all(split.commands.map(part => dependencies.evaluate(part, devices, context, signal)));
    const parallelDurationMs = Math.round(performance.now() - parallelStarted);
    plans = evaluated.map(part => planDecision(part, devices));
    if (plans.some(plan => plan.intent === 'compound' || plan.intent === 'information_request')) throw new Error('One sub-command could not be resolved into a home action or query. Send it separately. No devices were changed.');
    stages.push(...evaluated.map((part, index) => ({ ...part, used: plans[index].used, parallel: true, parallelDurationMs })));
  }
  // Evaluate the whole batch before applying any services. Failed network/split calls
  // therefore cannot leave the client's mock home partially changed.
  const messages = [];
  for (const plan of plans) {
    if (plan.message) messages.push(plan.message);
    if (plan.intent === 'smarthome_query') {
      const current = home.getStates();
      messages.push(...plan.targets.map(target => { const d = current.find(d => d.entity_id === target.entity_id); return `${d.name}: ${stateLabel(d)}.`; }));
    }
    for (const { domain, service, data } of plan.services) home.callService(domain, service, data);
  }
  if (messages.length) stages.push({ kind: 'result', provider: 'Mock Home Assistant', text: messages.join('\n') });
  return { command, context, stages, devices: home.getStates(), calls: home.calls,
    changed: [...new Set(home.calls.map(call => call.service_data.entity_id))], durationMs: Math.round(performance.now() - started),
    outcome: home.calls.length ? `${home.calls.length} mock ${home.calls.length === 1 ? 'device' : 'devices'} updated.` : messages.join(' ') || 'Assistant response ready.' };
}
