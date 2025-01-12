import nats from "helpers/nats.ts";

await nats.connect()
await nats.js().publish('455brqe0f4t', JSON.stringify({ hands: [0, 1] }))
await nats.drain()