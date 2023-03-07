FROM node:18.14.0 as build
WORKDIR /tmp/gw
COPY package*.json ./
RUN npm install
COPY . ./
RUN npm run build && npm prune --production && rm -r src

FROM node:18.14.0-slim
LABEL org.opencontainers.image.source="https://github.com/relaycorp/relaynet-internet-gateway"
WORKDIR /opt/gw
COPY --from=build /tmp/gw ./
USER node
ENTRYPOINT ["node", "--unhandled-rejections=strict"]
EXPOSE 8080
