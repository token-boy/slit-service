docker stop nats
docker rm nats
docker run --detach \
  --name=nats \
  --mount=type=bind,source=/root/nats-server.conf,target=/nats-server.conf \
  --mount=type=bind,source=/var/lib/nats,target=/data \
  --network=main \
  --publish=4222:4222 \
  --label=traefik.enable=true \
  --label=traefik.http.routers.nats.rule=Host\(\`nats.mxsyx.site\`\) \
  --label=traefik.http.routers.nats.tls.certResolver=letsencrypt \
  --label=traefik.http.routers.nats.service=nats \
  --label=traefik.http.services.nats.loadbalancer.server.port=80 \
  --label=traefik.http.routers.nats-ui.rule=Host\(\`nats-ui.mxsyx.site\`\) \
  --label=traefik.http.routers.nats-ui.tls.certResolver=letsencrypt \
  --label=traefik.http.routers.nats-ui.service=nats-ui \
  --label=traefik.http.services.nats-ui.loadbalancer.server.port=8222 \
  nats:latest

nsc edit account -n Default --js-enable 1
nsc edit account -n Default \
  --js-tier 1 \
  --js-streams -1 \
  --js-consumer -1 \
  --js-max-ack-pending -1 \
  --js-max-mem-stream -1 \
  --js-max-disk-stream -1

nsc delete user -n player
nsc add user --name player
nsc edit user -n player --allow-pub "\$JS.API.CONSUMER.INFO.>" 
nsc edit user -n player --allow-pub "\$JS.API.CONSUMER.MSG.NEXT.>" 
nsc edit user -n player --allow-pub "\$JS.ACK.*>"
cat ~/.local/share/nats/nsc/keys/creds/memory/Default/player.creds

nsc add user --name dealer

nsc generate config --mem-resolver
