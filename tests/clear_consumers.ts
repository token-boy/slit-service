import nats from 'helpers/nats.ts'

await nats.connect()

const jsm = nats.jsm()

async function clearConsumers(stream: string) {
  const consumers = await jsm.consumers.list(stream).next()
  consumers.forEach((consumer) => {
    jsm.consumers.delete(stream, consumer.name)
  })
}

await clearConsumers('state_e3aebea69f41453881a34c1f3227c718')

await nats.drain()

console.log('down')
