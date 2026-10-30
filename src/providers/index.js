import * as instagram from './instagram.js';

// Registry: provider name -> adapter. A second provider is one new module
// plus one line here.
const adapters = { instagram };

export function providerNames() {
  return Object.keys(adapters);
}

export function getProvider(name) {
  const adapter = adapters[name];
  if (!adapter) throw new Error(`Unknown provider "${name}".`);
  return adapter;
}
