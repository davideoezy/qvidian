FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install
COPY src ./src
ENV PORT=${PORT:-3020}
EXPOSE 3020
CMD ["node","/app/src/server.js"]
