import nats from 'helpers/nats.ts'

/**
 * Clears a specified JetStream stream by purging its messages and deleting all associated consumers.
 *
 * @param stream - The name of the stream to be cleared.
 */
export async function clearStream(stream: string) {
  const jsm = nats.jsm()
  jsm.streams.purge(stream)
  const consumers = await jsm.consumers.list(stream).next()
  consumers.forEach((consumer) => {
    jsm.consumers.delete(stream, consumer.name)
  })
}

if (import.meta.main) {
  await nats.connect()
  await clearStream(Deno.args[0])
  await nats.drain()
  console.log('down')
}
