import { r } from "helpers/redis.ts";


await r.hset('test', 'foo', 'bar')
await r.hset('test', 'oof', 'rab')

const all = await r.hmget('test', 'oof', 'xxx', 'foo')
console.log(all);
