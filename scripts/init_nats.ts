import nats from 'helpers/nats.ts'
import { RetentionPolicy } from '@nats-io/jetstream/internal'

await nats.connect()

const jsm = nats.jsm()

await jsm.streams.add({
  name: 'game',
  subjects: ['gs.*', 'states.*'],
  max_bytes: -1,
  retention: RetentionPolicy.Workqueue,
})

await nats.drain()

console.log('done')
