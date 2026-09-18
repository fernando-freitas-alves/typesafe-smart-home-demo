const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export function buildQuestions(devices) {
  const areas = Object.fromEntries([...new Set(devices.map(d => d.room))].map(r => [r, r.replaceAll('_', ' ')]));
  const targets = Object.fromEntries(devices.map(d => [d.id, `${d.name} in the ${d.room.replaceAll('_', ' ')}; ${d.kind}${d.id === 'bedroom_light' ? '; also called the kid’s light' : ''}`]));
  return {
    intent: choice("What is the user's intent?", {
      smarthome_command: 'A request to control or change devices, including indirect requests to make coffee, play music, or change the temperature.',
      information_request: 'A general request for information or conversation unrelated to smart home devices. The type of thing someone would search the internet for.',
      smarthome_query: 'A question about the current state of smart home devices, not a request to change them.',
    }),
    compound: { type: 'noul', instructions: 'Does this request contain multiple commands?', criteria: { true: 'Two or more distinct actions or targets that must be handled separately, including opposite actions in different rooms.', false: 'One action, even if it applies to all lights, a whole room, or the entire house. Introductory context is not a separate command.' } },
    scope: choice('What is the scope of the request?', { specific_device: 'One specific device', area: 'All matching devices in a particular room or area', whole_house: 'All matching devices across the whole house' }),
    device_type: choice('What kind of device is being targeted?', { light: 'Lights and lamps', fan: 'Fans', lock: 'Door locks', appliance: 'Coffee makers and other appliances', speaker: 'Speakers, music, and audio', thermostat: 'Heating and air conditioning' }),
    room: choice('Which room is the user referring to? Choose none_of_these if the requested room is absent, or if no room is specified.', { ...areas, none_of_these: 'No listed room matches; includes outside/outdoor areas which this home does not have' }),
    device: choice('Which specific device should receive the command? Choose none_of_these if there is no matching device, if the request refers to an absent room such as outside, or if it targets a group rather than a specific device.', { ...targets, none_of_these: 'No single listed device matches the requested device and location' }),
    light_action: choice('What should happen to the lights?', { turn_on: 'Turn on the lights', turn_off: 'Turn off the lights', dim: 'Dim or reduce the brightness of the lights' }),
    fan_action: choice('What should happen to the fans?', { turn_on: 'Turn on the fans', turn_off: 'Turn off the fans' }),
    lock_action: choice('What should happen to the locks?', { lock: 'Lock the doors', unlock: 'Unlock the doors' }),
    appliance_action: choice('What should happen to the appliances?', { turn_on: 'Turn on or start the appliance, including making coffee', turn_off: 'Turn off or stop the appliance' }),
    speaker_action: choice('What should happen to the speakers?', { turn_on: 'Turn on the speakers or start music', turn_off: 'Turn off the speakers or stop music' }),
    thermostat_action: choice('What should happen to the thermostats?', { ac_on: 'Turn on cooling or air conditioning', heat_on: 'Turn on heating', turn_off: 'Turn off heating and cooling' }),
  };
}

export function validateAnswers(answers, questions) {
  if (!answers || typeof answers !== 'object') throw new Error('TypeSafe returned no answers. Please retry.');
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
    if (!answer || answer.type !== question.type) throw new Error(`Invalid TypeSafe answer for ${id}. Please retry.`);
    if (question.type === 'noul') {
      if (!probability(answer.noul)) throw new Error(`Invalid TypeSafe probability for ${id}.`);
    } else {
      const values = Object.values(answer.probabilities ?? {});
      if (!Object.hasOwn(question.criteria, answer.choice) || !probability(answer.confidence) ||
        Object.keys(answer.probabilities ?? {}).length !== Object.keys(question.criteria).length ||
        Object.keys(question.criteria).some(option => !probability(answer.probabilities?.[option])) ||
        Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.06) throw new Error(`Invalid TypeSafe choices for ${id}. Please retry.`);
    }
  }
  return answers;
}
