// import nats from 'helpers/nats.ts'
// import { AckPolicy, DeliverPolicy, RetentionPolicy } from '@nats-io/jetstream'

import { r, rSub } from 'helpers/redis.ts'

// await nats.connect()
// const jsm = nats.jsm()
// const js = nats.js()

// await jsm.streams.add({
//   name: 'states',
//   subjects: ['states.*'],
//   max_bytes: -1,
//   retention: RetentionPolicy.Limits,
// })

// await jsm.consumers.add('states', {
//   name: 'test1',
//   durable_name: 'test1',
//   filter_subject: 'states.*',
//   max_bytes: -1,
//   deliver_policy: DeliverPolicy.LastPerSubject
// })

// for (let i = 101; i < 200; i++) {
//   js.publish('states.xxx', i.toString())
// }

// const consumer =  await js.consumers.get('states', 'test1')
// const d = await consumer.consume()
// for await (const m of d) {
//   console.log(m.string())
// }
