FROM node:12.20.1 as build
WORKDIR /tmp/gw
COPY package*.json ./
RUN npm install
COPY . ./
RUN npm run build && npm prune --production && rm -r src

FROM node:12.22-slim
WORKDIR /opt/gw
COPY --from=build /tmp/gw ./
USER node
ENTRYPOINT ["node", "--unhandled-rejections=strict"]
EXPOSE 8080
