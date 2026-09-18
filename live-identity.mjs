export const identities = [
  { id: 'fernando', name: 'Fernando' },
  { id: 'flavia', name: 'Flavia' },
  { id: 'other', name: 'Someone else' },
];

function roomWords(name) {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/['’]s\b/g, '').split(/[^a-z0-9]+/)
    .filter(word => word && !['de', 'do', 'da', 'of', 'the'].includes(word));
}

export function identityProfile(id = 'other', rooms = []) {
  const identity = identities.find(person => person.id === id);
  if (!identity) throw new Error('Choose Fernando, Flavia, or Someone else.');
  const matches = id === 'other' ? [] : rooms.filter(room => {
    const words = roomWords(room.name);
    return words.length === 2 && words.includes(id) && words.some(word => ['office', 'escritorio'].includes(word));
  });
  return { ...identity, office: matches.length === 1 ? matches[0] : null };
}

export function validatePersonalReferences(command, user, room = '') {
  if (/\bmy\s+office\b|\bmeu\s+escrit[oó]rio\b/i.test(command)) {
    if (!user.office) throw new Error(!user.name
      ? 'To use “my office”, choose Fernando or Flavia. Otherwise, name the room in your request.'
      : `Could not identify one office for ${user.name}. Name the room in your request.`);
    if (room && room !== user.office.id && !room.startsWith(`${user.office.id}__space_`)) throw new Error(`“My office” means ${user.office.name}. Select that room or All rooms, then preview again.`);
  }
  if (/\b(?:here|this room|aqui|neste c[oô]modo|nesse c[oô]modo)\b/i.test(command)) {
    if (!user.location) throw new Error('To use “here” or “this room”, select Where I am. Otherwise, name the room in your request.');
    if (room && room !== user.location.id) throw new Error(`“Here” means ${user.location.name}. Select that room or All rooms, then preview again.`);
  }
}
