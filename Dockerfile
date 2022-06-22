FROM node:16.15.1 as build
WORKDIR /tmp/gw
COPY package*.json ./
RUN npm install
COPY . ./
RUN npm run build && npm prune --production && rm -r src

FROM node:16.15.1-slim
WORKDIR /opt/gw
COPY --from=build /tmp/gw ./
USER node
ENTRYPOINT ["node", "--unhandled-rejections=strict", "--experimental-specifier-resolution=node"]
EXPOSE 8080
