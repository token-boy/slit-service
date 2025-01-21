import { mClient } from 'models'
import { r } from 'helpers/redis.ts'
import nats from 'helpers/nats.ts'

mClient.connect().then(() => {
  mClient.db('slit').dropDatabase()
  console.log('mongo: db dropped')
})

r.connect().then(() => {
  r.flushdb()
  console.log('redis: db flushed')
})

nats.connect().then(() => {
  const jsm = nats.jsm()
  jsm.streams
    .list()
    .next()
    .then((streams) => {
      streams.forEach((stream) => {
        jsm.streams.delete(stream.config.name)
        console.log(`nats: stream ${stream.config.name} deleted`)
      })
    })
})

try {
  Deno.statSync('players.json')
  Deno.removeSync('./players.json')
  // deno-lint-ignore no-empty
} catch (_) {}
