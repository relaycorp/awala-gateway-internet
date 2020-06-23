FROM node:12.14.1 as build
WORKDIR /tmp/gw
COPY . ./
RUN npm install && npm run build && npm prune --production && rm -rf src/

FROM node:12.14.1-slim
WORKDIR /opt/gw
COPY --from=build /tmp/gw ./
RUN groupadd -r relaynet-gw && useradd -r -g relaynet-gw relaynet-gw
USER relaynet-gw
CMD ["build/main/bin/pohttp-server.js"]
ENTRYPOINT ["node"]
EXPOSE 8080
