const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function duration(ms) { return `${number.format(ms)}ms`; }
export function timing(result, target) {
  const steps = [];
  let parallelAdded = false;
  for (const stage of result.stages) {
    if (stage.kind === 'result') continue;
    if (stage.parallel) {
      if (parallelAdded) continue;
      parallelAdded = true;
      steps.push({ ...stage, provider: `${result.stages.filter(s => s.parallel).length}× TypeSafe`, durationMs: stage.parallelDurationMs });
    } else steps.push(stage);
  }
  target.replaceChildren();
  for (const [index, step] of steps.entries()) {
    if (index) target.append(el('span', 'timing-arrow', '→'));
    const text = el('span', step.kind === 'typesafe' ? 'provider-typesafe' : 'provider-llm', `${step.provider} `);
    text.append(el('b', '', duration(step.durationMs)));
    target.append(text);
  }
}

function renderQuestion(id, question, answer, used, compact) {
  const row = el('div', `question${used ? '' : ' unused'}`);
  const badge = el('span', `badge ${question.type}`, `${question.type === 'noul' ? '⊕' : '✦'} ${question.type}`);
  const main = el('div', 'question-main');
  const details = el('details');
  const summary = el('summary');
  // Keep the concise headings visible in the recording; full rubrics are expandable.
  const title = el('div', 'question-title', question.instructions.split('?')[0] + '?');
  const probabilities = el('div', 'probabilities');
  if (answer.type === 'noul') {
    probabilities.append(el('span', 'probability', `${(answer.noul * 100).toFixed(1)}% probability`));
  } else {
    const sorted = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
    for (const [option, value] of (compact ? sorted.slice(0, 6) : sorted)) probabilities.append(el('span', `probability${option === answer.choice ? ` winner${value < .8 ? ' low' : ''}` : ''}`, `${option} ${value.toFixed(2)}`));
  }
  if (compact && Object.keys(answer.probabilities || {}).length > 6) probabilities.append(el('span', 'probability', 'Expand for all options'));
  summary.append(title, probabilities);
  summary.title = used ? 'Used in this decision. Expand to inspect the prompt.' : 'Speculative answer, not used in this decision. Expand to inspect the prompt.';
  const prompt = el('div', 'prompt-details');
  prompt.append(el('p', '', used ? 'Used in this decision' : 'Not used in this decision'), el('pre', '', JSON.stringify({ question, answer }, null, 2)));
  details.append(summary, prompt);
  main.append(details);
  const value = answer.type === 'noul' ? answer.noul : answer.confidence;
  const confidence = el('span', `confidence${value < .5 ? ' low' : value < .8 ? ' medium' : ''}`, value.toFixed(2));
  confidence.title = answer.type === 'noul' ? 'Probability of yes' : 'Model confidence';
  row.dataset.question = id;
  row.dataset.used = String(used);
  row.append(badge, main, confidence);
  return row;
}

export function renderStages(result) {
  const fragment = document.createDocumentFragment();
  for (const stage of result.stages) {
    const card = el('article', 'trace-card');
    if (stage.kind === 'typesafe') {
      if (stage.parallel) card.append(el('div', 'stage-heading', `Sub-command: “${stage.command}”`));
      for (const [id, question] of Object.entries(stage.questions)) card.append(renderQuestion(id, question, stage.answers[id], stage.used.includes(id), result.live));
      card.append(el('div', 'stage-footer', `TypeSafe · ${Object.keys(stage.questions).length} prompts · ${duration(stage.durationMs)}`));
    } else {
      const content = el('div', 'response-card');
      const title = el('div', 'response-title');
      const badge = el('span', `badge ${stage.kind === 'result' ? '' : 'llm'}`, stage.kind === 'result' ? '⌂ home' : stage.mocked ? '◇ local' : '◆ llm');
      title.append(badge, document.createTextNode(stage.kind === 'split' ? (stage.mocked ? 'Local split → sub-commands' : 'LLM split → sub-commands') : stage.kind === 'result' ? 'Home response' : stage.mocked ? 'Local fallback response' : 'LLM response'));
      content.append(title);
      if (stage.commands) {
        const list = el('ol');
        for (const command of stage.commands) list.append(el('li', '', command));
        content.append(list);
      }
      if (stage.text) content.append(el('p', 'response-text', stage.text));
      if (stage.mocked) content.append(el('p', 'response-note', stage.note || 'Limited rule-based fallback. Add ANTHROPIC_API_KEY to use the LLM shown in the video.'));
      card.append(content);
      if (stage.durationMs !== undefined) card.append(el('div', 'stage-footer', `${stage.provider} · ${duration(stage.durationMs)}`));
    }
    fragment.append(card);
  }
  if (result.calls.length) {
    const log = el('details', 'service-log');
    log.append(el('summary', '', `${result.live ? 'Home Assistant' : 'Mock HA'} service calls (${result.calls.length})`), el('pre', '', JSON.stringify(result.calls, null, 2)));
    fragment.append(log);
  }
  const raw = el('details', 'service-log');
  raw.append(el('summary', '', 'Request details and raw API answers'), el('pre', '', JSON.stringify({ command: result.command, context: result.context, durationMs: result.durationMs, stages: result.stages }, null, 2)));
  fragment.append(raw);
  return fragment;
}
