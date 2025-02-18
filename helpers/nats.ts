import {
  connect,
  jwtAuthenticator,
  type NatsConnection,
} from '@nats-io/transport-deno'
import {
  type JetStreamClient,
  type JetStreamManager,
  jetstreamManager,
} from '@nats-io/jetstream'

import { TE } from "helpers/game.ts";

class Nats {
  #nc: NatsConnection
  #jsm: JetStreamManager
  #js: JetStreamClient

  async connect() {
    this.#nc = await connect({
      servers: Deno.env.get('NATS_SERVER'),
      authenticator: jwtAuthenticator(
        Deno.env.get('NATS_DEALER_JWT') as string,
        TE.encode(Deno.env.get('NATS_DEALER_NKEY'))
      ),
    })
    this.#jsm = await jetstreamManager(this.#nc)
    this.#js = this.#jsm.jetstream()
  }

  jsm() {
    return this.#jsm
  }

  js() {
    return this.#js
  }

  drain() {
    return this.#nc.drain()
  }
}

const nats = new Nats()

export default nats
