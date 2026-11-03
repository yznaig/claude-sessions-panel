// Automatic dot colors: a color for the job a session does, read from the words in its name,
// its title and the role it took in the session hive. Rules are tried in order and the first that
// matches wins, so a topic (database) is listed before a generic job (builder). A keyword matches
// any word that starts with it ("ship" matches "shipping"). A color picked by right-click wins.
//
//   autoColor(rules, texts) -> '#rrggbb' or null
'use strict';

// The deep row of the panel's palette. Same list as the claudeSessions.autoColors default.
const DEFAULT_RULES = [
  { match: 'database|schema|db|migration', color: '#9546ce' },
  { match: 'ship|merge|deploy', color: '#46ce51' },
  { match: 'triage', color: '#ce8546' },
  { match: 'builder', color: '#ce4646' },
];
const COLOR = /^#[0-9a-f]{6}$/i;

function keywords(rule) {
  return rule && typeof rule.match === 'string' && COLOR.test(rule.color || '')
    ? rule.match.toLowerCase().split(/[|,\s]+/).filter(Boolean) : [];
}

function autoColor(rules, texts) {
  const words = texts.filter(Boolean).join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const rule of Array.isArray(rules) ? rules : DEFAULT_RULES) {
    const keys = keywords(rule);
    if (keys.some(k => words.some(w => w.startsWith(k)))) return rule.color.toLowerCase();
  }
  return null;
}

module.exports = { autoColor, DEFAULT_RULES };
