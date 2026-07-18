import fs from 'fs';
import path from 'path';

export function createEventRecorder(dataDirectory) {
  const eventFile = path.join(dataDirectory, 'session-events.jsonl');
  let writeQueue = Promise.resolve();

  function record(event, data = {}) {
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`;
    writeQueue = writeQueue
      .then(async () => {
        await fs.promises.mkdir(dataDirectory, { recursive: true });
        await fs.promises.appendFile(eventFile, line, 'utf8');
      })
      .catch((error) => {
        console.error('[event-store] Failed to append event:', error);
      });
  }

  record.flush = () => writeQueue;
  record.eventFile = eventFile;
  return record;
}
