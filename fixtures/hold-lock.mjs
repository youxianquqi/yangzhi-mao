// Holds a role lock in a separate process so tests can terminate its owner abruptly.
// No release is attempted in the fixture: the parent verifies dead-owner recovery.
import { createCharacterLock } from '../src/character-lock.js';

const [dataDir, id] = process.argv.slice(2);
const lock = await createCharacterLock(dataDir);
await lock.acquire(id);
process.on('message', () => {});
process.send('locked');
