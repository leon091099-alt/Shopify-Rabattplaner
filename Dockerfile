FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_FILE=/data/on-tec.sqlite
EXPOSE 3000
CMD ["node", "src/server.js"]
