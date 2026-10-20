import { requestBoard } from './vestaboard-api.js?v=1';

export function createBoardSession({ resource, accept, render, feedback, uncertainMessage, initialConnected = false }) {
  let connected = initialConnected;
  let busy = false;
  let requestVersion = 0;
  let polling = null;
  let started = false;

  function receive(data, command = false) {
    accept(data, { command });
    connected = true;
    render();
  }

  async function sync() {
    if (polling || busy) return;
    const request = { version: requestVersion };
    polling = request;
    try {
      const data = await requestBoard(resource);
      if (request.version === requestVersion) receive(data);
    } catch {
      if (request.version === requestVersion) {
        connected = false;
        render();
      }
    } finally {
      if (polling === request) polling = null;
    }
  }

  async function command(body) {
    if (busy || !connected) return;
    busy = true;
    requestVersion += 1;
    // An older poll cannot overwrite a command or block its reconciliation.
    polling = null;
    feedback('');
    render();
    try {
      receive(await requestBoard(resource, { body, timeoutMs: 12000 }), true);
    } catch (error) {
      feedback(error.uncertain ? uncertainMessage : error.message, true);
    } finally {
      busy = false;
      render();
      // Read current status after every command; never repeat an uncertain POST.
      void sync();
    }
  }

  function start() {
    if (started) return;
    started = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
    window.addEventListener('online', () => void sync());
    render();
    void sync();
    setInterval(() => { if (!document.hidden) void sync(); }, 5000);
  }

  return { get connected() { return connected; }, get busy() { return busy; }, sync, command, start };
}
